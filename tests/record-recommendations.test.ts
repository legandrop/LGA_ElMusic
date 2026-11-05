import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { playerSampleScript } from '../src/player';
import type { RecommendationCard, RecommendationDiagnostic, RecommendationMode, RecommendationResult, RecommendationSeed } from '../src/recommendation-types';

interface Job {
  seed: RecommendationSeed; mode: RecommendationMode; signal: AbortSignal; apiKey?: string;
  progress: (result: RecommendationResult) => void; resolve: (result: RecommendationResult) => void;
  diagnostic: (event: RecommendationDiagnostic) => void;
}
interface Presented { epoch: string; seed?: RecommendationSeed; mode: RecommendationMode; open: boolean; busy: boolean; result: RecommendationResult; returnToken?: string; returnDestination?: string; restoreScroll?: number }
let activeJobs: Job[] | undefined;
const providerPath = require.resolve('../src/recommendations');
const controllerPath = require.resolve('../src/record-recommendations');
const previousProvider = require.cache[providerPath]; const previousController = require.cache[controllerPath];
const originalArtworkGuard = (require(providerPath) as typeof import('../src/recommendations')).appleArtworkUrl;
const provider = new Module(providerPath);
provider.filename = providerPath; provider.loaded = true;
provider.exports = {
  appleArtworkUrl: originalArtworkGuard,
  recommendations: (seed: RecommendationSeed, mode: RecommendationMode, signal: AbortSignal,
    progress?: (result: RecommendationResult) => void, apiKey?: string, diagnostic?: (event: RecommendationDiagnostic) => void): Promise<RecommendationResult> => {
    if (!activeJobs) throw new Error('Proveedor de prueba sin caso activo.');
    return new Promise(resolve => activeJobs!.push({ seed, mode, signal, apiKey, progress: progress ?? (() => {}), diagnostic: diagnostic ?? (() => {}), resolve }));
  }
};
require.cache[providerPath] = provider; delete require.cache[controllerPath];
const { installRecordRecommendations, recommendationNowPlaying, recommendationRequest } = require('../src/record-recommendations') as typeof import('../src/record-recommendations');
after(() => {
  if (previousProvider) require.cache[providerPath] = previousProvider; else delete require.cache[providerPath];
  if (previousController) require.cache[controllerPath] = previousController; else delete require.cache[controllerPath];
});

const firstSeed: RecommendationSeed = { title: 'No', artist: 'Nicolas Jaar', album: 'Sirens', country: 'ar' };
const secondSeed: RecommendationSeed = { title: 'Love Cry', artist: 'Four Tet', album: 'There Is Love in You', country: 'ar' };
const fakeKey = '0123456789abcdef0123456789abcdef'; // Fixture inventada; no se consulta ninguna cuenta.
function result(title: string): RecommendationResult {
  return { items: [{ id: '123456', url: 'https://music.apple.com/ar/song/123456', title, artist: 'Fixture artist', album: 'Fixture album',
    source: 'ListenBrainz', signal: 'track', sourceUrl: 'https://labs.api.listenbrainz.org/similar-recordings',
    matchMethod: 'metadata', recordingIdentityVerified: false, editionStatus: 'single', alternativeIds: [] }],
    experimental: true, partial: true, lastFmConfigured: false, artistFallback: false, rejected: 0, unresolved: 0, providerUnavailable: false };
}
const settle = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };

function progressiveResult(verified: number): RecommendationResult {
  const data = result('Song 0'), base = data.items[0];
  data.items = Array.from({ length: verified }, (_unused, index) => ({ ...base, id: String(123456 + index), title: 'Song ' + index,
    url: 'https://music.apple.com/ar/song/' + (123456 + index), candidateKey: String(index) }));
  data.cards = Array.from({ length: 4 }, (_unused, index) => ({ ...base, key: String(index), title: 'Song ' + index,
    verificationStatus: index < verified ? 'verified' : index === verified ? 'checking' : 'pending',
    ...(index < verified ? { verifiedId: String(123456 + index) } : {}) }));
  return data;
}

