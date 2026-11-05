import { app, BaseWindow, BrowserWindow, WebContentsView, session, Menu, ipcMain, shell, clipboard, screen, components, dialog } from 'electron';
import type { WebContents, Session, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { allowedPermission, isAllowedNavigation, isExternalLink, sanitizedHost, trustedLocalRequest, trustedRecommendationSettingsRequest } from './policy';
import { resolvePaths, prepareDirectories, writeJsonAtomic, visibleBounds, shouldRegisterInstallation, WindowBounds, AppPaths } from './paths';
import { installAuthColorScheme } from './auth-theme';
import { installWindowsAuthCompatibility } from './auth-passkeys';
import { historyBackScript, installMusicShell, isMusicPage } from './music-shell';
import { createWindowBar, fitWindowBar, musicWindowOptions } from './window-bar';
import { installLabelBrowser } from './record-labels';
import { installPlaylistLabels } from './playlist-labels';
import { installPlaylistTiming } from './playlist-timing';
import { installRendererCpuWatch } from './renderer-cpu';
import { installShufflePersistence } from './playback-prefs';
import { installRecordRecommendations } from './record-recommendations';
import { readLastFmKey, saveLastFmKey } from './recommendation-config';
import { artistColorScript, defaultArtistColor, readArtistColor, saveArtistColor } from './appearance';
import { validateLastFmKey } from './lastfm';
import { controlEndpoint, startControlServer } from './remote-control';
import type { ControlServer } from './remote-control';
import { installColumnPrefs } from './columns';
import { installPageLog, pageLogEnabledScript } from './page-log';
import { loadNewReleases } from './new-releases';
import { installSharedLinks } from './shared-links';
import { waitForWidevine } from './widevine';
import { isChromiumNetworkError, withNetworkRetries } from './network-retry';
import { firewallNoticeScript, installNetworkFailureLog } from './network-log';
import { defaultLogSettings, environmentLogSettings, logCategories, logCategoryLabels, readLogSettings, saveLogSettings, shouldLog } from './diagnostic';
import type { LogSettings } from './diagnostic';
import { Updater, updateBlockReason, updateSource, updateToastScript } from './updater';
import type { UpdateAnswer, UpdateBlock, UpdateMessage } from './updater';
import { displayVersion } from './app-version';

// La versión tal como la ve el usuario (X.YY); package.json la guarda como X.YY.0.
const appVersion = (): string => displayVersion(app.getVersion());

const argument = (name: string): string | undefined => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const qa = process.argv.includes('--qa');
const qaCase = argument('--qa-case') ?? 'about';
const qaOut = argument('--qa-out');
const lab = qa && qaCase === 'drm-lab';
const localQa = qa && !['apple', 'drm-lab'].includes(qaCase);
const repo = path.resolve(__dirname, '..');
const qaRoot = argument('--qa-root') ?? repo;
const musicUrl = lab ? 'https://castlabs.github.io/drm-test/' : 'https://music.apple.com/ar/new';
app.setName('El Music');
let paths: AppPaths;

let mainWindow: BaseWindow | undefined;
let localView: WebContentsView | undefined;
let musicView: WebContentsView | undefined;
let windowBar: WebContentsView | undefined;
let playback = 'Not validated';
let lastFailure = 'None';
let loading = false;
let shuttingDown = false;
let qaFinished = false;
const localPages = new Map<number, string>();
const ownedContents = new Set<WebContents>();
const popupWindows = new Set<BrowserWindow>();
const aboutWindows = new Set<BaseWindow>();
const recommendationSettingsWindows = new Map<number, BaseWindow>();
let preferencesFile: string;
let lastFmKey: string | undefined;
let lastFmSaving = false;
let recommendationConfigError = false;
let artistColor = defaultArtistColor;
let appearanceConfigError = false;
let refreshRecommendations: (() => void) | undefined;
let controlServer: ControlServer | undefined;
let updater: Updater | undefined;

// Log de diagnóstico en preferencias (diagnostic.log); al pasar 2 MB se rota a diagnostic.1.log, que se pisa.
// Categorías: los errores siempre; lo informativo según logging.json (Help › Diagnostic log) o ELMUSIC_LOG.
const logLimit = 2 * 1024 * 1024;
const logFile = (): string => path.join(paths.preferences, 'diagnostic.log');
let logSettings: LogSettings = { ...defaultLogSettings };
let logSettingsLocked = false;
function log(event: string, fields: Record<string, string | number | boolean> = {}): void {
  if (!shouldLog(event, logSettings)) return;
  try {
    try { if (fs.statSync(logFile()).size > logLimit) fs.renameSync(logFile(), path.join(paths.preferences, 'diagnostic.1.log')); }
    catch { /* Todavía no hay log. */ }
    fs.appendFileSync(logFile(), `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
  }
  catch { /* El diagnóstico no debe ocultar el error original. */ }
}
// Texto de un error para el log: sin URLs (pueden llevar datos de sesión en la query) y acotado.
function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/\b(?:https?|wss?|file):\/\/\S+/gi, '<url>').replace(/\s+/g, ' ').slice(0, 300);
}

function info(): Record<string, string> {
  const cdm = components?.status()[components.WIDEVINE_CDM_ID]?.version;
  return { name: app.getName(), version: appVersion(), electron: process.versions.electron ?? 'unknown',
    chromium: process.versions.chrome ?? 'unknown', platform: process.platform, architecture: process.arch,
    mode: qa ? 'Isolated QA' : app.isPackaged ? 'Installed' : 'Development', playback,
    widevine: typeof cdm === 'string' && /^[0-9.]+$/.test(cdm) ? cdm : 'Unknown',
    drmSignature: 'Not validated', lastFailure, profilePath: paths.heavy, preferencesPath: paths.preferences,
    lastFm: recommendationConfigError ? 'Configuration error' : lastFmKey ? 'Configured' : 'Not configured',
    artistColor, defaultArtistColor, appearance: appearanceConfigError ? 'Configuration error' : 'Ready' };
}

function trusted(event: IpcMainInvokeEvent, args: unknown[]): void {
  const expected = localPages.get(event.sender.id);
  if (!expected || !trustedLocalRequest(event.sender.id, event.senderFrame === event.sender.mainFrame,
    event.senderFrame?.url ?? '', event.sender.id, expected, args)) throw new Error('UNTRUSTED_LOCAL_REQUEST');
}

function registerIpc(): void {
  const settingsRequest = (event: IpcMainInvokeEvent, args: unknown[], action: 'set-key' | 'set-artist-color' | 'open-setup' | 'close'): void => {
    if (qa) throw new Error('QA_SETTINGS_ACTION_DISABLED');
    const expected = localPages.get(event.sender.id);
    if (!expected || !trustedRecommendationSettingsRequest(event.sender.id, event.senderFrame === event.sender.mainFrame,
      event.senderFrame?.url ?? '', event.sender.id, expected, args, action)) throw new Error('UNTRUSTED_SETTINGS_REQUEST');
  };
  ipcMain.handle('local:getAppInfo', (event, ...args: unknown[]) => { trusted(event, args); return info(); });
  ipcMain.handle('local:copyDiagnostics', (event, ...args: unknown[]) => {
    trusted(event, args);
    if (qa) throw new Error('QA_EXTERNAL_ACTION_DISABLED');
    clipboard.writeText(JSON.stringify(info(), null, 2));
  });
  ipcMain.handle('local:openDataDirectory', async (event, ...args: unknown[]) => {
    trusted(event, args);
    if (qa) throw new Error('QA_EXTERNAL_ACTION_DISABLED');
    const error = await shell.openPath(paths.heavy);
    if (error) throw new Error('DATA_FOLDER_OPEN_FAILED');
  });
  ipcMain.handle('local:setLastFmKey', async (event, ...args: unknown[]) => {
    settingsRequest(event, args, 'set-key');
    const window = recommendationSettingsWindows.get(event.sender.id);
    if (!window || window.isDestroyed()) throw new Error('UNTRUSTED_SETTINGS_REQUEST');
    if (lastFmSaving) return { saved: false, configured: !!lastFmKey, error: 'busy' };
    if (recommendationConfigError) return { saved: false, configured: false, error: 'save-uncertain' };
    lastFmSaving = true;
    const controller = new AbortController(), abort = (): void => controller.abort();
    window.once('closed', abort); event.sender.once('destroyed', abort);
    let writeStarted = false;
    try {
      const key = args[0] as string;
      if (key) await validateLastFmKey(key, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
      if (controller.signal.aborted || window.isDestroyed()) throw new Error('SETTINGS_CLOSED');
      settingsRequest(event, args, 'set-key');
      writeStarted = true;
      saveLastFmKey(paths.preferences, key);
      const persisted = readLastFmKey(paths.preferences);
      if (persisted !== (key || undefined)) throw new Error('SAVE_NOT_CONFIRMED');
      lastFmKey = persisted; recommendationConfigError = false;
      refreshRecommendations?.(); log('Configuración de recomendaciones guardada', { lastFmConfigured: !!lastFmKey });
      return { saved: true, configured: !!lastFmKey };
    } catch (error) {
      if (writeStarted) {
        // Un error tras rename no permite asegurar que la preferencia anterior siga en disco.
        try { lastFmKey = readLastFmKey(paths.preferences); recommendationConfigError = false; }
        catch { lastFmKey = undefined; recommendationConfigError = true; }
        refreshRecommendations?.();
      }
      return { saved: false, configured: !!lastFmKey, error: writeStarted ? 'save-uncertain' :
        error instanceof Error && error.message === 'LASTFM_KEY_REJECTED' ? 'invalid-key' : 'unavailable' };
    } finally {
      window.removeListener('closed', abort); event.sender.removeListener('destroyed', abort); lastFmSaving = false;
    }
  });
  ipcMain.handle('local:setArtistColor', async (event, ...args: unknown[]) => {
    settingsRequest(event, args, 'set-artist-color');
    if (appearanceConfigError) return { saved: false, color: artistColor, error: 'save-uncertain' };
    try {
      saveArtistColor(paths.preferences, args[0]);
      artistColor = readArtistColor(paths.preferences);
    } catch {
      try { artistColor = readArtistColor(paths.preferences); } catch { appearanceConfigError = true; }
      return { saved: false, color: artistColor, error: 'save-uncertain' };
    }
    const contents = musicView?.webContents;
    if (contents && !contents.isDestroyed() && isMusicPage(contents.getURL()))
      await contents.mainFrame.executeJavaScript(artistColorScript(artistColor)).catch(() => log('No se pudo aplicar el color de artista'));
    log('Color de artista guardado');
    return { saved: true, color: artistColor };
  });
  ipcMain.handle('local:closeRecommendationSettings', (event, ...args: unknown[]) => {
    settingsRequest(event, args, 'close');
    const window = recommendationSettingsWindows.get(event.sender.id);
    if (!window || window.isDestroyed()) throw new Error('UNTRUSTED_SETTINGS_REQUEST');
    window.close();
  });
  ipcMain.handle('local:openLastFmSetup', async (event, ...args: unknown[]) => {
    settingsRequest(event, args, 'open-setup');
    await shell.openExternal('https://www.last.fm/api/account/create');
  });
}

function own(contents: WebContents): void {
  if (ownedContents.has(contents)) return;
  ownedContents.add(contents);
  contents.once('destroyed', () => { ownedContents.delete(contents); localPages.delete(contents.id); });
  contents.on('will-attach-webview', event => event.preventDefault());
}

function configureSession(profile: Session): void {
  profile.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowedPermission(permission, details.requestingUrl, contents.getURL(), lab));
  });
  profile.setPermissionCheckHandler((contents, permission, origin, details) =>
    allowedPermission(permission, origin, details.embeddingOrigin ?? contents?.getURL() ?? '', lab) &&
    allowedPermission(permission, origin, contents?.getURL() ?? '', lab));
  profile.on('will-download', event => { event.preventDefault(); log('Descarga bloqueada'); });
  profile.setDevicePermissionHandler(() => false);
}

function secureRemote(contents: WebContents, profile: Session): void {
  own(contents);
  installAuthColorScheme(contents, () => log('No se pudo alinear el tema del formulario Apple'));
  const guard = (event: Electron.Event, url: string): void => {
    if (!isAllowedNavigation(url, lab)) {
      event.preventDefault(); log('Navegación bloqueada', { host: sanitizedHost(url) });
    }
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-frame-navigate', event => guard(event, event.url));
  contents.setWindowOpenHandler(details => {
    if (qa || !isAllowedNavigation(details.url, lab)) {
      log('Ventana bloqueada', { host: sanitizedHost(details.url) });
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: {
      parent: mainWindow, width: 620, height: 760, autoHideMenuBar: true,
      webPreferences: { session: profile, nodeIntegration: false, contextIsolation: true, sandbox: true,
        webSecurity: true, webviewTag: false, navigateOnDragDrop: false, safeDialogs: true }
    }, createWindow: options => {
      // Las guardas se instalan antes de iniciar la primera navegación del popup.
      const child = new BrowserWindow(options);
      if (child.webContents.session !== profile) { child.destroy(); throw new Error('AUTH_SESSION_MISMATCH'); }
      popupWindows.add(child);
      child.once('closed', () => popupWindows.delete(child));
      secureRemote(child.webContents, profile);
      child.setMenu(null);
      return child.webContents;
    } };
  });
  contents.on('context-menu', (_event, parameters) => {
    if (qa || !isExternalLink(parameters.linkURL)) return;
    const link = parameters.linkURL;
    Menu.buildFromTemplate([{ label: 'Open link in browser', click: () => {
      if (isExternalLink(link)) void shell.openExternal(link).catch(() => log('No se pudo abrir enlace externo'));
    } }]).popup();
  });
}

function newLocalView(): WebContentsView {
  const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'),
    backgroundThrottling: !qa,
    offscreen: localQa,
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
    navigateOnDragDrop: false } });
  own(view.webContents);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const block = (event: Electron.Event): void => event.preventDefault();
  view.webContents.on('will-navigate', block);
  view.webContents.on('will-redirect', block);
  view.webContents.on('will-frame-navigate', block);
  return view;
}

async function loadLocal(view: WebContentsView, state: string): Promise<void> {
  const file = path.join(__dirname, 'ui', 'index.html');
  const url = pathToFileURL(file);
  url.searchParams.set('state', state);
  localPages.set(view.webContents.id, url.href);
  await view.webContents.loadURL(url.href);
}

function fit(window: BaseWindow, view: WebContentsView): void {
  const [width, height] = window.getContentSize();
  view.setBounds({ x: 0, y: 0, width, height });
}

function showLocal(): void {
  if (!mainWindow || !localView || mainWindow.isDestroyed()) return;
  if (musicView) mainWindow.contentView.removeChildView(musicView);
  mainWindow.contentView.addChildView(localView);
  fit(mainWindow, localView);
  if (windowBar) fitWindowBar(mainWindow, windowBar);
}

async function openAbout(state = 'about'): Promise<void> {
  const existing = [...aboutWindows].find(window => window.getTitle() === (state === 'about' ? `About ${app.getName()}` : 'Settings'));
  if (existing) { existing.focus(); return; }
  const window = new BaseWindow({ width: 640, height: state === 'about' ? 640 : 780, minWidth: 560, minHeight: 580,
    title: state === 'about' ? `About ${app.getName()}` : 'Settings', parent: mainWindow, show: false });
  aboutWindows.add(window);
  const view = newLocalView();
  if (state === 'recommendation-settings') recommendationSettingsWindows.set(view.webContents.id, window);
  window.contentView.addChildView(view); fit(window, view);
  window.on('resize', () => fit(window, view));
  window.once('closed', () => { aboutWindows.delete(window); recommendationSettingsWindows.delete(view.webContents.id); if (!view.webContents.isDestroyed()) view.webContents.close(); });
  await loadLocal(view, state);
  if (!window.isDestroyed() && !qa) window.show();
}

function menus(): void {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') template.push({ label: app.getName(), submenu: [
    { label: `About ${app.getName()}`, click: () => void openAbout() },
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => void openAbout('recommendation-settings') }, { type: 'separator' }, { role: 'hide' },
    { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }
  ] });
  template.push({ label: process.platform === 'darwin' ? 'Music' : 'El Music', submenu: [
    { label: 'Settings…', ...(process.platform === 'darwin' ? {} : { accelerator: 'Ctrl+,' }),
      click: () => void openAbout('recommendation-settings') },
    { label: 'Install Stream Deck plugin…', click: () => void installStreamDeckPlugin() }, { type: 'separator' },
    { label: 'Check for Updates…', click: () => void updater?.check(true) },
    { label: 'Check for Updates Automatically', type: 'checkbox', checked: updater?.autoCheck ?? true, enabled: !!updater && !updater.blocked,
      click: item => updater?.setAutoCheck(item.checked) }, { type: 'separator' },
    { label: 'Retry loading', accelerator: 'CmdOrCtrl+R', click: () => void loadMusic() },
    { label: 'Back', accelerator: 'Alt+Left', click: () => void goBackInMusic() }, { type: 'separator' }, { role: 'close' }, { role: 'quit' }
  ] }, { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
    { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
    { type: 'separator' }, { role: 'togglefullscreen' }] },
  { label: 'Help', submenu: [{ label: `About ${app.getName()}`, click: () => void openAbout() },
    { label: 'What’s New', click: () => void updater?.whatsNew() },
    { label: 'Open Apple Music in browser', click: () => {
      if (!qa) void shell.openExternal('https://music.apple.com/').catch(() => log('No se pudo abrir Apple Music'));
    } },
    { label: 'Diagnostic log', submenu: [
      { label: 'Show diagnostic log', click: () => shell.showItemInFolder(logFile()) }, { type: 'separator' },
      { label: 'Errors are always logged. Verbose categories:', enabled: false },
      ...logCategories.map((category): MenuItemConstructorOptions => ({ label: logCategoryLabels[category], type: 'checkbox', checked: logSettings[category],
        enabled: !logSettingsLocked, click: item => setLogCategory(category, item.checked) }))] }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Cambio de una categoría desde el menú: se guarda en logging.json y, si es la de la página, se avisa al script inyectado.
function setLogCategory(category: typeof logCategories[number], enabled: boolean): void {
  const previous = logSettings;
  logSettings = { ...logSettings, [category]: enabled };
  try { saveLogSettings(paths.preferences, logSettings); log('Diagnóstico: categoría cambiada', { categoría: category, activa: enabled }); }
  catch { logSettings = previous; log('No se pudo guardar logging.json'); menus(); return; }
  const contents = musicView?.webContents;
  if (category === 'page' && contents && !contents.isDestroyed() && isMusicPage(contents.getURL()))
    void contents.mainFrame.executeJavaScript(pageLogEnabledScript(enabled)).catch(() => log('No se pudo avisar a la página el cambio de log'));
}

// Alt+Left: la página hace el Back con la línea de carga por adelantado (como antes, no cierra Related ni marca la
// intención de retorno del botón); si no puede, el historial del navegador.
async function goBackInMusic(): Promise<void> {
  const contents = musicView?.webContents;
  if (!contents || contents.isDestroyed()) return;
  const handled = isMusicPage(contents.getURL()) && await contents.mainFrame.executeJavaScript(historyBackScript).catch(() => false) === true;
  if (!handled && !contents.isDestroyed() && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
}
// El paquete viaja dentro del ASAR; se copia a una ruta temporal fija para que lo instale Stream Deck mismo.
async function installStreamDeckPlugin(): Promise<void> {
  if (qa) return;
  const name = 'com.lga.elmusic.streamDeckPlugin';
  const target = path.join(app.getPath('temp'), 'ElMusic', name);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(path.join(__dirname, 'streamdeck', name)));
  } catch { log('No se pudo preparar el plugin Stream Deck'); return; }
  const failure = await shell.openPath(target);
  if (failure) {
    log('Stream Deck no abrió el plugin');
    if (mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['OK'],
      message: 'Stream Deck could not open the plugin.', detail: 'Install the Elgato Stream Deck app and try again.' });
  }
}

function startStreamDeckControl(): void {
  if (qa) return;
  let username = 'user';
  try { username = os.userInfo().username; } catch { /* Nombre neutro compartido con el plugin. */ }
  controlServer = startControlServer(controlEndpoint(process.platform, username, app.getPath('home')), script => {
    const contents = musicView?.webContents;
    if (!contents || contents.isDestroyed() || loading || shuttingDown || !isMusicPage(contents.getURL())) return;
    return contents.mainFrame.executeJavaScript(script, true);
  }, appVersion(), log, toggleMainWindow);
}

// Tecla Stream Deck «Open / Minimize»: al frente si no lo está; si ya lo está, minimizar.
function toggleMainWindow(): 'shown' | 'minimized' | undefined {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isVisible() && !window.isMinimized() && window.isFocused()) { window.minimize(); return 'minimized'; }
  if (window.isMinimized()) window.restore();
  window.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  // Windows sólo cede el primer plano a quien recibió la última entrada: «siempre arriba» un instante la deja delante igual.
  window.setAlwaysOnTop(true);
  window.focus();
  window.setAlwaysOnTop(false);
  setTimeout(() => { if (!window.isDestroyed() && !window.isFocused()) log('Stream Deck: la ventana quedó al frente sin foco'); }, 300);
  return 'shown';
}

async function loadMusic(): Promise<void> {
  if (loading || shuttingDown || !mainWindow || !localView) return;
  loading = true;
  let stage = 'LOCAL_UI';
  showLocal();
  try {
    await loadLocal(localView, 'loading');
    stage = 'WIDEVINE';
    if (!components) throw new Error('ECS_COMPONENTS_UNAVAILABLE');
    const ecs = components;
    await waitForWidevine({ whenReady: () => ecs.whenReady([ecs.WIDEVINE_CDM_ID]),
      stopped: () => shuttingDown || !mainWindow || mainWindow.isDestroyed(),
      onRetry: attempt => log('Widevine: reintento', { intento: attempt }) });
    if (shuttingDown || mainWindow.isDestroyed()) return;
    playback = 'Widevine ready; playback not validated';
    stage = 'MUSIC_PAGE';
    const profile = session.fromPartition('persist:apple-music');
    if (!musicView) {
      configureSession(profile);
      musicView = new WebContentsView({ webPreferences: { session: profile, nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
        navigateOnDragDrop: false, safeDialogs: true } });
      // Documento vacío propio antes de las guardas: CDP necesita un target listo, sin cargar Apple todavía.
      own(musicView.webContents);
      stage = 'AUTH_COMPATIBILITY';
      await musicView.webContents.loadURL('about:blank');
      secureRemote(musicView.webContents, profile);
      if (!lab) {
        const contents = musicView.webContents;
        await installWindowsAuthCompatibility(contents, () => {
          if (shuttingDown || contents.isDestroyed()) return;
          lastFailure = 'AUTH_COMPATIBILITY_FAILED';
          log('Falló compatibilidad del acceso integrado Apple');
          showLocal();
          contents.close(); musicView = undefined; refreshRecommendations = undefined;
          if (localView) void loadLocal(localView, 'error').catch(() => log('Error local no disponible'));
        });
      }
      stage = 'MUSIC_PAGE';
      if (!lab) {
        const columnPrefs = installColumnPrefs(musicView.webContents, paths.preferences, log);
        installMusicShell(musicView.webContents, () => log('No se pudo preparar la barra musical'), process.platform, () => artistColor,
          () => columnPrefs.current(), () => logSettings.page);
        installPageLog(musicView.webContents, log);
        const playlistLabels = installPlaylistLabels(musicView.webContents, () => log('No se pudo actualizar la columna de sellos'), log,
          path.join(paths.heavy, 'label-cache.json'));
        const releasesCache = path.join(paths.heavy, 'new-releases.json');
        installLabelBrowser(musicView.webContents, () => log('No se pudo mostrar la música del sello'), log, name => playlistLabels.albumsOfLabel(name),
          (country, signal, hooks) => loadNewReleases(musicView!.webContents, country, { cacheFile: releasesCache, signal, log, ...hooks }));
        installPlaylistTiming(musicView.webContents, log);
        installRendererCpuWatch(musicView.webContents, () => app.getAppMetrics(), log);
        installShufflePersistence(musicView.webContents, paths.preferences, log);
        refreshRecommendations = installRecordRecommendations(musicView.webContents, () => lastFmKey,
          () => log('No se pudieron actualizar las recomendaciones'), log);
        installSharedLinks(musicView.webContents, log, () => log('No se pudo abrir el enlace pegado'));
        const noticeContents = musicView.webContents;
        installNetworkFailureLog(noticeContents.session, log, { onFirewallBlock: () => {
          if (!noticeContents.isDestroyed()) void noticeContents.mainFrame.executeJavaScript(firewallNoticeScript()).catch(() => {});
        } });
      }
      musicView.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
        if (!mainFrame || code === -3 || loading || shuttingDown) return;
        playback = 'Music page load failed'; lastFailure = 'MUSIC_PAGE_FAILED';
        log('Falló navegación musical', { código: code });
        showLocal();
        if (localView) void loadLocal(localView, 'error').catch(() => log('Error local no disponible'));
      });
      musicView.webContents.on('unresponsive', () => log('Página musical sin responder'));
      musicView.webContents.on('responsive', () => log('Página musical responde otra vez'));
      musicView.webContents.on('render-process-gone', (_event, details) => {
        log('Página musical: proceso terminado', { motivo: details.reason, código: details.exitCode });
        playback = 'Renderer stopped'; showLocal();
        if (localView && !shuttingDown) void loadLocal(localView, 'error').catch(() => log('Error local no disponible'));
      });
    }
    const musicContents = musicView.webContents;
    await withNetworkRetries(() => musicContents.loadURL(musicUrl), isChromiumNetworkError,
      { stopped: () => shuttingDown || !mainWindow || mainWindow.isDestroyed(), onRetry: attempt => log('Página musical: reintento', { intento: attempt }) });
    if (shuttingDown || mainWindow.isDestroyed()) return;
    mainWindow.contentView.removeChildView(localView);
    mainWindow.contentView.addChildView(musicView); fit(mainWindow, musicView);
    if (windowBar) fitWindowBar(mainWindow, windowBar);
    musicView.webContents.focus();
    lastFailure = 'None';
    log('Página musical cargada', { laboratorio: lab });
    if (qa) await captureQa(musicView.webContents);
  } catch (error) {
    if (stage === 'AUTH_COMPATIBILITY' && musicView) {
      musicView.webContents.close(); musicView = undefined; refreshRecommendations = undefined;
    }
    playback = 'Secure playback or page load failed';
    lastFailure = `${stage}_FAILED`;
    if (error instanceof Error && ['ECS_COMPONENTS_UNAVAILABLE', 'WIDEVINE_TIMEOUT'].includes(error.message)) lastFailure = error.message;
    log('Falló carga de reproducción segura', { etapa: stage, código: lastFailure });
    showLocal();
    if (localView && !localView.webContents.isDestroyed()) await loadLocal(localView, 'error').catch(() => log('Error local no disponible'));
    if (qa) await finishQa(false, { error: lastFailure });
  } finally { loading = false; }
}

function destroyOwned(): void {
  shuttingDown = true;
  controlServer?.close(); controlServer = undefined;
  for (const child of popupWindows) if (!child.isDestroyed()) child.destroy();
  for (const window of aboutWindows) if (!window.isDestroyed()) window.destroy();
  for (const contents of [...ownedContents]) if (!contents.isDestroyed()) contents.close();
}

async function finishQa(success: boolean, result: Record<string, unknown>): Promise<void> {
  if (qaFinished || !qaOut) return;
  qaFinished = true;
  writeJsonAtomic(path.join(qaOut, 'qa-result.json'), { success, case: qaCase, pid: process.pid, version: appVersion(),
    runtime: process.versions.electron, chromium: process.versions.chrome, ...result,
    playbackVerified: false, accountWrites: false, appName: app.getName(), nativeWindowTitle: mainWindow?.getTitle(), timestamp: new Date().toISOString() });
  destroyOwned();
  app.exit(success ? 0 : 1);
}

async function captureQa(contents: WebContents): Promise<void> {
  if (!qaOut) return;
  const deadline = Date.now() + 30000;
  let presentation: Record<string, unknown> = {};
  do {
    presentation = await qaStep('DOM_PRESENTATION_TIMEOUT', contents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      const imgs = [...document.images].filter(i => { const r=i.getBoundingClientRect();
        return r.width>0 && r.height>0 && r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth && i.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}); });
      return {ready:document.readyState==='complete', localReady:document.body.dataset.ready,
        text:document.body.innerText.trim().length, images:imgs.length,
        imagesReady:imgs.every(i=>i.complete && i.naturalWidth>0), font:getComputedStyle(document.body).fontFamily,
        heading:document.querySelector('h1')?.textContent, width:innerWidth,height:innerHeight}; })()`));
    if (presentation.ready && presentation.text && presentation.imagesReady && (!localQa || presentation.localReady === 'true')) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  if (!presentation.ready || !presentation.text || !presentation.imagesReady || (localQa && presentation.localReady !== 'true')) {
    await finishQa(false, { error: 'PRESENTATION_NOT_READY', presentation }); return;
  }
  // capturePage solicita composición aunque la ventana QA permanezca oculta.
  // RAF se pausa en ventanas ocultas y no sirve como guarda de presentación.
  const image = await qaStep('CAPTURE_TIMEOUT', contents.capturePage(undefined, { stayHidden: true, stayAwake: true }));
  let fonts: unknown;
  const attachedForCapture = !contents.debugger.isAttached();
  try {
    if (attachedForCapture) contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('DOM.enable');
    await contents.debugger.sendCommand('CSS.enable');
    await contents.debugger.sendCommand('DOM.getDocument');
    const sample = await contents.debugger.sendCommand('Runtime.evaluate', { expression: `([...document.querySelectorAll('h1,h2,p,span,a')].find(e=>e.childNodes.length && [...e.childNodes].some(n=>n.nodeType===3 && n.textContent.trim()) && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) || document.body)`, returnByValue: false });
    const node = await contents.debugger.sendCommand('DOM.requestNode', { objectId: sample.result.objectId });
    fonts = (await contents.debugger.sendCommand('CSS.getPlatformFontsForNode', { nodeId: node.nodeId })).fonts;
    if (!Array.isArray(fonts) || !fonts.some(font => font.glyphCount > 0)) throw new Error('FONT_EVIDENCE_MISSING');
  } catch {
    await finishQa(false, { error: 'FONT_EVIDENCE_MISSING', presentation }); return;
  } finally { if (attachedForCapture && contents.debugger.isAttached()) contents.debugger.detach(); }
  if (image.isEmpty() || image.getSize().width < 1 || image.getSize().height < 1) {
    await finishQa(false, { error: 'EMPTY_RENDER_CAPTURE', presentation }); return;
  }
  fs.writeFileSync(path.join(qaOut, 'qa.png'), image.toPNG());
  const renderer = localQa ? await contents.executeJavaScript(`(async () => {
    const info = await window.elMusic.getAppInfo();
    return { sandboxed: info.rendererSandboxed, contextIsolated: info.rendererContextIsolated,
      nodeAvailable: typeof require !== 'undefined' || typeof process !== 'undefined' };
  })()`) : undefined;
  const result: Record<string, unknown> = { presentation, fonts, imageSize: image.getSize(),
    renderer };
  if (qaCase === 'local-smoke') {
    result.ipc = await contents.executeJavaScript(`(async()=>{
      const info=await window.elMusic.getAppInfo();
      let externalDenied=false;
      let argumentsDenied=false;
      try { await window.elMusic.openDataDirectory(); } catch { externalDenied=true; }
      try { await window.elMusic.getAppInfo('unexpected'); } catch { argumentsDenied=true; }
      return {version:info.version,externalDenied,argumentsDenied,bridgeMethods:Object.keys(window.elMusic)};
    })()`);
    const hostile = newLocalView();
    await hostile.webContents.loadURL('data:text/html,<html><body><h1>Isolated hostile fixture</h1></body></html>');
    result.hostileIpcDenied = await hostile.webContents.executeJavaScript(`window.elMusic.getAppInfo().then(()=>false,()=>true)`);
    result.subframeHasBridge = await hostile.webContents.executeJavaScript(`new Promise(resolve=>{
      addEventListener('message',e=>resolve(e.data),{once:true});
      const frame=document.createElement('iframe');
      frame.sandbox='allow-scripts';
      frame.srcdoc='<script>parent.postMessage(typeof window.elMusic,"*")<\\/script>';
      document.body.append(frame);
    })`);
    hostile.webContents.close();
    const remote = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    own(remote.webContents);
    await remote.webContents.loadURL('data:text/html,<html><body>Unprivileged remote fixture</body></html>');
    result.remoteHasBridge = await remote.webContents.executeJavaScript('typeof window.elMusic');
    remote.webContents.close();
    const ipc = result.ipc as { externalDenied: boolean; argumentsDenied: boolean };
    if (!ipc.externalDenied || !ipc.argumentsDenied || result.hostileIpcDenied !== true ||
      result.subframeHasBridge !== 'undefined' || result.remoteHasBridge !== 'undefined') {
      await finishQa(false, { ...result, error: 'IPC_ISOLATION_FAILED' }); return;
    }
  }
  await finishQa(true, result);
}

async function qaStep<T>(name: string, operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(name)), 10000);
    })]);
  } catch (error) {
    await finishQa(false, { error: name,
      ...(localQa ? { cause: error instanceof Error ? error.message : 'UNKNOWN_LOCAL_QA_ERROR' } : {}) });
    throw new Error(name);
  } finally { if (timeout) clearTimeout(timeout); }
}

