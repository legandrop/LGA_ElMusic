'use strict';
// Plugin Stream Deck de El Music: traduce teclas a acciones cerradas del canal local de la app.
const { LocalWebSocket } = require('./websocket');
const { ControlClient } = require('./control-client');
const { launchApp } = require('./launcher');

const actions = {
  previous: 'com.lga.elmusic.previous',
  playPause: 'com.lga.elmusic.playpause',
  next: 'com.lga.elmusic.next',
  addToPlaylist: 'com.lga.elmusic.addtoplaylist',
  window: 'com.lga.elmusic.window'
};
const playlistPattern = /^p\.[A-Za-z0-9]{1,64}$/;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function start({ port, uuid, registerEvent, endpoint, launch = launchApp, onClose = () => process.exit(0) }) {
  if (!uuid || !registerEvent) { process.exitCode = 1; return; }
  const socket = new LocalWebSocket(port);
  const client = new ControlClient(endpoint);
  const contexts = new Map();
  const flashes = new Map();
  let polling;
  let polled = false;
  let launchedAt = 0;

  const send = message => socket.send(JSON.stringify(message));
  const log = message => send({ event: 'logMessage', payload: { message: `El Music: ${message}` } });
  const alert = context => send({ event: 'showAlert', context });
  const ok = context => send({ event: 'showOk', context });
  const setState = (context, playing) => send({ event: 'setState', context, payload: { state: playing ? 1 : 0 } });
  const playlistTitle = settings => typeof settings?.playlistName === 'string' ? settings.playlistName.slice(0, 40) : '';
  const setTitle = (context, title) => send({ event: 'setTitle', context, payload: { title, target: 0 } });
  // Sin image, Stream Deck vuelve al dibujo del manifest.
  const setImage = (context, image) => send({ event: 'setImage', context, payload: image ? { image, target: 0 } : { target: 0 } });
  // La imagen con el nombre la dibuja el inspector (ui/playlist.html) y queda en la configuración de la tecla.
  const keyImage = settings => typeof settings?.image === 'string' && settings.image.length <= 262144 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(settings.image) ? settings.image : undefined;
  const showPlaylist = (context, settings) => {
    const image = keyImage(settings);
    setImage(context, image);
    setTitle(context, image ? '' : playlistTitle(settings));
  };

  let lastPlaying;
  // Sólo se avisa a Stream Deck cuando cambia el estado, no en cada consulta.
  const updatePlayState = playing => {
    if (playing === lastPlaying) return;
    lastPlaying = playing;
    for (const [context, entry] of contexts) if (entry.action === actions.playPause) setState(context, playing);
  };
  const poll = async () => {
    if (polled) return;
    polled = true;
    try { updatePlayState((await client.request('state', {}, 3000)).playing === true); }
    catch { updatePlayState(false); }
    finally { polled = false; }
  };
  const refreshPolling = () => {
    const needed = [...contexts.values()].some(entry => entry.action === actions.playPause);
    if (needed && !polling) { polling = setInterval(() => void poll(), 1000); void poll(); }
    if (!needed && polling) { clearInterval(polling); polling = undefined; }
  };

  const flash = (context, text, settings) => {
    clearTimeout(flashes.get(context));
    // El aviso va sobre el glifo solo: encima del nombre dibujado no se leería.
    if (keyImage(settings)) setImage(context);
    setTitle(context, text);
    flashes.set(context, setTimeout(() => { flashes.delete(context); showPlaylist(context, contexts.get(context)?.settings ?? settings); }, 2000));
  };

  const press = async (action, context, settings) => {
    try {
      if (action === actions.previous) await client.request('previous');
      else if (action === actions.next) await client.request('next');
      else if (action === actions.playPause) updatePlayState((await client.request('playPause')).playing === true);
      else if (action === actions.window) {
        try { await client.request('toggleWindow', {}, 5000); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'not-running') throw error;
          // Mientras arranca todavía no hay canal: otra tecla en esos segundos no abre una segunda vez.
          if (Date.now() - launchedAt < 8000) return;
          if (launch() !== 'launched') throw new Error('no-path');
          launchedAt = Date.now();
        }
        ok(context);
      }
      else if (action === actions.addToPlaylist) {
        if (!playlistPattern.test(settings?.playlistId ?? '')) { flash(context, 'Choose\nplaylist', settings); alert(context); return; }
        const result = await client.request('addToPlaylist', { playlistId: settings.playlistId }, 100000);
        if (result.result === 'already') flash(context, 'Already\nin list', settings);
        ok(context);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'failed';
      if (action === actions.addToPlaylist) {
        const labels = { 'not-running': 'Open\nEl Music', 'signed-out': 'Sign in', 'nothing-playing': 'Nothing\nplaying', 'not-a-song': 'Not a\nsong', busy: 'Busy', changed: 'Song\nchanged', unknown: 'Check\nplaylist', timeout: 'Check\nplaylist' };
        if (labels[reason]) flash(context, labels[reason], settings);
      }
      log(`acción ${action.split('.').pop()} sin completar (${reason})`);
      alert(context);
    }
  };

  const sendPlaylists = async (action, context) => {
    let payload;
    try { payload = { playlists: (await client.request('playlists', {}, 60000)).playlists ?? [] }; }
    catch (error) { payload = { error: error instanceof Error ? error.message : 'failed' }; }
    send({ event: 'sendToPropertyInspector', action, context, payload });
  };

  socket.on('open', () => send({ event: registerEvent, uuid }));
  socket.on('message', text => {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    const { event, context, payload } = message ?? {};
    // Stream Deck puede omitir action en mensajes del inspector: se deduce del contexto registrado.
    const action = message?.action ?? contexts.get(context)?.action ?? (event === 'sendToPlugin' ? actions.addToPlaylist : undefined);
    if (typeof context !== 'string' || !Object.values(actions).includes(action)) return;
    if (event === 'willAppear') {
      contexts.set(context, { action, settings: payload?.settings ?? {} });
      if (action === actions.addToPlaylist) showPlaylist(context, payload?.settings);
      if (action === actions.playPause) setState(context, lastPlaying === true);
      refreshPolling();
    } else if (event === 'willDisappear') {
      contexts.delete(context); clearTimeout(flashes.get(context)); flashes.delete(context); refreshPolling();
    } else if (event === 'didReceiveSettings') {
      const entry = contexts.get(context);
      if (entry) entry.settings = payload?.settings ?? {};
      if (action === actions.addToPlaylist && !flashes.has(context)) showPlaylist(context, payload?.settings);
    } else if (event === 'keyDown') {
      void press(action, context, contexts.get(context)?.settings ?? payload?.settings);
    } else if (event === 'sendToPlugin' && action === actions.addToPlaylist && payload?.request === 'playlists') {
      void sendPlaylists(action, context);
    }
  });
  socket.on('error', () => { /* Stream Deck reinicia el plugin si se corta su canal. */ });
  socket.on('close', () => { if (polling) clearInterval(polling); for (const timer of flashes.values()) clearTimeout(timer); client.close(); onClose(); });
}

if (require.main === module) start({ port: Number(argument('-port')), uuid: argument('-pluginUUID'), registerEvent: argument('-registerEvent') });
module.exports = { actions, start };