class Frame extends EventEmitter {
  seed = firstSeed; states: Presented[] = []; scripts: string[] = []; destroyed = false;
  private pendingCommand?: string;
  uiDocument?: UiDocument; uiContext?: vm.Context;
  playbackCalls: Array<{ script: string; userGesture: boolean }> = [];
  playbackHandler?: () => Promise<unknown>;
  renderHandler?: () => Promise<void>;
  sampleHandler?: () => Promise<void>;
  executionGate?: (script: string) => Promise<void>;
  get command(): string | undefined { return this.uiDocument ? this.uiDocument.nav.dataset.recommendationRequest : this.pendingCommand; }
  set command(value: string | undefined) { if (this.uiDocument) { if (value) this.uiDocument.nav.dataset.recommendationRequest = value; else delete this.uiDocument.nav.dataset.recommendationRequest; } else this.pendingCommand = value; }
  url = 'https://music.apple.com/ar/new'; uiPresent = true;
  getURL(): string { return this.url; }
  isDestroyed(): boolean { return this.destroyed; }
  mainFrame = { url: this.url, executeJavaScript: async (script: string, userGesture = false): Promise<unknown> => {
    this.scripts.push(script);
    if (this.executionGate) await this.executionGate(script);
    if (script === playerSampleScript) {
      const sample = { seed: this.seed, metadataPresent: true, albumButtonAvailable: false,
        albumUrl: this.getURL(), recommendationRequest: this.command, recommendationUiPresent: this.uiPresent };
      if (this.sampleHandler) { const pending = this.sampleHandler; this.sampleHandler = undefined; await pending(); }
      return sample;
    }
    const state = script.match(/const state = (.+);\n    const nav =/);
    if (state) {
      this.states.push(JSON.parse(state[1]) as Presented); this.uiPresent = true;
      const value = this.uiContext ? vm.runInContext(script, this.uiContext) : true;
      if (this.renderHandler) { const pending = this.renderHandler; this.renderHandler = undefined; await pending(); }
      return value;
    }
    if (script.includes('elMusicRecommendationQueueBusy = token')) { this.playbackCalls.push({ script, userGesture }); return this.playbackHandler ? this.playbackHandler() : this.uiContext ? vm.runInContext(script, this.uiContext) : 'requested'; }
    assert.equal(userGesture, false);
    const clear = script.match(/nav\?\.dataset\.recommendationRequest === (.+)\) delete nav\.dataset\.recommendationRequest/);
    if (clear) { if (this.command === JSON.parse(clear[1])) this.command = undefined; return; }
    throw new Error('Script inesperado en WebContents de prueba.');
  } };
  get latest(): Presented { assert.ok(this.states.length); return this.states[this.states.length - 1]; }
  destroy(): void { this.destroyed = true; this.emit('destroyed'); }
}
class UiElement {
  id = ''; className = ''; textContent = ''; href = ''; src = ''; alt = ''; referrerPolicy = ''; disabled = false; title = ''; tabIndex = 0; scrollTop = 0;
  onerror?: () => void;
  dataset: Record<string, string> = new Proxy({}, {
    set: (target: Record<string, string>, key: string, value: string): boolean => {
      target[key] = value; this.document.attributeChanged(this, key); return true;
    },
    deleteProperty: (target: Record<string, string>, key: string): boolean => {
      delete target[key]; this.document.attributeChanged(this, key); return true;
    }
  });
  attributes: Record<string, string> = {}; children: UiElement[] = []; parent?: UiElement;
  onclick?: (event: { detail: number; isTrusted: boolean }) => void;
  clickListeners: Array<(event: unknown) => void> = [];
  focusVisible = false;
  constructor(readonly document: UiDocument, readonly tagName = 'DIV') {}
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  getAttribute(name: string): string | undefined { return name === 'src' ? this.src || undefined : this.attributes[name]; }
  appendChild(child: UiElement): UiElement { child.parent = this; this.children.push(child); return child; }
  append(...children: UiElement[]): void { children.forEach(child => this.appendChild(child)); }
  get parentElement(): UiElement | undefined { return this.parent; }
  replaceChild(child: UiElement, old: UiElement): UiElement {
    const index = this.children.indexOf(old); assert.ok(index >= 0); old.remove();
    child.parent = this; this.children.splice(index, 0, child); return old;
  }
  insertBefore(child: UiElement, before: UiElement | null): UiElement {
    if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
    child.parent = this; const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, child); return child;
  }
  remove(): void {
    if (this.document.activeElement === this || this.descendants().includes(this.document.activeElement!)) this.document.activeElement = this.document.body;
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined;
  }
  focus(): void { this.document.activeElement = this; this.focusVisible = true; }
  blur(): void { if (this.document.activeElement === this) this.document.activeElement = this.document.body; this.focusVisible = false; }
  matches(selector: string): boolean { assert.equal(selector, ':focus-visible'); return this.focusVisible && this.document.activeElement === this; }
  addEventListener(type: string, listener: (event: unknown) => void): void { assert.equal(type, 'click'); this.clickListeners.push(listener); }
  get isConnected(): boolean { return this.document.documentElement.descendants().includes(this); }
  descendants(): UiElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector: string): UiElement[] {
    const attribute = selector.match(/^\[data-([a-z-]+)(?:="([^"]+)")?\]$/);
    if (attribute) {
      const key = attribute[1].replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      return this.descendants().filter(child => attribute[2] ? child.dataset[key] === attribute[2] : key in child.dataset);
    }
    if (selector.startsWith('.')) return this.descendants().filter(child => child.className.split(/\s+/).includes(selector.slice(1)));
    return this.descendants().filter(child => child.tagName.toLowerCase() === selector);
  }
  querySelector(selector: string): UiElement | null { return this.querySelectorAll(selector)[0] || null; }
  closest(selector: string): UiElement | null {
    if (selector === '#el-music-label-panel,#el-music-recommendation-panel') {
      for (let item: UiElement | undefined = this; item; item = item.parent) if (['el-music-label-panel', 'el-music-recommendation-panel'].includes(item.id)) return item;
      return null;
    }
    if (selector !== '.navigation a') return null;
    for (let item: UiElement | undefined = this; item; item = item.parent) {
      if (item.tagName !== 'A') continue;
      for (let parent = item.parent; parent; parent = parent.parent) if (parent.className.split(/\s+/).includes('navigation')) return item;
    }
    return null;
  }
}
class UiDocument {
  documentElement = new UiElement(this, 'HTML'); body = new UiElement(this, 'BODY'); activeElement?: UiElement;
  nav = new UiElement(this); button = new UiElement(this, 'BUTTON'); sidebar = new UiElement(this); anchor = new UiElement(this, 'A');
  listeners: Array<(event: unknown) => void> = [];
  player = new UiElement(this); nativeHeading = new UiElement(this, 'H1');
  windowListeners = new Map<string, Array<(event: unknown) => void>>(); intervals = new Map<number, () => void>();
  observers: Array<{ target: UiElement; callback: () => void }> = [];
  attributeChanged(target: UiElement, key: string): void {
    if (key === 'recommendationRequest') for (const observer of this.observers)
      if (observer.target === target) queueMicrotask(observer.callback);
  }
  constructor(url: string) {
    this.documentElement.appendChild(this.body); this.activeElement = this.body; this.replaceNavigation(); this.sidebar.className = 'navigation';
    this.anchor.href = url; this.sidebar.appendChild(this.anchor); this.body.appendChild(this.sidebar);
    this.nativeHeading.textContent = 'Original Apple page'; this.body.append(this.player, this.nativeHeading);
  }
  replaceNavigation(): void {
    this.nav.remove(); this.nav = new UiElement(this); this.nav.id = 'el-music-navigation';
    this.button = new UiElement(this, 'BUTTON'); this.button.id = 'el-music-open-recommendations'; this.nav.appendChild(this.button); this.body.appendChild(this.nav);
  }
  createElement(tag: string): UiElement { return new UiElement(this, tag.toUpperCase()); }
  getElementById(id: string): UiElement | undefined { return this.documentElement.descendants().find(element => element.id === id); }
  querySelector(selector: string): UiElement | null { return selector === '.chrome-player' ? this.player : null; }
  querySelectorAll(selector: string): UiElement[] { assert.equal(selector, 'h1'); return this.documentElement.descendants().filter(item => item.tagName === 'H1'); }
  addEventListener(type: string, listener: (event: unknown) => void, capture: boolean): void {
    assert.equal(type, 'click'); assert.equal(capture, true); this.listeners.push(listener);
  }
  click(target: UiElement, detail = 1, isTrusted = true): { prevented: number; stopped: number; originalHandled: boolean } {
    if (target.disabled) return { prevented: 0, stopped: 0, originalHandled: true };
    let prevented = 0; let stopped = 0;
    if (detail > 0) { this.activeElement = target; target.focusVisible = false; }
    const event = { target, currentTarget: target, detail, isTrusted, button: 0, preventDefault: () => { prevented++; }, stopPropagation: () => { stopped++; } };
    this.listeners.forEach(listener => listener(event));
    target.clickListeners.forEach(listener => listener(event));
    target.onclick?.(event);
    return { prevented, stopped, originalHandled: !prevented && !stopped };
  }
  emit(type: string, event: unknown): void { this.windowListeners.get(type)?.forEach(listener => listener(event)); }
}
function uiFixture(frame: Frame): { document: UiDocument; entries: Array<{ url: string; state: unknown }>; back: (intent?: boolean, trusted?: boolean) => void } {
  const document = new UiDocument(frame.getURL()); const location = new URL(frame.getURL()); const currentFrame = {};
  const entries: Array<{ url: string; state: unknown }> = [{ url: frame.getURL(), state: null }]; let index = 0;
  const navigate = (url: string): void => {
    frame.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url });
    frame.url = url; location.href = url; frame.emit('did-navigate-in-page', {}, url, true);
  };
  const history = {
    get state(): unknown { return entries[index].state; },
    replaceState(state: unknown, _title: string, url: string): void { entries[index] = { url, state: structuredClone(state) }; navigate(url); },
    pushState(state: unknown, _title: string, url: string): void { entries.splice(index + 1); entries.push({ url, state }); index++; document.nativeHeading.textContent = 'Fixture result'; navigate(url); }
  };
  frame.uiDocument = document;
  frame.uiContext = vm.createContext({ document, history, Element: UiElement, URL, top: currentFrame, self: currentFrame, location,
    console: { debug: (message: string): void => {
      frame.mainFrame.url = frame.getURL(); frame.emit('console-message', { message, frame: frame.mainFrame });
    } },
    MutationObserver: class {
      constructor(readonly callback: () => void) {}
      observe(target: UiElement, options: unknown): void {
        assert.equal(JSON.stringify(options), JSON.stringify({ attributes: true, attributeFilter: ['data-recommendation-request'] }));
        document.observers.push({ target, callback: this.callback });
      }
    },
    addEventListener: (type: string, listener: (event: unknown) => void): void => { const listeners = document.windowListeners.get(type) ?? []; listeners.push(listener); document.windowListeners.set(type, listeners); },
    removeEventListener: (type: string, listener: (event: unknown) => void): void => { document.windowListeners.set(type, document.windowListeners.get(type)?.filter(item => item !== listener) ?? []); },
    setInterval: (callback: () => void): number => { const token = document.intervals.size + 1; document.intervals.set(token, callback); return token; },
    clearInterval: (token: number): void => { document.intervals.delete(token); },
    dispatchEvent: (event: { type: string }): void => document.emit(event.type, event),
    PopStateEvent: class { readonly isTrusted = false; readonly state: unknown; constructor(readonly type: string, init: { state: unknown }) { this.state = init.state; } }
  });
  vm.runInContext(frame.scripts.filter(script => /const state =/.test(script)).at(-1)!, frame.uiContext);
  return { document, entries, back: (intent = true, trusted = true): void => {
    if (intent && document.nav.dataset.recommendationReturnDestination === frame.getURL()) document.nav.dataset.recommendationBackIntent = document.nav.dataset.recommendationReturnToken;
    assert.ok(index > 0); index--; navigate(entries[index].url);
    document.emit('popstate', { state: entries[index].state, isTrusted: trusted });
  } };
}
async function harness(run: (fixture: {
  frame: Frame; jobs: Job[]; tick: () => Promise<void>; open: () => Promise<void>;
  wake: () => Promise<void>; wakeCount: () => number;
  setKey: (key?: string) => void; configurationChanged: () => void;
  diagnostics: Array<{ event: string; fields: Record<string, boolean | number> }>;
}) => Promise<void>): Promise<void> {
  const originalInterval = globalThis.setInterval; const originalClear = globalThis.clearInterval;
  const originalTimeout = globalThis.setTimeout; const originalClearTimeout = globalThis.clearTimeout;
  const frame = new Frame(); const jobs: Job[] = []; const failures: string[] = []; const diagnostics: Array<{ event: string; fields: Record<string, boolean | number> }> = [];
  let callback: (() => void) | undefined; let cleared = false; let key: string | undefined;
  const token = {} as NodeJS.Timeout;
  const wakeToken = {} as NodeJS.Timeout; let wakeCallback: (() => void) | undefined;
  globalThis.setInterval = ((next: () => void, milliseconds: number) => {
    assert.equal(milliseconds, 1500); callback = next; return token;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((actual: NodeJS.Timeout) => { assert.equal(actual, token); cleared = true; callback = undefined; }) as typeof globalThis.clearInterval;
  globalThis.setTimeout = ((next: () => void, milliseconds: number) => {
    assert.equal(milliseconds, 100); assert.equal(wakeCallback, undefined); wakeCallback = next; return wakeToken;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((actual: NodeJS.Timeout) => { assert.equal(actual, wakeToken); wakeCallback = undefined; }) as typeof globalThis.clearTimeout;
  activeJobs = jobs;
  try {
    const configurationChanged = installRecordRecommendations(frame as unknown as WebContents, () => key, () => failures.push('controller failure'), (event, fields) => diagnostics.push({ event, fields }));
    const tick = async (): Promise<void> => { assert.ok(callback); callback(); await settle(); };
    await tick();
    const open = async (): Promise<void> => { frame.command = `open/${frame.latest.epoch}/track`; await tick(); };
    const wake = async (): Promise<void> => { await settle(); assert.ok(wakeCallback); const next = wakeCallback; wakeCallback = undefined; next(); await settle(); };
    await run({ frame, jobs, tick, open, wake, wakeCount: () => Number(!!wakeCallback), setKey: next => { key = next; }, configurationChanged, diagnostics });
    assert.deepEqual(failures, []);
  } finally {
    frame.destroy(); await settle();
    globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; activeJobs = undefined;
    globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(cleared, true); assert.ok(jobs.every(job => job.signal.aborted));
}

test('recommendation commands reject obsolete epochs and unknown modes', () => {
  assert.deepEqual(recommendationRequest('open/current/track', 'current'), { action: 'open', mode: 'track' });
  assert.deepEqual(recommendationRequest('close/current', 'current'), { action: 'close' });
  for (const command of ['open/old/track', 'open/current/queue', 'open/current/track/extra', 'close/old', 'close/current/extra', 'fetch/current/https://evil.test'])
    assert.equal(recommendationRequest(command, 'current'), undefined);
  const token = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(recommendationRequest('follow/current/123456/275', 'current'), { action: 'follow', kind: 'song', id: '123456', scroll: 275 });
  assert.deepEqual(recommendationRequest(`restore/current/${token}`, 'current'), { action: 'restore', token });
  assert.deepEqual(recommendationRequest('follow/current/artist/123456/275', 'current'), { action: 'follow', kind: 'artist', id: '123456', scroll: 275 });
  assert.deepEqual(recommendationRequest('follow/current/album/123456/0', 'current'), { action: 'follow', kind: 'album', id: '123456', scroll: 0 });
  for (const command of ['follow/old/123456/0', 'follow/current/abc/0', 'follow/current/123456/-1', 'follow/current/123456/1.5', 'follow/current/123456/1000001', 'follow/current/123456/02', `restore/old/${token}`, 'restore/current/not-a-token', `restore/current/${token}/extra`])
    assert.equal(recommendationRequest(command, 'current'), undefined);
});

test('provisional rows are stable, disabled until verified and preserve focus across progress', async () => {
  await harness(async ({ frame, jobs, open, tick }) => {
    const { document } = uiFixture(frame); await open();
    const cards: RecommendationCard[] = Array.from({ length: 48 }, (_unused, index) => ({ key: index.toString(16).padStart(32, '0'),
      title: 'Candidate ' + index, artist: 'Fixture artist', album: 'Fixture album', source: 'ListenBrainz', signal: 'track',
      sourceUrl: 'https://labs.api.listenbrainz.org/similar-recordings', verificationStatus: 'pending' }));
    const provisional = { ...result('Candidate 0'), items: [], cards };
    jobs[0].progress(provisional); await settle();
    const panel = document.getElementById('el-music-recommendation-panel')!;
    const rows = panel.querySelectorAll('.el-music-recommendation-card'); assert.equal(rows.length, 48);
    assert.equal(panel.querySelectorAll('[data-el-music-recommendation-id]').length, 0);
    assert.equal(panel.querySelectorAll('[data-el-music-recommendation-play]').length, 0);
    assert.ok(panel.querySelectorAll('button').filter(element => element.className.includes('recommendation-play') || element.className.includes('recommendation-title')).every(element => element.disabled));
    const mode = panel.descendants().find(element => element.dataset.elMusicRecommendationFocus === 'mode/track')!; mode.focus();
    const data = result('Candidate 0'); data.items[0].candidateKey = cards[0].key;
    data.cards = cards.map((card, index) => index ? card : { ...card, verificationStatus: 'verified', verifiedId: '123456' });
    jobs[0].progress(data); await settle();
    assert.equal(document.getElementById('el-music-recommendation-panel'), panel);
    assert.equal(panel.querySelectorAll('.el-music-recommendation-card')[20], rows[20]);
    assert.equal(document.activeElement, mode); assert.equal(panel.querySelectorAll('[data-el-music-recommendation-id]').length, 1);
    const title = panel.descendants().find(element => element.dataset.elMusicRecommendationFocus === 'title/' + cards[0].key)!;
    assert.equal(title.disabled, false); document.click(title); await tick(); assert.equal(frame.playbackCalls.length, 1);
  });
});

test('artist and album links use verified DTO destinations and Back restores the list', async () => {
  for (const kind of ['artist', 'album'] as const) await harness(async ({ frame, jobs, open, tick }) => {
    const { document, entries, back } = uiFixture(frame); await open();
    const data = result('Fixture result'); data.items[0].artistUrl = 'https://music.apple.com/ar/artist/fixture/321';
    data.items[0].albumUrl = 'https://music.apple.com/ar/album/fixture/654'; jobs[0].resolve(data); await settle();
    const link = document.documentElement.descendants().find(element => element.dataset.elMusicRecommendationFocus === kind + '/123456')!;
    document.click(link); await settle(); assert.equal(entries.length, 2);
    assert.equal(frame.getURL(), kind === 'artist' ? data.items[0].artistUrl : data.items[0].albumUrl);
    assert.equal(frame.latest.open, false); assert.ok(document.nav.dataset.recommendationReturnToken);
    back(); await tick(); assert.equal(frame.latest.open, true); assert.equal(frame.latest.result.items[0].id, '123456');
  });
});

test('closing the panel (Back) removes only the overlay and an obsolete UI response cannot reopen it', async () => {
  await harness(async ({ frame, jobs, open, tick }) => {
    const { document, entries } = uiFixture(frame); await open(); jobs[0].resolve(result('Fixture result')); await settle();
    const stale = frame.scripts.filter(script => /const state =/.test(script)).at(-1)!;
    const native = document.nativeHeading;
    document.click(document.documentElement.descendants().find(element => element.dataset.closeRecommendations === 'true')!);
    assert.equal(document.getElementById('el-music-recommendation-panel'), undefined); assert.equal(native.isConnected, true);
    assert.equal(entries.length, 1); await tick();
    assert.equal(vm.runInContext(stale, frame.uiContext!), false);
    assert.equal(document.getElementById('el-music-recommendation-panel'), undefined); assert.equal(native.isConnected, true);
  });
});

test('fallback copy is explicit and unconfirmed or hostile artist URLs never become links', async () => {
  await harness(async ({ frame, jobs, open }) => {
    const { document } = uiFixture(frame); await open();
    const data = result('Fixture result'); data.artistFallback = true; data.items[0].signal = 'artist';
    data.items[0].artistUrl = 'https://music.apple.com.evil.test/ar/artist/321';
    data.items[0].albumUrl = 'https://music.apple.com/us/album/654'; jobs[0].resolve(data); await settle();
    const panel = document.getElementById('el-music-recommendation-panel')!;
    assert.ok(panel.descendants().some(element => element.textContent.includes('Track matches unavailable · Showing artist matches')));
    assert.equal(panel.descendants().find(element => element.dataset.elMusicRecommendationFocus === 'artist/123456')?.href, '');
    assert.equal(panel.descendants().find(element => element.dataset.elMusicRecommendationFocus === 'album/123456')?.href, '');
  });
});

test('basis copy follows actual candidate signals rather than an attempted artist fallback', async () => {
  await harness(async ({ frame, jobs, open }) => {
    const { document } = uiFixture(frame); await open();
    const note = (): string => document.getElementById('el-music-recommendation-panel')!.descendants().find(element => element.dataset.elMusicPart === 'note')!.textContent;
    assert.ok(note().startsWith('Finding related music…'));
    const data = result('Track result'); data.artistFallback = true; jobs[0].progress(data); await settle();
    assert.ok(note().startsWith('Based on the track ·'));
    const mixed: RecommendationResult = { ...data, cards: [{ ...data.items[0], key: 'track', verificationStatus: 'verified', verifiedId: '123456' },
      { ...data.items[0], key: 'artist', signal: 'artist', verificationStatus: 'pending' }] };
    jobs[0].progress(mixed); await settle(); assert.ok(note().startsWith('Track and artist matches ·'));
    jobs[0].resolve(mixed); await settle(); assert.ok(note().startsWith('Track and artist matches ·'));
  });
});

test('Apple public-catalog DTO renders its actual provenance, links and playable verified result', async () => {
  await harness(async ({ frame, jobs, open, tick }) => {
    const { document } = uiFixture(frame); await open();
    document.click(document.documentElement.descendants().find(element => element.dataset.elMusicRecommendationFocus === 'mode/artist')!); await tick();
    const data = result('Apple catalog song'); Object.assign(data.items[0], { source: 'Apple Music', signal: 'artist', matchMethod: 'public-catalog',
      sourceUrl: 'https://music.apple.com/ar/artist/fixture/321', artistUrl: 'https://music.apple.com/ar/artist/fixture/321', albumUrl: 'https://music.apple.com/ar/album/fixture/654' });
    data.cards = [{ ...data.items[0], key: 'apple', verificationStatus: 'verified', verifiedId: data.items[0].id }];
    jobs[1].resolve(data); await settle();
    const panel = document.getElementById('el-music-recommendation-panel')!;
    assert.equal(panel.descendants().find(element => element.dataset.elMusicPart === 'sources')!.textContent, 'Apple Music · Public catalog · Matches use public metadata');
    assert.equal(panel.descendants().find(element => element.className === 'el-music-recommendation-reason')!.textContent, 'Apple Music');
    assert.equal(panel.descendants().find(element => element.dataset.elMusicRecommendationFocus === 'artist/apple')!.href, data.items[0].artistUrl);
    assert.equal(panel.descendants().find(element => element.dataset.elMusicRecommendationFocus === 'album/apple')!.href, data.items[0].albumUrl);
    assert.equal(frame.latest.result.items[0].matchMethod, 'public-catalog');
    assert.equal(frame.latest.result.items[0].recordingIdentityVerified, false);
    document.click(panel.descendants().find(element => element.dataset.elMusicRecommendationFocus === 'play/123456')!); await tick();
    assert.equal(frame.playbackCalls.length, 1);
  });
});

test('footer attributes only actual fallback sources, including provisional candidates', async () => {
  const sourceLists: Array<Array<'Last.fm' | 'ListenBrainz'>> = [['Last.fm'], ['ListenBrainz'], ['Last.fm', 'ListenBrainz']];
  for (const sources of sourceLists) await harness(async ({ frame, jobs, open }) => {
    const { document } = uiFixture(frame); await open();
    const data = result('Fallback song'); data.lastFmConfigured = true; data.items[0].source = sources[0];
    data.cards = sources.map((source, index) => ({ ...data.items[0], source, key: String(index), verificationStatus: index ? 'pending' : 'verified', ...(index ? {} : { verifiedId: data.items[0].id }) }));
    jobs[0].resolve(data); await settle();
    const footer = document.getElementById('el-music-recommendation-panel')!.descendants().find(element => element.dataset.elMusicPart === 'sources')!.textContent;
    assert.equal(footer.includes('Apple Music'), false);
    assert.equal(footer.includes('ListenBrainz · Experimental'), sources.includes('ListenBrainz'));
    assert.equal(footer.includes('Last.fm'), sources.includes('Last.fm'));
    assert.ok(footer.endsWith('Matches use public metadata'));
  });
});

test('command observer wakes only the exact musical main frame and coalesces bursts', async () => {
  await harness(async ({ frame, jobs, wake, wakeCount }) => {
    const { document } = uiFixture(frame);
    const reads = (): number => frame.scripts.filter(script => script === playerSampleScript).length;
    const before = reads();
    for (const details of [
      { message: 'other', frame: frame.mainFrame },
      { message: 'elMusic.recommendations.request-ready', frame: { url: frame.getURL() } },
      { message: 'elMusic.recommendations.request-ready', frame: null }
    ]) frame.emit('console-message', details);
    for (const url of ['https://music.apple.com.evil.test/ar/new', 'https://user@music.apple.com/ar/new', 'https://music.apple.com:444/ar/new']) {
      frame.url = url; frame.mainFrame.url = url;
      frame.emit('console-message', { message: 'elMusic.recommendations.request-ready', frame: frame.mainFrame });
    }
    assert.equal(wakeCount(), 0); assert.equal(reads(), before);
    frame.url = 'https://music.apple.com/ar/new'; frame.mainFrame.url = frame.url;
    document.click(document.button); await settle();
    for (let i = 0; i < 100; i++) frame.emit('console-message', { message: 'elMusic.recommendations.request-ready', frame: frame.mainFrame });
    assert.equal(wakeCount(), 1); assert.equal(jobs.length, 0);
    await wake(); assert.equal(jobs.length, 1); assert.equal(reads(), before + 1); assert.equal(wakeCount(), 0);
    assert.equal(document.observers.length, 1);
    vm.runInContext(frame.scripts.find(script => /const state =/.test(script))!, frame.uiContext!);
    assert.equal(document.observers.length, 1);
  });
});

test('a command arriving during a sample receives a trailing wake without waiting for the metadata interval', async () => {
  await harness(async ({ frame, jobs, tick, wake, wakeCount }) => {
    uiFixture(frame); let release!: () => void;
    frame.sampleHandler = () => new Promise<void>(resolve => { release = resolve; });
    await tick(); frame.command = `open/${frame.latest.epoch}/track`; await settle();
    assert.equal(wakeCount(), 1); await wake(); assert.equal(jobs.length, 0);
    release(); await settle(); assert.equal(wakeCount(), 1);
    await wake(); assert.equal(jobs.length, 1); assert.equal(frame.latest.open, true);
  });
});

test('destroy cancels a pending wake and removes its console listener; interval remains the fallback', async () => {
  await harness(async ({ frame, jobs, tick, wakeCount }) => {
    frame.command = `open/${frame.latest.epoch}/track`; await tick(); assert.equal(jobs.length, 1);
    frame.emit('console-message', { message: 'elMusic.recommendations.request-ready', frame: frame.mainFrame });
    assert.equal(wakeCount(), 1); frame.destroy(); assert.equal(wakeCount(), 0);
    assert.equal(frame.listenerCount('console-message'), 0);
    frame.emit('console-message', { message: 'elMusic.recommendations.request-ready', frame: frame.mainFrame });
    assert.equal(wakeCount(), 0);
  });
});

test('identical provider DTOs do not rebuild the panel; counters, errors and completion remain visible', async () => {
  await harness(async ({ frame, jobs, open }) => {
    await open(); const data = result('Fixture result'); jobs[0].progress(data); await settle();
    const before = frame.states.length; jobs[0].progress(structuredClone(data)); await settle(); assert.equal(frame.states.length, before);
    const failed = { ...data, rejected: 1, providerUnavailable: true };
    jobs[0].progress(failed); await settle(); assert.equal(frame.states.length, before + 1);
    assert.equal(frame.latest.result.providerUnavailable, true); assert.equal(frame.latest.result.rejected, 1);
    jobs[0].resolve(failed); await settle(); assert.equal(frame.latest.busy, false);
  });
});

test('Play dispatch does not wait for a loading panel render and does not replace the panel before SDK completion', async () => {
  await harness(async ({ frame, jobs, tick, open }) => {
    const { document } = uiFixture(frame); await open(); jobs[0].resolve(result('Fixture result')); await settle();
    const panel = document.getElementById('el-music-recommendation-panel');
    let complete!: (value: unknown) => void;
    frame.playbackHandler = () => new Promise(resolve => { complete = resolve; });
    const before = frame.states.length;
    document.click(document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'play/123456')!);
    await tick(); assert.equal(frame.playbackCalls.length, 1); assert.equal(frame.states.length, before);
    assert.equal(document.getElementById('el-music-recommendation-panel'), panel);
    assert.equal(document.documentElement.descendants().some(item => item.textContent === 'Preparing the related songs…'), true);
    complete('requested'); await settle(); assert.equal(frame.states.length, before + 1);
  });
});

test('Play buffers matching while the SDK is pending, preserves the seed and uses new results only for the next Play', async () => {
  await harness(async ({ frame, jobs, tick, open }) => {
    const { document } = uiFixture(frame); await open(); jobs[0].progress(progressiveResult(1)); await settle();
    const panel = document.getElementById('el-music-recommendation-panel')!;
    const status = (): string => panel.descendants().find(item => item.className === 'el-music-recommendation-status')!.textContent;
    const ids = (): string[] => panel.querySelectorAll('[data-el-music-recommendation-id]').map(item => item.dataset.elMusicRecommendationId);
    const rows = panel.querySelectorAll('.el-music-recommendation-card'); const before = frame.states.length;
    let complete!: (value: unknown) => void; frame.playbackHandler = () => new Promise(resolve => { complete = resolve; });
    document.click(panel.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'play/123456')!); await tick();
    assert.equal(jobs[0].signal.aborted, false); assert.equal(frame.states.length, before);
    assert.match(frame.playbackCalls[0].script, /songs = \["123456"\]/);
    jobs[0].progress(progressiveResult(2)); jobs[0].progress(progressiveResult(3)); await settle();
    frame.seed = secondSeed; frame.uiPresent = false; await tick(); frame.uiPresent = true;
    assert.equal(frame.states.length, before); assert.deepEqual(ids(), ['123456']);
    assert.deepEqual(panel.querySelectorAll('.el-music-recommendation-card'), rows); assert.ok(rows[0].querySelector('button')!.disabled);
    complete('requested'); await settle();
    assert.equal(frame.latest.busy, true); assert.deepEqual(frame.latest.seed, firstSeed); assert.deepEqual(jobs[0].seed, firstSeed);
    assert.deepEqual(ids(), ['123456', '123457', '123458']); assert.equal(frame.playbackCalls.length, 1);
    assert.equal(status(), 'Checking Apple Music matches · 3 of 4 checked · 3 ready to play');
    assert.equal(document.getElementById('el-music-recommendation-panel'), panel);
    assert.deepEqual(panel.querySelectorAll('.el-music-recommendation-card'), rows);
    jobs[0].progress(progressiveResult(4)); await settle(); assert.equal(frame.latest.result.items.length, 4); assert.equal(frame.playbackCalls.length, 1);
    jobs[0].resolve(progressiveResult(4)); await settle(); assert.equal(frame.latest.busy, false); assert.equal(status(), 'Playback requested.');
    frame.playbackHandler = async () => 'requested';
    document.click(panel.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'play/123459')!); await tick();
    assert.equal(frame.playbackCalls.length, 2); assert.match(frame.playbackCalls[1].script, /songs = \["123459","123456","123457","123458"\]/);
  });
});

test('a render already queued before Play evaluates before the SDK and cannot change its source IDs while it waits', async () => {
  await harness(async ({ frame, jobs, tick, open }) => {
    const { document } = uiFixture(frame); await open(); jobs[0].progress(progressiveResult(1)); await settle();
    const panel = document.getElementById('el-music-recommendation-panel')!;
    const ids = (): string[] => panel.querySelectorAll('[data-el-music-recommendation-id]').map(item => item.dataset.elMusicRecommendationId);
    const evaluations: Array<{ script: string; start: () => void }> = [];
    frame.executionGate = script => new Promise<void>(resolve => evaluations.push({ script, start: resolve }));
    const next = async (): Promise<void> => { assert.ok(evaluations.length); evaluations.shift()!.start(); await settle(); };
    let complete!: (value: object) => void;
    const queue = { items: [{}, {}] }; const mutations: Array<{ songs: string[]; startPlaying: boolean; repeatMode: number }> = [];
    const fixtureMusic = { queue, shuffleMode: 0, repeatMode: 0,
      setQueue: (options: { songs: string[]; startPlaying: boolean; repeatMode: number }) => {
        mutations.push({ ...options, songs: [...options.songs] }); return new Promise<object>(resolve => { complete = resolve; });
      }, addEventListener: () => {}, removeEventListener: () => {} };
    (frame.uiContext as Record<string, unknown>).fixtureMusic = fixtureMusic;
    vm.runInContext('globalThis.MusicKit = {PlayerShuffleMode:{off:0},PlayerRepeatMode:{none:0},getInstance:()=>fixtureMusic}', frame.uiContext!);
    jobs[0].progress(progressiveResult(2)); await settle();
    assert.match(evaluations[0].script, /const state =/); assert.deepEqual(ids(), ['123456']);
    document.click(panel.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'play/123456')!); await tick();
    assert.equal(evaluations.length, 2); assert.equal(evaluations[1].script, playerSampleScript); assert.equal(mutations.length, 0);
    // El mismo frame evalúa primero el render emitido y después sample, consumo y comando, sin esperar la promesa SDK.
    await next(); assert.deepEqual(ids(), ['123456', '123457']); assert.equal(document.getElementById('el-music-recommendation-panel'), panel);
    await next(); assert.match(evaluations[0].script, /delete nav.dataset.recommendationRequest/);
    await next(); assert.match(evaluations[0].script, /elMusicRecommendationQueueBusy = token/);
    await next(); assert.equal(evaluations.length, 0);
    assert.deepEqual(mutations, [{ songs: ['123456', '123457'], startPlaying: true, repeatMode: 0 }]);
    const before = frame.states.length; jobs[0].progress(progressiveResult(3)); await settle();
    assert.equal(frame.states.length, before); assert.equal(evaluations.length, 0);
    assert.deepEqual(ids(), ['123456', '123457']); assert.equal(document.getElementById('el-music-recommendation-panel'), panel);
    assert.ok(document.documentElement.dataset.elMusicRecommendationQueueBusy); assert.equal(jobs[0].signal.aborted, false);
    frame.executionGate = undefined; complete(queue); await settle();
    const cached = (document.documentElement as unknown as Record<symbol, { sourceKey: string }>)[Symbol.for('el-music.recommendation-queue')];
    assert.equal(cached.sourceKey, JSON.stringify(['123456', '123457']));
    assert.deepEqual(ids(), ['123456', '123457', '123458']); assert.equal(document.getElementById('el-music-recommendation-panel'), panel);
    assert.equal(mutations.length, 1); assert.equal(document.documentElement.dataset.elMusicRecommendationQueueBusy, undefined);
    jobs[0].resolve(progressiveResult(3)); await settle();
  });
});

test('matching completion during a pending SDK command publishes the latest result after success or failure', async () => {
  for (const outcome of ['requested', 'failed']) await harness(async ({ frame, jobs, tick, open }) => {
    const { document } = uiFixture(frame); await open(); jobs[0].progress(progressiveResult(1)); await settle();
    let complete!: (value: unknown) => void; frame.playbackHandler = () => new Promise(resolve => { complete = resolve; });
    const before = frame.states.length;
    document.click(document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'play/123456')!); await tick();
    jobs[0].progress(progressiveResult(2)); jobs[0].resolve(progressiveResult(3)); await settle();
    assert.equal(frame.states.length, before); assert.equal(jobs[0].signal.aborted, false);
    complete(outcome); await settle();
    assert.equal(frame.latest.busy, false); assert.equal(frame.latest.result.items.length, 3); assert.equal(frame.playbackCalls.length, 1);
    const status = document.documentElement.descendants().find(item => item.className === 'el-music-recommendation-status')!.textContent;
    assert.equal(status, outcome === 'requested' ? 'Playback requested.' : 'Playback could not be started. Try Play again.');
  });
});