// Actualizaciones (Windows, instalación hecha con el instalador): diálogos nativos, progreso en la barra de tareas y un
// aviso abajo a la derecha de la página mientras baja el instalador.
const updateMessages: Record<UpdateMessage, [string, string]> = {
  'up-to-date': ['You’re up to date', 'This is the newest version of El Music.'],
  'check-failed': ['Couldn’t check for updates', 'Check your internet connection and try again. If your firewall asks about El Music, allow it.'],
  'download-failed': ['The update couldn’t be downloaded', 'Check your internet connection and try again with El Music › Check for Updates…'],
  'install-failed': ['The installer couldn’t be opened', 'Download the installer from the El Music page and run it. Your session and settings stay.'],
  blocked: ['This copy of El Music can’t update itself', ''],
  busy: ['El Music is already checking for updates', 'It will tell you when it finishes.'],
  'notes-unavailable': ['What’s New isn’t available right now', 'Check your internet connection and try again.'],
};
const blockedDetail: Record<UpdateBlock, string> = {
  platform: 'Automatic updates are coming to the Mac version. Until then, download new versions from the El Music page.',
  development: 'Updates are off in development builds.', qa: 'Updates are off while testing.',
  staging: 'It wasn’t installed with the El Music installer. Download the installer from the El Music page to get automatic updates.',
  'not-installed': 'It wasn’t installed with the El Music installer. Download the installer from the El Music page to get automatic updates.',
};
const megabytes = (bytes: number): string => (bytes / 1048576).toFixed(0);
function createUpdater(): Updater {
  const installDir = path.dirname(process.execPath);
  return new Updater({ version: appVersion(), preferences: paths.preferences, downloads: path.join(paths.heavy, 'updates'), installDir,
    platform: process.platform === 'darwin' ? 'mac' : 'win', blocked: updateBlockReason({ platform: process.platform, packaged: app.isPackaged, qa, installDir }),
    log,
    ask: async (offer, notes): Promise<UpdateAnswer> => {
      if (!mainWindow || mainWindow.isDestroyed()) return 'cancel';
      const { response } = await dialog.showMessageBox(mainWindow, { type: 'info', title: 'Update Available', noLink: true,
        message: `El Music ${offer.version} is available`,
        detail: `You have version ${appVersion()}. El Music will close, update itself in the same folder and open again. Your session and settings stay.${notes ? `\n\n${notes}` : ''}`,
        buttons: ['Update Now', 'Remind Me Later', 'Skip This Version', 'Cancel'], defaultId: 3, cancelId: 3 });
      return (['update', 'later', 'skip', 'cancel'] as const)[response] ?? 'cancel';
    },
    tell: async (message, detail): Promise<void> => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const [title, text] = updateMessages[message];
      const block = message === 'blocked' ? blockedDetail[detail as UpdateBlock] ?? '' : '';
      const offerPage = message === 'install-failed' || (message === 'blocked' && detail !== 'development' && detail !== 'qa');
      const { response } = await dialog.showMessageBox(mainWindow, { type: message === 'up-to-date' || message === 'busy' ? 'info' : 'warning',
        title: 'El Music Updates', message: title, detail: block || text, noLink: true, buttons: offerPage ? ['Open Download Page', 'OK'] : ['OK'],
        defaultId: 0, cancelId: offerPage ? 1 : 0 });
      if (offerPage && response === 0 && !qa) void shell.openExternal(updateSource.page).catch(() => log('No se pudo abrir la página de descargas'));
    },
    progress: (state): void => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(state === null ? -1 : 'received' in state ? state.received / state.total : 2);
      const contents = musicView?.webContents;
      if (!contents || contents.isDestroyed() || !isMusicPage(contents.getURL())) return;
      const toast = state === null ? null : 'received' in state
        ? { text: `Downloading El Music ${state.version}… ${Math.floor(state.received * 100 / state.total)}%`,
          detail: `${megabytes(state.received)} of ${megabytes(state.total)} MB · keep listening, it installs when it finishes`, working: true }
        : { text: `Opening the El Music ${state.version} installer…`, detail: 'El Music closes now and opens again when the update is installed.', working: true };
      void contents.mainFrame.executeJavaScript(updateToastScript(toast)).catch(() => {});
    },
    // La app se cierra sólo si el script arrancó: si el sistema lo bloquea (antivirus, política), queda abierta y avisa.
    launch: async (setup, helper, logFile, sha256): Promise<boolean> => {
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (!fs.existsSync(powershell)) return false;
      const started = await new Promise<boolean>(resolve => {
        try {
          const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper,
            '-InstallerPath', setup, '-AppDir', installDir, '-LogPath', logFile, '-Sha256', sha256], { detached: true, stdio: 'ignore', windowsHide: true });
          child.once('spawn', () => { child.unref(); resolve(true); });
          child.once('error', () => { log('No se pudo ejecutar el script de actualización'); resolve(false); });
        } catch { resolve(false); }
      });
      if (!started) return false;
      log('Actualizaciones: se cierra la app para instalar');
      setTimeout(() => app.quit(), 800);
      return true;
    },
    whatsNew: async (title, text): Promise<void> => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      await dialog.showMessageBox(mainWindow, { type: 'info', title: 'What’s New', message: title, detail: text, buttons: ['OK'], noLink: true });
    },
  });
}