test('close, mode, retry, configuration, navigation and destruction discard matching and SDK responses from the old context', async () => {
  for (const change of ['close', 'mode', 'retry', 'key', 'navigation', 'destroy']) await harness(async ({ frame, jobs, tick, open, setKey, configurationChanged }) => {
    const { document } = uiFixture(frame); await open(); jobs[0].progress(progressiveResult(1)); await settle();
    let complete!: (value: unknown) => void; frame.playbackHandler = () => new Promise(resolve => { complete = resolve; });
    document.click(document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'play/123456')!); await tick();
    jobs[0].progress(progressiveResult(2)); await settle();
    if (change === 'close') { frame.command = 'close/' + frame.latest.epoch; await tick(); assert.equal(document.getElementById('el-music-recommendation-panel'), undefined); }
    if (change === 'mode') { document.click(document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'mode/artist')!); await tick(); }
    if (change === 'retry') { frame.command = 'open/' + frame.latest.epoch + '/track'; await tick(); }
    if (change === 'key') { setKey(fakeKey); configurationChanged(); await settle(); }
    if (change === 'navigation') { frame.url = 'https://music.apple.com/ar/library/artists'; frame.emit('did-navigate-in-page', {}, frame.url, true); await settle(); }
    if (change === 'destroy') frame.destroy();
    assert.equal(jobs[0].signal.aborted, true);
    if (jobs[1]) { jobs[1].resolve(result('New context')); await settle(); }
    const before = frame.states.length; const latest = frame.latest;
    jobs[0].progress(progressiveResult(4)); jobs[0].resolve(progressiveResult(4)); complete('requested'); await settle();
    assert.equal(frame.states.length, before); assert.equal(frame.latest, latest); assert.equal(frame.playbackCalls.length, 1);
  });
});

test('pointer activation leaves recommendations unfocused through mode changes and asynchronous renders', async () => {
  await harness(async ({ frame, jobs, tick }) => {
    const { document } = uiFixture(frame);
    const control = (key: string): UiElement => { const element = document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === key); assert.ok(element); return element; };
    document.click(document.button); assert.equal(document.activeElement, document.body); await tick();
    assert.equal(document.activeElement, document.body); assert.equal(control('mode/track').getAttribute('aria-pressed'), 'true');
    document.click(control('mode/artist')); assert.equal(document.activeElement, document.body); await tick();
    assert.equal(jobs.length, 2); assert.equal(jobs[1].mode, 'artist'); assert.equal(jobs[0].signal.aborted, true);
    assert.equal(control('mode/artist').getAttribute('aria-pressed'), 'true'); assert.equal(control('mode/track').getAttribute('aria-pressed'), 'false');
    jobs[1].progress(result('Pointer progress')); await settle(); assert.equal(document.activeElement, document.body);
    jobs[1].resolve(result('Pointer final')); await settle(); assert.equal(document.activeElement, document.body);
    document.click(control('retry')); assert.equal(document.activeElement, document.body); await tick(); assert.equal(jobs.length, 3);
    jobs[2].resolve(result('Retried final')); await settle(); assert.equal(document.activeElement, document.body);
    document.click(control('mode/track')); assert.equal(document.activeElement, document.body); await tick();
    assert.equal(jobs[3].mode, 'track'); assert.equal(control('mode/track').getAttribute('aria-pressed'), 'true'); assert.equal(document.activeElement, document.body);
    document.click(control('close')); assert.equal(document.activeElement, document.body); await tick();
    assert.equal(frame.latest.open, false); assert.equal(document.getElementById('el-music-recommendation-panel'), undefined);
  });
});