async function start(): Promise<void> {
  if (localQa && components) components.updatesEnabled = false;
  configureSession(session.defaultSession);
  if (!qa) {
    const forced = environmentLogSettings(process.env.ELMUSIC_LOG);
    if (forced) { logSettings = forced; logSettingsLocked = true; log('Diagnóstico: categorías fijadas por ELMUSIC_LOG', { valor: process.env.ELMUSIC_LOG ?? '' }); }
    else {
      try { logSettings = readLogSettings(paths.preferences); }
      catch { logSettingsLocked = true; log('No se pudo leer logging.json; quedan todas las categorías activas'); }
    }
    try { lastFmKey = readLastFmKey(paths.preferences); }
    catch { recommendationConfigError = true; log('No se pudo leer configuración de recomendaciones'); }
    try { artistColor = readArtistColor(paths.preferences); }
    catch { appearanceConfigError = true; log('No se pudo leer configuración de apariencia'); }
  }
  if (localQa && qaCase === 'recommendation-settings' && process.argv.includes('--qa-settings-configured')) lastFmKey = 'a'.repeat(32);
  registerIpc();
  let saved: WindowBounds | undefined;
  if (!qa) {
    try { saved = JSON.parse(fs.readFileSync(preferencesFile, 'utf8')) as WindowBounds; } catch { /* El primer arranque no tiene geometría. */ }
  }
  const bounds = qa ? { width: 1280, height: 840 } : visibleBounds(saved, screen.getAllDisplays().map(display => display.workArea));
  mainWindow = new BaseWindow({ ...bounds, minWidth: 900, minHeight: 600, title: app.getName(), show: false,
    backgroundColor: '#202020', ...musicWindowOptions() });
  localView = newLocalView();
  mainWindow.contentView.addChildView(localView); fit(mainWindow, localView);
  mainWindow.on('resize', () => {
    if (mainWindow && localView) fit(mainWindow, localView);
    if (mainWindow && musicView) fit(mainWindow, musicView);
    if (mainWindow && windowBar) fitWindowBar(mainWindow, windowBar);
  });
  mainWindow.on('close', () => {
    if (!qa && mainWindow && !mainWindow.isDestroyed()) {
      try { writeJsonAtomic(preferencesFile, mainWindow.getNormalBounds()); } catch { log('No se pudo guardar geometría'); }
    }
    destroyOwned();
  });
  mainWindow.once('closed', () => { mainWindow = undefined; app.quit(); });
  updater = createUpdater();
  menus();
  startStreamDeckControl();
  mainWindow.setMenuBarVisibility(false);
  windowBar = await createWindowBar(mainWindow, () => {
    if (mainWindow && !mainWindow.isDestroyed()) Menu.getApplicationMenu()?.popup({ window: mainWindow,
      x: process.platform === 'darwin' ? 90 : 12, y: 48, callback: () => {
        if (mainWindow?.isDestroyed() !== false || !mainWindow.isFocused() || !mainWindow.isVisible()) return;
        const view = musicView && mainWindow.contentView.children.includes(musicView) ? musicView : localView;
        if (view && !view.webContents.isDestroyed()) view.webContents.focus();
      } });
  }, localQa);
  own(windowBar.webContents); fitWindowBar(mainWindow, windowBar);
  const installPath = process.platform === 'darwin' ? path.resolve(process.execPath, '..', '..', '..') : path.dirname(process.execPath);
  // La tecla Open / Minimize del plugin abre la app desde esta ruta cuando no está corriendo.
  if (app.isPackaged && !qa) {
    try { writeJsonAtomic(path.join(paths.preferences, 'launch.json'), { executable: process.execPath }); } catch { log('No se pudo guardar la ruta de inicio para Stream Deck'); }
  }
  if (shouldRegisterInstallation(app.isPackaged, qa, installPath, process.resourcesPath)) {
    try { writeJsonAtomic(paths.registry, { name: 'ElMusic', version: appVersion(), installPath,
      executable: process.execPath, updatedAt: new Date().toISOString() }); } catch { log('No se pudo registrar instalación LGA'); }
  }
  if (localQa) {
    if (!['about', 'loading', 'error', 'local-smoke', 'recommendation-settings'].includes(qaCase)) { await finishQa(false, { error: 'UNKNOWN_QA_CASE' }); return; }
    let captureContents = localView.webContents;
    let captureWindow = mainWindow;
    if (qaCase === 'recommendation-settings') {
      await openAbout('recommendation-settings');
      const [id, window] = [...recommendationSettingsWindows.entries()][0];
      captureWindow = window;
      captureContents = [...ownedContents].find(contents => contents.id === id)!;
    } else await loadLocal(localView, qaCase === 'local-smoke' ? 'about' : qaCase);
    if (process.platform === 'win32') {
      // No basta una variable heredada: consultar el escritorio real del proceso.
      const powershell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // La sonda vive en el repo de herramientas de QA, junto al checkout que se prueba.
      const probe = path.join(path.dirname(qaRoot), 'LGA_Base_QT_C_Py', 'tools', 'qa', 'run_headless.ps1');
      const desktop = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe, '-WhereAmI'],
        { windowsHide: true, timeout: 10000, encoding: 'utf8' });
      if (desktop.error || desktop.status !== 10) {
        await finishQa(false, { error: 'PRIVATE_QA_DESKTOP_REQUIRED' }); return;
      }
      captureWindow.showInactive();
    }
    await captureQa(captureContents);
  } else {
    await loadLocal(localView, 'loading');
    if (!qa) {
      mainWindow.show();
      updater.start();
      setTimeout(() => void updater?.afterStart().catch(() => log('No se pudieron mostrar las novedades')), 3000);
    }
    await loadMusic();
  }
}