test('keyboard activation retains visible focus across result renders and returns it on close', async () => {
  await harness(async ({ frame, jobs, tick }) => {
    const { document } = uiFixture(frame);
    const control = (key: string): UiElement => { const element = document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === key); assert.ok(element); return element; };
    document.button.focus(); document.click(document.button, 0); await tick();
    assert.equal(document.activeElement, control('heading')); assert.equal(control('heading').matches(':focus-visible'), true);
    control('mode/artist').focus(); document.click(control('mode/artist'), 0); await tick();
    assert.equal(document.activeElement, control('mode/artist')); assert.equal(control('mode/artist').matches(':focus-visible'), true);
    assert.equal(control('mode/artist').getAttribute('aria-pressed'), 'true'); assert.equal(jobs[1].mode, 'artist');
    jobs[1].progress(result('Keyboard progress')); await settle(); assert.equal(document.activeElement, control('mode/artist'));
    jobs[1].resolve(result('Keyboard final')); await settle(); assert.equal(document.activeElement, control('mode/artist'));
    control('close').focus(); document.click(control('close'), 0); await tick();
    assert.equal(frame.latest.open, false); assert.equal(document.activeElement, document.button); assert.equal(document.button.matches(':focus-visible'), true);
  });
});

test('opening while the LCD seed changes uses the current seed once and keeps keyboard access', async () => {
  for (const alreadyOpen of [false, true]) await harness(async ({ frame, jobs, tick, open }) => {
    const { document } = uiFixture(frame);
    if (alreadyOpen) await open();
    const previousJobs = jobs.length;
    document.button.focus(); document.click(document.button, 0); frame.seed = secondSeed; await tick();
    assert.equal(jobs.length, previousJobs + 1); assert.deepEqual(jobs.at(-1)?.seed, secondSeed);
    assert.equal(frame.latest.seed?.title, 'Love Cry');
    if (!alreadyOpen) assert.equal(document.activeElement?.dataset.elMusicRecommendationFocus, 'heading');
  });
});

test('provider diagnostics are closed metadata and obsolete jobs cannot emit them', async () => {
  await harness(async ({ frame, jobs, open, tick, diagnostics }) => {
    await open(); const job = jobs[0];
    job.diagnostic({ provider: 'ListenBrainz', stage: 'similares-artistas', failure: 'http', httpStatus: 503, attempt: 1, outcome: 'reintento' });
    assert.deepEqual(diagnostics, [{ event: 'Recomendaciones: ListenBrainz · similares-artistas · reintento (http)', fields: { intento: 1, estadoHTTP: 503 } }]);
    frame.command = `close/${frame.latest.epoch}`; await tick();
    job.diagnostic({ provider: 'ListenBrainz', stage: 'similares-artistas', failure: 'ninguno', attempt: 2, outcome: 'respuesta' });
    assert.equal(diagnostics.length, 1); assert.ok(!JSON.stringify(diagnostics).includes(firstSeed.artist));
  });
});

test('trusted Play is consumed once, keeps cards and scroll across LCD changes, and a new query uses the current song', async () => {
  await harness(async ({ frame, jobs, tick, open }) => {
    const { document } = uiFixture(frame); await open();
    const data = result('Fixture result');
    data.items[0].artworkUrl = 'https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/aa/bb/cc/00000000-0000-4000-8000-000000000001/cover.jpg/100x100bb.jpg';
    jobs[0].resolve(data); await settle();
    const image = document.documentElement.descendants().find(item => item.tagName === 'IMG')!;
    assert.equal(image.src, data.items[0].artworkUrl); assert.equal(image.alt, ''); assert.equal(image.referrerPolicy, 'no-referrer');
    const button = (): UiElement => document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'play/123456')!;
    document.click(button(), 1, false); await tick(); assert.equal(frame.playbackCalls.length, 0);
    frame.command = `play/${frame.latest.epoch}/999999`; await tick(); assert.equal(frame.playbackCalls.length, 0);
    let resolve!: (value: unknown) => void; frame.playbackHandler = () => new Promise(next => { resolve = next; });
    document.getElementById('el-music-recommendation-panel')!.scrollTop = 250;
    document.click(button()); document.click(button()); await tick();
    assert.equal(frame.command, undefined); assert.equal(frame.playbackCalls.length, 1); assert.equal(frame.playbackCalls[0].userGesture, true); assert.equal(button().disabled, true);
    assert.equal(document.getElementById('el-music-recommendation-panel')!.scrollTop, 250); assert.equal(document.activeElement, document.body);
    frame.seed = secondSeed; await tick(); assert.equal(jobs.length, 1); assert.deepEqual(frame.latest.seed, firstSeed);
    resolve('requested'); await settle(); assert.equal(frame.latest.open, true); assert.equal(frame.latest.result.items[0].title, 'Fixture result'); assert.equal(button().disabled, false);
    assert.equal(document.getElementById('el-music-recommendation-panel')!.scrollTop, 250);
    const currentImage = document.documentElement.descendants().find(item => item.tagName === 'IMG')!; currentImage.onerror?.();
    assert.equal(document.documentElement.descendants().some(item => item.tagName === 'IMG'), false);
    document.click(document.button); await tick(); assert.equal(jobs.length, 2); assert.deepEqual(jobs[1].seed, secondSeed);
  });
});

test('a view change while the command sample is pending prevents SDK effects', async () => {
  for (const change of ['navigation', 'configuration', 'close'] as const) await harness(async ({ frame, jobs, tick, open, setKey, configurationChanged }) => {
    const { document } = uiFixture(frame); await open(); jobs[0].resolve(result('Fixture result')); await settle();
    let mutations = 0;
    vm.runInContext('globalThis.MusicKit = {PlayerShuffleMode:{off:0},PlayerRepeatMode:{none:0},getInstance:()=>fixtureMusic}', frame.uiContext!);
    (frame.uiContext as Record<string, unknown>).fixtureMusic = { setQueue: async () => { mutations++; return {}; }, play: async () => { mutations++; } };
    let release!: () => void; frame.sampleHandler = () => new Promise<void>(resolve => { release = resolve; });
    document.click(document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'play/123456')!); await tick();
    if (change === 'navigation') { frame.url = 'https://music.apple.com/ar/library/artists'; frame.emit('did-navigate-in-page', {}, frame.url, true); }
    if (change === 'configuration') { setKey(fakeKey); configurationChanged(); }
    if (change === 'close') { frame.command = `close/${frame.latest.epoch}`; await tick(); }
    await settle(); release(); await settle(); assert.equal(mutations, 0);
  });
});

test('a playback response after navigation cannot update the newer view', async () => {
  await harness(async ({ frame, jobs, tick, open }) => {
    await open(); jobs[0].resolve(result('Fixture result')); await settle();
    let resolve!: (value: unknown) => void; frame.playbackHandler = () => new Promise(next => { resolve = next; });
    frame.command = `play/${frame.latest.epoch}/123456`; await tick(); assert.equal(frame.playbackCalls.length, 1);
    frame.url = 'https://music.apple.com/ar/library/artists'; frame.emit('did-navigate-in-page', {}, frame.url, true); await settle();
    const afterNavigation = frame.states.length; const epoch = frame.latest.epoch;
    resolve('requested'); await settle();
    assert.equal(frame.states.length, afterNavigation); assert.equal(frame.latest.epoch, epoch); assert.equal(frame.latest.open, false);
  });
});

test('a playback response after a mode change or retry cannot overwrite the newer list status', async () => {
  for (const control of ['mode/artist', 'retry']) await harness(async ({ frame, jobs, tick, open }) => {
    const { document } = uiFixture(frame); await open(); jobs[0].resolve(result('Original list')); await settle();
    let complete!: (value: unknown) => void; frame.playbackHandler = () => new Promise(resolve => { complete = resolve; });
    document.click(document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'play/123456')!); await tick();
    document.click(document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === control)!); await tick();
    assert.equal(jobs.length, 2); jobs[1].resolve(result('New list')); await settle();
    const before = frame.states.length; assert.equal('playback' in frame.latest, false);
    complete('requested'); await settle();
    assert.equal(frame.states.length, before); assert.equal(frame.latest.result.items[0].title, 'New list');
    assert.equal('playback' in frame.latest, false);
  });
});