try {
  if (qa && !qaOut) throw new Error('QA_OUTPUT_REQUIRED');
  if (qa && app.isPackaged) {
    if (!argument('--qa-root') || !path.isAbsolute(qaRoot) || !fs.existsSync(path.join(qaRoot, '.git'))) throw new Error('QA_CHECKOUT_REQUIRED');
    const manifest = JSON.parse(fs.readFileSync(path.join(qaRoot, 'package.json'), 'utf8')) as { name: string };
    if (manifest.name !== 'lga-el-music') throw new Error('QA_CHECKOUT_REQUIRED');
  }
  paths = resolvePaths({ platform: process.platform, packaged: app.isPackaged,
    executable: process.execPath, appData: app.getPath('appData'), repo: qa ? qaRoot : repo, qaOut: qa ? qaOut : undefined });
  preferencesFile = path.join(paths.preferences, 'window.json');
  prepareDirectories(paths, qa ? qaOut : undefined, qaRoot);
  app.setPath('userData', paths.heavy);
  app.setPath('sessionData', paths.heavy);
  app.setPath('crashDumps', paths.crashDumps);
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on('second-instance', () => {
      if (!qa && mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    });
    log('Inicio', { versión: appVersion(), electron: process.versions.electron ?? 'unknown', modo: qa ? 'QA' : app.isPackaged ? 'Instalada' : 'Desarrollo' });
    process.on('uncaughtExceptionMonitor', error => log('Error no capturado en main', { error: errorText(error) }));
    // Con este listener una promesa rechazada sin manejar queda en el log en vez de terminar en el diálogo de error.
    process.on('unhandledRejection', reason => log('Promesa rechazada sin manejar en main', { error: errorText(reason) }));
    app.on('child-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') log('Proceso auxiliar terminado', { tipo: details.type, motivo: details.reason, código: details.exitCode });
    });
    app.on('before-quit', () => { updater?.stop(); destroyOwned(); });
    app.on('window-all-closed', () => app.quit());
    app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
    app.whenReady().then(start).catch(async () => {
      log('Falló inicialización');
      if (qa) await finishQa(false, { error: 'INITIALIZATION_FAILED' });
      else {
        dialog.showErrorBox(app.getName(), 'The application could not start. Check that all application files are present and that the data folder is writable.');
        destroyOwned(); app.exit(1);
      }
    });
  }
} catch {
  // Cambiar de perfil como fallback podría mezclar sesiones o aparentar pérdida de datos.
  process.stderr.write(`${app.getName()}: no se pudo preparar la carpeta de datos. Verifique permisos y rutas.\n`);
  if (!qa) dialog.showErrorBox(app.getName(), 'The data folder is not writable. Move the app to a writable folder and try again.');
  app.exit(1);
}