test('one real result follow preserves Apple entry state and Back restores mode, partial list and scroll after playback changes', async () => {
  await harness(async ({ frame, jobs, tick }) => {
    const { document, entries, back } = uiFixture(frame); const origin = frame.getURL(); const player = document.player;
    entries[0].state = { apple: { index: 7, page: 'original' } };
    document.click(document.button); await tick();
    const artistMode = document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'mode/artist')!;
    document.click(artistMode); await tick(); const job = jobs[1];
    job.progress(result('Fixture result')); await settle();
    const sourceEpoch = frame.latest.epoch;
    document.getElementById('el-music-recommendation-panel')!.scrollTop = 321;
    const link = document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'item/123456')!;
    document.click(link); await settle();
    assert.equal(entries.length, 2); assert.deepEqual(entries[0].state, { apple: { index: 7, page: 'original' }, elMusicRecommendationReturn: sourceEpoch });
    assert.equal(frame.latest.open, false); assert.equal(job.signal.aborted, true); assert.equal(document.nav.dataset.recommendationReturnToken, sourceEpoch);
    assert.equal(document.nav.dataset.recommendationReturnDestination, result('Fixture result').items[0].url);
    frame.seed = secondSeed; await tick(); assert.equal(jobs.length, 2); assert.equal(frame.latest.open, false);
    job.progress(result('Late after departure')); job.resolve(result('Late final after departure')); await settle();
    back(); await tick();
    assert.equal(frame.getURL(), origin); assert.equal(entries.length, 2); assert.equal(frame.latest.open, true); assert.equal(frame.latest.busy, false);
    assert.equal(frame.latest.mode, 'artist'); assert.deepEqual(frame.latest.seed, firstSeed); assert.equal(frame.latest.result.items[0].title, 'Fixture result'); assert.equal(frame.latest.result.partial, true);
    assert.notEqual(frame.latest.epoch, sourceEpoch); assert.equal(document.getElementById('el-music-recommendation-panel')!.scrollTop, 321);
    assert.equal(document.player, player); assert.equal(jobs.length, 2); assert.equal(document.activeElement, document.body);
    await tick(); assert.deepEqual(frame.latest.seed, firstSeed); assert.equal(jobs.length, 2);
    document.click(document.button); await tick(); assert.equal(jobs.length, 3); assert.deepEqual(jobs[2].seed, secondSeed);
  });
});

test('Back requires a trusted popstate and explicit intent; visiting the old URL does not restore a list', async () => {
  for (const [intent, trusted] of [[false, true], [true, false]]) await harness(async ({ frame, jobs, tick }) => {
    const { document, back } = uiFixture(frame);
    document.click(document.button); await tick(); jobs[0].resolve(result('Fixture result')); await settle();
    document.click(document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'item/123456')!); await settle();
    assert.ok(document.nav.dataset.recommendationReturnToken); await tick();
    back(intent, trusted); await tick();
    assert.equal(frame.latest.open, false); assert.equal(document.getElementById('el-music-recommendation-panel'), undefined); assert.equal(jobs.length, 1);
  });
});

test('same destination and unsupported History state keep the list visible without adding an entry', async () => {
  for (const unsupported of [false, true]) await harness(async ({ frame, jobs, tick }) => {
    if (!unsupported) { frame.url = result('Fixture result').items[0].url + '?context=test#same-page'; frame.uiPresent = false; await tick(); }
    const { document, entries } = uiFixture(frame);
    if (unsupported) entries[0].state = 42; else document.nativeHeading.textContent = 'Fixture result';
    document.click(document.button); await tick(); jobs[0].resolve(result('Fixture result')); await settle();
    const panel = document.getElementById('el-music-recommendation-panel')!;
    document.click(document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'item/123456')!); await settle();
    assert.equal(entries.length, 1); assert.equal(document.getElementById('el-music-recommendation-panel'), panel); assert.equal(frame.latest.open, true);
    const alert = panel.descendants().find(item => item.getAttribute('role') === 'alert'); assert.ok(alert);
    assert.match(alert.textContent, unsupported ? /cannot be opened while preserving/ : /already open behind this list/);
    assert.equal(entries[0].state, unsupported ? 42 : null);
    assert.equal(document.nav.dataset.recommendationReturnToken, undefined);
  });
});

test('close, sidebar, country, configuration and document changes invalidate the saved list', async () => {
  for (const change of ['close', 'sidebar', 'country', 'configuration', 'document'] as const) await harness(async ({ frame, jobs, tick, setKey, configurationChanged }) => {
    const { document, back } = uiFixture(frame);
    document.click(document.button); await tick(); jobs[0].resolve(result('Fixture result')); await settle();
    document.click(document.documentElement.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'item/123456')!); await settle();
    const token = document.nav.dataset.recommendationReturnToken!; assert.ok(token);
    if (change === 'close') { frame.command = `close/${frame.latest.epoch}`; await tick(); }
    if (change === 'sidebar') { document.click(document.anchor); await tick(); }
    if (change === 'country') { frame.seed = { ...secondSeed, country: 'us' }; await tick(); }
    if (change === 'configuration') { setKey(fakeKey); configurationChanged(); await settle(); }
    if (change === 'document') { frame.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: frame.getURL() }); await settle(); }
    back(false); await settle(); frame.command = `restore/${frame.latest.epoch}/${token}`; await tick();
    assert.equal(frame.latest.open, false); assert.equal(document.getElementById('el-music-recommendation-panel'), undefined); assert.equal(jobs.length, 1);
  });
});
test('changing the observed seed cancels its job and rejects late progress and final results', async () => {
  await harness(async ({ frame, jobs, tick, open }) => {
    await open(); assert.equal(jobs.length, 1); assert.equal(jobs[0].seed.title, 'No');
    const first = jobs[0]; const beforeChange = frame.states.length;
    frame.seed = secondSeed; await tick();
    assert.equal(first.signal.aborted, true); assert.equal(jobs.length, 2); assert.equal(jobs[1].seed.title, 'Love Cry');
    first.progress(result('Obsolete progress')); first.resolve(result('Obsolete final')); await settle();
    assert.equal(frame.latest.seed?.title, 'Love Cry'); assert.ok(frame.states.slice(beforeChange).every(state => state.result.items.every(item => !item.title.startsWith('Obsolete'))));
    jobs[1].progress(result('Current progress')); await settle(); assert.equal(frame.latest.result.items[0].title, 'Current progress');
    jobs[1].resolve(result('Current final')); await settle(); assert.equal(frame.latest.result.items[0].title, 'Current final'); assert.equal(frame.latest.busy, false);
  });
});
test('closing recommendations aborts the outstanding job and late results cannot reopen the panel', async () => {
  await harness(async ({ frame, jobs, tick, open }) => {
    await open(); const job = jobs[0];
    frame.command = `close/${frame.latest.epoch}`; await tick(); const afterClose = frame.states.length;
    assert.equal(job.signal.aborted, true); assert.equal(frame.latest.open, false);
    job.progress(result('Closed progress')); job.resolve(result('Closed final')); await settle();
    assert.equal(frame.states.length, afterClose); assert.equal(frame.latest.open, false); assert.deepEqual(frame.latest.result.items, []);
  });
});
test('private key configuration callback cancels the old job and never renders the key or its late results', async () => {
  await harness(async ({ frame, jobs, open, setKey, configurationChanged, tick }) => {
    await open(); const first = jobs[0]; const previousEpoch = frame.latest.epoch;
    setKey(fakeKey); configurationChanged(); await settle();
    assert.equal(first.signal.aborted, true); assert.equal(jobs.length, 2); assert.equal(jobs[1].apiKey, fakeKey); assert.notEqual(frame.latest.epoch, previousEpoch);
    const afterChange = frame.states.length;
    first.progress(result('Old key progress')); first.resolve(result('Old key final')); await settle();
    assert.equal(frame.states.length, afterChange); assert.ok(frame.scripts.every(script => !script.includes(fakeKey)));
    jobs[1].resolve({ ...result('New configuration result'), lastFmConfigured: true }); await settle();
    assert.equal(frame.latest.result.items[0].title, 'New configuration result'); assert.equal(frame.latest.result.lastFmConfigured, true);
    await tick(); assert.equal(jobs.length, 2);
  });
});
test('retrying the same seed and epoch excludes the obsolete ticket even when its provider ignores abort', async () => {
  await harness(async ({ frame, jobs, open }) => {
    await open(); const first = jobs[0]; const sameEpoch = frame.latest.epoch;
    await open(); assert.equal(jobs.length, 2); assert.equal(frame.latest.epoch, sameEpoch); assert.equal(first.signal.aborted, true);
    const afterRetry = frame.states.length;
    first.progress(result('Superseded progress')); first.resolve(result('Superseded final')); await settle();
    assert.equal(frame.states.length, afterRetry); assert.equal(frame.latest.result.items.length, 0); assert.equal(frame.latest.busy, true);
    jobs[1].resolve(result('Retry result')); await settle(); assert.equal(frame.latest.result.items[0].title, 'Retry result'); assert.equal(frame.latest.busy, false);
  });
});
test('SPA sidebar navigation closes immediately without changing the playing seed or restarting its lookup', async () => {
  await harness(async ({ frame, jobs, open, tick }) => {
    await open(); const old = jobs[0]; const previousEpoch = frame.latest.epoch;
    frame.command = `open/${previousEpoch}/track`;
    frame.url = 'https://music.apple.com/ar/library/artists';
    frame.emit('did-start-navigation', {}, frame.url, true, true); await settle();
    assert.equal(old.signal.aborted, true); assert.equal(frame.latest.open, false); assert.equal(frame.latest.busy, false);
    assert.deepEqual(frame.latest.seed, firstSeed); assert.notEqual(frame.latest.epoch, previousEpoch);
    await tick(); assert.equal(jobs.length, 1); assert.equal(frame.latest.open, false);
    const afterNavigation = frame.states.length;
    old.progress(result('Previous page progress')); old.resolve(result('Previous page final')); await settle();
    assert.equal(frame.states.length, afterNavigation); assert.equal(frame.latest.result.items.length, 0);
    await open(); assert.equal(jobs.length, 2); assert.deepEqual(jobs[1].seed, firstSeed);
    jobs[1].resolve(result('Explicitly reopened result')); await settle(); assert.equal(frame.latest.result.items[0].title, 'Explicitly reopened result');
  });
});
test('same-document completion closes recommendations for history and playing-album routes', async () => {
  for (const url of ['https://music.apple.com/ar/new', 'https://music.apple.com/ar/library/artists', 'https://music.apple.com/ar/album/sirens/1740127233']) {
    await harness(async ({ frame, jobs, open, tick }) => {
      await open(); const old = jobs[0]; frame.url = url;
      frame.emit('did-navigate-in-page', {}, url, true); await settle();
      assert.equal(old.signal.aborted, true); assert.equal(frame.latest.open, false); assert.deepEqual(frame.latest.seed, firstSeed);
      const afterNavigation = frame.states.length;
      old.progress(result('Obsolete route progress')); old.resolve(result('Obsolete route final')); await settle();
      assert.equal(frame.states.length, afterNavigation); await tick(); assert.equal(jobs.length, 1); assert.equal(frame.latest.open, false);
    });
  }
});
test('subframe navigation does not close the musical panel; mainframe details do', async () => {
  await harness(async ({ frame, jobs, open }) => {
    await open(); const job = jobs[0]; const before = frame.states.length;
    frame.emit('did-start-navigation', { isMainFrame: false, isSameDocument: true }, 'https://music.apple.com/ar/other', true, false);
    frame.emit('did-navigate-in-page', {}, 'https://music.apple.com/ar/other', false); await settle();
    assert.equal(frame.states.length, before); assert.equal(frame.latest.open, true); assert.equal(job.signal.aborted, false);
    frame.url = 'https://music.apple.com/ar/library/artists';
    frame.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }, frame.url); await settle();
    assert.equal(frame.latest.open, false); assert.equal(job.signal.aborted, true);
    job.resolve(result('Obsolete subframe test result')); await settle();
  });
});
test('recreated discovery UI rebinds the same state without duplicate lookup or reopening after navigation', async () => {
  await harness(async ({ frame, jobs, open, tick }) => {
    await open(); const job = jobs[0]; const previousEpoch = frame.latest.epoch; const beforeRecreation = frame.states.length;
    frame.uiPresent = false; await tick();
    assert.equal(frame.states.length, beforeRecreation + 1); assert.equal(frame.latest.epoch, previousEpoch);
    assert.equal(frame.latest.open, true); assert.equal(frame.latest.busy, true); assert.equal(jobs.length, 1); assert.equal(job.signal.aborted, false);
    job.resolve(result('Preserved current result')); await settle();
    frame.uiPresent = false; await tick(); assert.equal(frame.latest.result.items[0].title, 'Preserved current result'); assert.equal(jobs.length, 1);
    frame.url = 'https://music.apple.com/ar/library/artists'; frame.emit('did-navigate-in-page', {}, frame.url, true); await settle();
    frame.uiPresent = false; await tick();
    assert.equal(frame.latest.open, false); assert.equal(jobs.length, 1); assert.equal(frame.latest.result.items.length, 0);
    assert.deepEqual(frame.latest.seed, firstSeed);
  });
});
test('original sidebar same-href click closes without router events, blocks pre-poll progress and binds once across nav recreation', async () => {
  await harness(async ({ frame, jobs, open, tick, configurationChanged }) => {
    const { document } = uiFixture(frame);
    const initialScript = frame.scripts.find(script => /const state =/.test(script))!;
    vm.runInContext(initialScript, frame.uiContext!); vm.runInContext(initialScript, frame.uiContext!);
    await open(); const job = jobs[0]; const originalUrl = frame.getURL();
    assert.ok(document.getElementById('el-music-recommendation-panel')); assert.equal(document.listeners.length, 1);
    assert.deepEqual(document.click(document.button), { prevented: 0, stopped: 0, originalHandled: true });
    assert.ok(document.getElementById('el-music-recommendation-panel'));
    const outcome = document.click(document.anchor);
    assert.deepEqual(outcome, { prevented: 0, stopped: 0, originalHandled: true }); assert.equal(frame.getURL(), originalUrl);
    assert.equal(document.getElementById('el-music-recommendation-panel'), undefined); assert.equal(job.signal.aborted, false);
    assert.equal(frame.command, `close/${frame.latest.epoch}`);
    job.progress(result('Pre-poll late progress')); await settle();
    assert.equal(document.getElementById('el-music-recommendation-panel'), undefined); assert.equal(document.button.getAttribute('aria-expanded'), 'false');
    const beforePoll = frame.states.length; frame.seed = secondSeed; frame.uiPresent = false; await tick();
    assert.equal(job.signal.aborted, true); assert.equal(jobs.length, 1); assert.equal(frame.latest.open, false);
    assert.ok(frame.states.slice(beforePoll).every(state => !state.open)); assert.deepEqual(frame.latest.seed, secondSeed);
    job.resolve(result('Post-poll late final')); await settle(); assert.equal(document.getElementById('el-music-recommendation-panel'), undefined);
    const detachedNav = document.nav; document.replaceNavigation(); configurationChanged(); await settle();
    assert.equal(document.listeners.length, 1); assert.equal(document.nav.dataset.recommendationEpoch, frame.latest.epoch);
    const panel = document.createElement('section'); panel.id = 'el-music-recommendation-panel'; document.body.appendChild(panel);
    document.click(document.anchor);
    assert.equal(document.nav.dataset.recommendationRequest, `close/${frame.latest.epoch}`); assert.equal(detachedNav.dataset.recommendationRequest, undefined);
    assert.equal(document.getElementById('el-music-recommendation-panel'), undefined); await tick(); assert.equal(jobs.length, 1);
  });
});

test('now playing matches the LCD title, artist and album only when unambiguous', () => {
  const items = [
    { id: '1', title: 'Quest', artist: 'Nosaj Thing', album: 'Drift' },
    { id: '2', title: 'Quest', artist: 'Nosaj Thing', album: 'Home' },
    { id: '3', title: 'Fog', artist: 'Nosaj Thing & Guest', album: 'Drift' }
  ];
  const seed = (title: string, artist: string, album: string): RecommendationSeed => ({ title, artist, album, country: 'ar' });
  assert.equal(recommendationNowPlaying(items, undefined), undefined);
  assert.equal(recommendationNowPlaying(items, seed('quest ', 'Nosaj  Thing', 'Home')), '2');
  assert.equal(recommendationNowPlaying(items, seed('Quest', 'Nosaj Thing', '')), undefined);
  assert.equal(recommendationNowPlaying(items, seed('Fog', 'Nosaj Thing', 'Other')), '3');
  assert.equal(recommendationNowPlaying(items, seed('Fog', 'Nosaj', 'Drift')), undefined);
});

test('the Related row playing in the LCD is marked and follows native queue advance without rebuilding the list', async () => {
  await harness(async ({ frame, jobs, tick, open }) => {
    const { document } = uiFixture(frame); await open(); jobs[0].resolve(progressiveResult(3)); await settle();
    const panel = document.getElementById('el-music-recommendation-panel')!;
    const rows = panel.querySelectorAll('.el-music-recommendation-card');
    const current = (): number[] => rows.map((row, index) => row.getAttribute('aria-current') === 'true' ? index : -1).filter(index => index >= 0);
    const status = (): string => panel.descendants().find(item => item.className === 'el-music-recommendation-status')!.textContent;
    assert.deepEqual(current(), []);
    frame.playbackHandler = async () => 'requested';
    document.click(panel.descendants().find(item => item.dataset.elMusicRecommendationFocus === 'play/123457')!); await tick();
    frame.seed = { title: 'Song 1', artist: 'Fixture artist', album: 'Fixture album', country: 'ar' }; await tick();
    assert.deepEqual(current(), [1]); assert.equal(status(), 'Now playing: Song 1 · Fixture artist');
    assert.ok(rows[1].descendants().some(item => item.textContent === 'Now playing · ListenBrainz'));
    frame.seed = { title: 'Song 2', artist: 'Fixture artist', album: 'Fixture album', country: 'ar' }; await tick();
    assert.deepEqual(current(), [2]); assert.deepEqual(panel.querySelectorAll('.el-music-recommendation-card'), rows);
    assert.equal(jobs.length, 1); assert.deepEqual(frame.latest.seed, firstSeed);
    frame.seed = secondSeed; await tick(); assert.deepEqual(current(), []); assert.equal(status(), 'Playback requested.');
  });
});
