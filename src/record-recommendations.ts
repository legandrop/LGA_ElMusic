import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { isMusicPage } from './music-shell';
import { playerSample, playerSampleScript } from './player';
import { musicLinkFunctionScript } from './music-navigation';
import { appleArtworkUrl, recommendations } from './recommendations';
import { recommendationPlayback, recommendationPlaybackScript, recommendationQueue } from './recommendation-playback';
import type { RecommendationPlayback } from './recommendation-playback';
import { recommendationLimits } from './recommendation-types';
import type { RecommendationMode, RecommendationResult, RecommendationSeed } from './recommendation-types';

interface State {
  epoch: string; seed?: RecommendationSeed; mode: RecommendationMode; open: boolean;
  busy: boolean; focusOnOpen: boolean; result: RecommendationResult;
  returnToken?: string; returnDestination?: string; restoreScroll?: number; pageUrl?: string; revision?: number;
  playback?: RecommendationPlayback | 'loading'; playingId?: string;
}
interface SavedList {
  token: string; origin: string; destination: string; country: string; configuration: number;
  seed: RecommendationSeed; mode: RecommendationMode; result: RecommendationResult; scroll: number;
  relatedContext: boolean;
}
type Request = { action: 'open'; mode: RecommendationMode } | { action: 'close' } |
  { action: 'follow'; id: string; kind: 'song' | 'artist' | 'album'; scroll: number } | { action: 'restore'; token: string } | { action: 'play'; id: string };
const empty = (): RecommendationResult => ({ items: [], experimental: true, partial: true,
  lastFmConfigured: false, artistFallback: false, rejected: 0, unresolved: 0, providerUnavailable: false });
const requestWakeMessage = 'elMusic.recommendations.request-ready';
export function recommendationMatchFields(value: unknown): Record<string, boolean | number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const count = (field: string, maximum: number): boolean => Number.isInteger(row[field]) && (row[field] as number) >= 0 && (row[field] as number) <= maximum;
  const milliseconds = (field: string): boolean => typeof row[field] === 'number' && Number.isFinite(row[field]) && row[field] > 0 && row[field] <= 86400000;
  if (!count('candidateIndex', 47) || typeof row.hasMbid !== 'boolean' || ![0, 1].includes(row.durationSource as number) || ![0, 1].includes(row.selectionPolicy as number) || ![0, 1, 2].includes(row.status as number) ||
    !['rowCount', 'exactRowCount', 'versionSafeRowCount', 'durationRowCount'].every(field => count(field, 10000)) ||
    (row.exactRowCount as number) > (row.rowCount as number) || (row.versionSafeRowCount as number) > (row.exactRowCount as number) || (row.durationRowCount as number) > (row.versionSafeRowCount as number) ||
    (row.durationSource === 1 ? row.hasMbid !== true || !milliseconds('mbDurationMs') : row.mbDurationMs !== undefined) ||
    (row.minAppleDurationMs !== undefined || row.maxAppleDurationMs !== undefined) && (!milliseconds('minAppleDurationMs') || !milliseconds('maxAppleDurationMs') || (row.minAppleDurationMs as number) > (row.maxAppleDurationMs as number) || row.exactRowCount === 0) ||
    row.status !== 0 && row.durationRowCount === 0 && (row.selectionPolicy !== 1 || row.versionSafeRowCount === 0)) return;
  const fields: Record<string, boolean | number> = {};
  for (const field of ['candidateIndex', 'hasMbid', 'durationSource', 'mbDurationMs', 'rowCount', 'exactRowCount', 'versionSafeRowCount', 'durationRowCount', 'minAppleDurationMs', 'maxAppleDurationMs', 'status', 'selectionPolicy']) {
    if (row[field] !== undefined) fields[field] = row[field] as boolean | number;
  }
  return fields;
}
export function recommendationRequest(value: unknown, epoch: string): Request | undefined {
  if (typeof value !== 'string' || value.length >= 128) return;
  if (value === `close/${epoch}`) return { action: 'close' };
  const parts = value.split('/');
  if (parts.length === 3 && parts[0] === 'play' && parts[1] === epoch && /^\d{1,20}$/.test(parts[2])) return { action: 'play', id: parts[2] };
  if (parts.length === 3 && parts[0] === 'open' && parts[1] === epoch && ['track', 'artist'].includes(parts[2])) return { action: 'open', mode: parts[2] as RecommendationMode };
  if (parts.length === 4 && parts[0] === 'follow' && parts[1] === epoch && /^\d{1,20}$/.test(parts[2]) && /^(0|[1-9]\d{0,6})$/.test(parts[3]) && Number(parts[3]) <= 1000000)
    return { action: 'follow', id: parts[2], kind: 'song', scroll: Number(parts[3]) };
  if (parts.length === 5 && parts[0] === 'follow' && parts[1] === epoch && ['song', 'artist', 'album'].includes(parts[2]) &&
    /^\d{1,20}$/.test(parts[3]) && /^(0|[1-9]\d{0,6})$/.test(parts[4]) && Number(parts[4]) <= 1000000)
    return { action: 'follow', id: parts[3], kind: parts[2] as 'song' | 'artist' | 'album', scroll: Number(parts[4]) };
  if (parts.length === 3 && parts[0] === 'restore' && parts[1] === epoch && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parts[2]))
    return { action: 'restore', token: parts[2] };
  return;
}
// Fila que suena según el LCD público (título, artista y álbum); sin leer el SDK. Ambiguo → ninguna.
export function recommendationNowPlaying(items: readonly { id: string; title: string; artist: string; album: string }[], playing?: RecommendationSeed): string | undefined {
  if (!playing) return;
  const clean = (value: string): string => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const title = clean(playing.title), artist = clean(playing.artist), album = clean(playing.album);
  const matches = items.filter(item => clean(item.title) === title &&
    (clean(item.artist) === artist || clean(item.artist).split(/\s*(?:,|&|\band\b)\s*/).includes(artist)));
  const byAlbum = matches.length > 1 && album ? matches.filter(item => clean(item.album) === album) : matches;
  return byAlbum.length === 1 ? byAlbum[0].id : undefined;
}
function uiScript(state: State): string {
  state = { ...state, result: { ...state.result, items: state.result.items.map(item => ({ ...item, artworkUrl: appleArtworkUrl(item.artworkUrl) })),
    cards: state.result.cards?.map(card => ({ ...card, artworkUrl: appleArtworkUrl(card.artworkUrl) })) } };
  return `(() => {
    if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return false;
    const state = ${JSON.stringify(state)};
    const nav = document.getElementById('el-music-navigation'), button = document.getElementById('el-music-open-recommendations');
    if (!nav || !button) return false;
    if (state.pageUrl && location.href !== state.pageUrl || Number(nav.dataset.recommendationRevision || 0) > state.revision) return false;
    nav.dataset.recommendationRevision = String(state.revision || 0);
    if (nav.dataset.recommendationWakeBound !== 'true') {
      nav.dataset.recommendationWakeBound = 'true';
      new MutationObserver(() => {
        const request = nav.dataset.recommendationRequest;
        if (typeof request === 'string' && request && request.length < 128) console.debug(${JSON.stringify(requestWakeMessage)});
      }).observe(nav, { attributes: true, attributeFilter: ['data-recommendation-request'] });
    }
    nav.dataset.recommendationEpoch = state.epoch; button.dataset.recommendationEpoch = state.epoch;
    if (state.returnToken && state.returnDestination) {
      nav.dataset.recommendationReturnToken = state.returnToken; nav.dataset.recommendationReturnDestination = state.returnDestination;
    } else {
      delete nav.dataset.recommendationReturnToken; delete nav.dataset.recommendationReturnDestination; delete nav.dataset.recommendationBackIntent;
    }
    if (document.documentElement.dataset.elMusicRecommendationsSidebarBound !== 'true') {
      document.documentElement.dataset.elMusicRecommendationsSidebarBound = 'true';
      document.addEventListener('click', event => {
        if (!(event.target instanceof Element) || !event.target.closest('.navigation a')) return;
        const currentNav = document.getElementById('el-music-navigation'), epoch = currentNav?.dataset.recommendationEpoch;
        if (!currentNav || typeof epoch !== 'string' || !epoch || epoch.length >= 128) return;
        document.getElementById('el-music-recommendation-panel')?.remove();
        currentNav.dataset.recommendationRequest = 'close/' + epoch;
        delete currentNav.dataset.recommendationReturnToken; delete currentNav.dataset.recommendationReturnDestination; delete currentNav.dataset.recommendationBackIntent;
      }, true);
      addEventListener('popstate', event => {
        if (!event.isTrusted) return;
        const currentNav = document.getElementById('el-music-navigation'), token = event.state?.elMusicRecommendationReturn;
        if (currentNav && typeof token === 'string' && token === currentNav.dataset.recommendationReturnToken && token === currentNav.dataset.recommendationBackIntent)
          currentNav.dataset.recommendationRequest = 'restore/' + currentNav.dataset.recommendationEpoch + '/' + token;
        if (currentNav) delete currentNav.dataset.recommendationBackIntent;
      });
    }
    button.disabled = !state.seed;
    button.title = state.seed ? 'Find music related to the current track or artist' : 'Select a song to find related music';
    button.setAttribute('aria-expanded', String(state.open));
    button.onclick = event => {
      if (event.detail > 0) button.blur();
      nav.dataset.recommendationKeyboardOpen = event.detail === 0 ? state.epoch : '';
      delete nav.dataset.recommendationNavigationIssue;
      document.querySelector('#el-music-label-panel:not(.el-music-panel--parked) [data-close-labels]')?.click();
      nav.dataset.recommendationRequest = 'open/' + state.epoch + '/track';
    };
    if (nav.dataset.recommendationRequest === 'close/' + state.epoch) {
      document.getElementById('el-music-recommendation-panel')?.remove();
      button.setAttribute('aria-expanded', 'false');
      return true;
    }
    const focused = document.activeElement;
    const focusKey = focused?.matches(':focus-visible') ? focused.dataset?.elMusicRecommendationFocus : undefined;
    let panel = document.getElementById('el-music-recommendation-panel');
    const scroll = panel?.scrollTop || 0;
    if (!state.open || !state.seed) { panel?.remove(); return true; }
    if (panel && panel.dataset.recommendationEpoch !== state.epoch) { panel.remove(); panel = undefined; }
    ${musicLinkFunctionScript}
    const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
    const part = (parent, key, tag, className) => {
      let element = parent.querySelector('[data-el-music-part="' + key + '"]');
      if (!element) { element = document.createElement(tag); element.dataset.elMusicPart = key; element.className = className || ''; parent.appendChild(element); }
      return element;
    };
    if (!panel) {
      panel = document.createElement('section'); panel.id = 'el-music-recommendation-panel';
      panel.dataset.recommendationEpoch = state.epoch; panel.className = 'el-music-discovery-panel';
      panel.setAttribute('aria-label', 'Related music'); document.body.appendChild(panel);
    }
    const header = part(panel, 'header', 'header', 'el-music-discovery-header');
    // Cierre sin botón a la vista: Back propio y Alt+Left lo usan (Back ya vuelve a donde se estaba).
    const close = part(header, 'close', 'button', 'el-music-recommendation-close'); close.type = 'button'; text(close, 'Close'); close.hidden = true; close.tabIndex = -1; close.setAttribute('aria-hidden', 'true');
    close.dataset.closeRecommendations = 'true'; close.dataset.elMusicRecommendationFocus = 'close';
    close.onclick = event => { panel.remove(); button.setAttribute('aria-expanded', 'false'); if (event.detail === 0) button.focus(); nav.dataset.recommendationRequest = 'close/' + state.epoch; };
    const heading = part(header, 'heading', 'h1'); text(heading, 'Related music'); heading.tabIndex = -1; heading.dataset.elMusicRecommendationFocus = 'heading';
    const seed = part(header, 'seed', 'p', 'el-music-recommendation-seed');
    text(part(seed, 'title', 'span'), state.seed.title + ' · '); text(part(seed, 'artist', 'span', 'el-music-recommendation-seed-artist'), state.seed.artist);
    const modes = part(header, 'modes', 'div', 'el-music-recommendation-modes'); modes.setAttribute('aria-label', 'Recommendation basis');
    for (const [mode, title] of [['track', 'This track'], ['artist', 'This artist']]) {
      const option = part(modes, mode, 'button'); option.type = 'button'; text(option, title);
      option.setAttribute('aria-pressed', String(state.mode === mode)); option.dataset.elMusicRecommendationFocus = 'mode/' + mode;
      option.onclick = event => { if (event.detail > 0) option.blur(); delete nav.dataset.recommendationNavigationIssue; nav.dataset.recommendationRequest = 'open/' + state.epoch + '/' + mode; };
    }
    const cards = state.result.cards || state.result.items.map(item => ({ ...item, key: item.candidateKey || item.id, verificationStatus: 'verified', verifiedId: item.id }));
    const trackCards = cards.some(card => card.signal === 'track'), artistCards = cards.some(card => card.signal === 'artist');
    const note = part(header, 'note', 'p', 'el-music-recommendation-note');
    text(note, (state.mode === 'artist' ? 'Based on the artist' : trackCards && artistCards ? 'Track and artist matches' : artistCards ? 'Track matches unavailable · Showing artist matches' : trackCards || !state.busy ? 'Based on the track' : 'Finding related music…') + ' · Apple Music ' + state.seed.country.toUpperCase() + ' · Editions may differ');
    const status = part(header, 'status', 'p', 'el-music-recommendation-status');
    status.setAttribute('role', state.result.providerUnavailable && !state.busy ? 'alert' : 'status'); status.setAttribute('aria-live', 'polite');
    const checked = cards.filter(card => card.verificationStatus === 'verified' || card.verificationStatus === 'unavailable' && card.reason !== 'limit').length;
    text(status, state.busy ? cards.length ? 'Checking Apple Music matches · ' + checked + ' of ' + cards.length + ' checked · ' + state.result.items.length + ' ready to play' : 'Finding related music…' : state.result.items.length ? state.result.items.length + ' songs ready to play' : state.result.providerUnavailable ? 'Music services could not be reached. Try Find again.' : state.result.emptyReason === 'unresolved-seed' ? 'This artist could not be identified. Try the other mode.' : state.result.emptyReason === 'no-candidates' ? 'No related music was found. Try the other mode.' : 'No Apple Music matches are ready. Try Find again.');
    if (state.playback && (state.playback !== 'requested' || !state.busy)) {
      status.setAttribute('role', ['failed', 'unavailable', 'view-changed'].includes(state.playback) ? 'alert' : 'status');
      text(status, state.playback === 'loading' ? 'Preparing the related songs…' : state.playback === 'requested' ? 'Playback requested.' : state.playback === 'busy' ? 'A queue request is still finishing. Try Play again afterward.' : state.playback === 'view-changed' ? 'This view changed before playback started. Choose a song again.' : state.playback === 'unavailable' ? 'Direct playback is unavailable on this page.' : 'Playback could not be started. Try Play again.');
    }
    const playingItem = state.playingId ? state.result.items.find(item => item.id === state.playingId) : undefined;
    if (playingItem && !state.busy && (!state.playback || state.playback === 'requested')) {
      status.setAttribute('role', 'status'); text(status, 'Now playing: ' + playingItem.title + ' · ' + playingItem.artist);
    }
    if (nav.dataset.recommendationNavigationIssue === 'already-open/' + state.epoch || nav.dataset.recommendationNavigationIssue === 'history-unavailable/' + state.epoch) {
      status.setAttribute('role', 'alert'); text(status, nav.dataset.recommendationNavigationIssue.startsWith('already-open/') ? 'This page is already open behind this list. Use Back to view it.' : 'This page cannot be opened while preserving this list. Try again.');
    }
    const list = part(panel, 'list', 'ul', 'el-music-recommendation-list'); list.setAttribute('aria-label', 'Related songs');
    const keys = new Set(); const playable = new Set();
    const appleLink = (value, kind) => {
      try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'music.apple.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && new RegExp('^/' + state.seed.country + '/' + kind + '/(?:[^/]+/)?[0-9]{1,20}/?$').test(url.pathname) ? url.href : undefined; } catch { return undefined; }
    };
    const bindLink = (link, url, title, item, kind) => {
      if (link.dataset.elMusicUrl && link.dataset.elMusicUrl !== url) {
        const replacement = document.createElement('a'); replacement.className = link.className; replacement.textContent = link.textContent;
        replacement.dataset.elMusicPart = link.dataset.elMusicPart; replacement.dataset.elMusicRecommendationFocus = link.dataset.elMusicRecommendationFocus;
        link.parentElement.replaceChild(replacement, link); link = replacement;
      }
      if (!url || link.dataset.elMusicUrl === url) return link;
      link.dataset.elMusicUrl = url;
      musicLink(link, url, title, () => {
        panel.remove(); if (!nav.dataset.recommendationRequest?.startsWith('follow/' + state.epoch + '/')) nav.dataset.recommendationRequest = 'close/' + state.epoch;
      }, () => {
        const entry = history.state, target = new URL(url);
        const issue = location.origin === target.origin && location.pathname === target.pathname ? 'already-open' : entry !== null && Object.prototype.toString.call(entry) !== '[object Object]' ? 'history-unavailable' : undefined;
        if (issue) { nav.dataset.recommendationNavigationIssue = issue + '/' + state.epoch; status.setAttribute('role', 'alert'); text(status, issue === 'already-open' ? 'This page is already open behind this list. Use Back to view it.' : 'This page cannot be opened while preserving this list. Try again.'); return false; }
        try { history.replaceState({ ...entry, elMusicRecommendationReturn: state.epoch }, '', location.href); }
        catch { nav.dataset.recommendationNavigationIssue = 'history-unavailable/' + state.epoch; status.setAttribute('role', 'alert'); text(status, 'This page cannot be opened while preserving this list. Try again.'); return false; }
        nav.dataset.recommendationRequest = 'follow/' + state.epoch + '/' + kind + '/' + item.id + '/' + Math.max(0, Math.min(1000000, Math.trunc(panel.scrollTop)));
        return true;
      });
      return link;
    };
    for (const [index, card] of cards.entries()) {
      if (keys.has(card.key)) continue; keys.add(card.key);
      const item = card.verificationStatus === 'verified' ? state.result.items.find(item => item.id === card.verifiedId) : undefined;
      const canPlay = !!item && !playable.has(item.id); if (canPlay) playable.add(item.id);
      let row = [...list.children].find(row => row.dataset.recommendationKey === card.key);
      if (!row) { row = document.createElement('li'); row.className = 'el-music-recommendation-card'; row.dataset.recommendationKey = card.key; list.appendChild(row); }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      if (canPlay) row.dataset.elMusicRecommendationId = item.id; else delete row.dataset.elMusicRecommendationId;
      const playing = !!item && canPlay && item.id === state.playingId;
      const signature = JSON.stringify([card,item,state.busy,state.playback,playing,!!document.documentElement.dataset.elMusicRecommendationQueueBusy]);
      if (row.dataset.recommendationSignature === signature) continue; row.dataset.recommendationSignature = signature;
      row.setAttribute('aria-current', String(playing));
      const info = item || card;
      const cover = part(row, 'cover', 'div', 'el-music-recommendation-cover'); cover.setAttribute('aria-hidden', 'true');
      part(cover, 'placeholder', 'span');
      const artwork = info.artworkUrl;
      let image = cover.querySelector('img');
      if (artwork && !image) { image = document.createElement('img'); image.alt = ''; image.referrerPolicy = 'no-referrer'; image.loading = 'lazy'; image.onerror = () => image.remove(); cover.appendChild(image); }
      if (image && image.getAttribute('src') !== artwork) { if (artwork) image.src = artwork; else image.remove(); }
      const metadata = part(row, 'metadata', 'div', 'el-music-recommendation-metadata');
      const title = part(metadata, 'title', 'button', 'el-music-recommendation-title'); title.type = 'button'; text(title, info.title); title.dataset.elMusicRecommendationFocus = 'title/' + card.key;
      const artist = part(metadata, 'artist', 'p', 'el-music-recommendation-byline'); text(part(artist, 'label', 'span'), 'Artist: ');
      const artistLink = part(artist, 'value', 'a'); text(artistLink, info.artist); artistLink.dataset.elMusicRecommendationFocus = 'artist/' + card.key;
      const album = part(metadata, 'album', 'p', 'el-music-recommendation-byline'); text(part(album, 'label', 'span'), 'Album: ');
      const albumLink = part(album, 'value', 'a'); text(albumLink, info.album || 'Unknown album'); albumLink.dataset.elMusicRecommendationFocus = 'album/' + card.key;
      bindLink(artistLink, item && appleLink(item.artistUrl, 'artist'), info.artist, item, 'artist'); bindLink(albumLink, item && appleLink(item.albumUrl, 'album'), info.album, item, 'album');
      const reason = part(metadata, 'reason', 'small', 'el-music-recommendation-reason');
      text(reason, card.verificationStatus === 'verified' ? (playing ? 'Now playing · ' : '') + info.source : card.verificationStatus === 'unavailable' ? card.reason === 'ambiguous' ? 'Edition could not be confirmed' : card.reason === 'provider-unavailable' ? 'Apple Music could not be reached' : card.reason === 'limit' ? 'Not checked · Find again to continue' : card.reason === 'duplicate' ? 'Already listed above' : 'No confirmed Apple Music match' : state.busy ? card.verificationStatus === 'checking' ? 'Checking Apple Music…' : 'Waiting to check Apple Music' : 'Not checked yet');
      const actions = part(row, 'actions', 'div', 'el-music-recommendation-actions');
      const play = part(actions, 'play', 'button', 'el-music-recommendation-play'); play.type = 'button'; text(play, 'Play'); play.title = 'Play ' + info.title; play.setAttribute('aria-label', play.title);
      play.dataset.elMusicRecommendationFocus = 'play/' + (item?.id || card.key);
      if (canPlay) { play.dataset.elMusicRecommendationPlay = 'true'; title.dataset.elMusicRecommendationPlay = 'true'; }
      else { delete play.dataset.elMusicRecommendationPlay; delete title.dataset.elMusicRecommendationPlay; }
      play.disabled = title.disabled = !canPlay || state.playback === 'loading' || !!document.documentElement.dataset.elMusicRecommendationQueueBusy;
      const requestPlay = event => {
        if (!event.isTrusted || play.disabled || !item) return;
        if (event.detail > 0) event.currentTarget?.blur();
        for (const control of panel.querySelectorAll('[data-el-music-recommendation-play]')) control.disabled = true;
        // Aviso inmediato en el LCD con la canción pedida; se cierra cuando Apple reacciona o si el pedido no prospera.
        if (typeof CustomEvent === 'function') dispatchEvent(new CustomEvent('el-music:pending-play', { detail: { song: info.title, artist: info.artist, album: info.album, source: 'related' } }));
        text(status, 'Preparing the related songs…'); nav.dataset.recommendationRequest = 'play/' + state.epoch + '/' + item.id;
      };
      play.onclick = requestPlay; title.onclick = requestPlay;
      let link = part(actions, 'song', 'a', 'el-music-recommendation-details'); text(link, 'View song'); link.dataset.elMusicRecommendationFocus = 'item/' + (item?.id || card.key);
      link = bindLink(link, item && appleLink(item.url, 'song'), info.title, item, 'song');
      link.hidden = !item;
    }
    for (const row of [...list.children]) if (!keys.has(row.dataset.recommendationKey)) row.remove();
    const footer = part(panel, 'footer', 'footer', 'el-music-discovery-footer');
    const sourceNames = ['Apple Music', 'ListenBrainz', 'Last.fm'].filter(source => cards.some(card => card.source === source) || state.result.items.some(item => item.source === source));
    const sourceLabel = sourceNames.map(source => source === 'ListenBrainz' ? 'ListenBrainz · Experimental' : source === 'Apple Music' ? 'Apple Music · Public catalog' : source).join(' · ');
    const sources = part(footer, 'sources', 'p', 'el-music-recommendation-note'); text(sources, (sourceLabel ? sourceLabel + ' · ' : '') + 'Matches use public metadata');
    const retry = part(footer, 'retry', 'button', 'el-music-recommendation-retry'); retry.type = 'button'; text(retry, 'Find again'); retry.dataset.elMusicRecommendationFocus = 'retry'; retry.disabled = state.busy;
    retry.onclick = event => { if (event.detail > 0) retry.blur(); delete nav.dataset.recommendationNavigationIssue; nav.dataset.recommendationRequest = 'open/' + state.epoch + '/' + state.mode; };
    if (state.restoreScroll !== undefined) panel.scrollTop = state.restoreScroll; else if (panel.scrollTop !== scroll) panel.scrollTop = scroll;
    if (focusKey && (!focused?.isConnected || document.activeElement !== focused)) ([...panel.querySelectorAll('[data-el-music-recommendation-focus]')].find(element => element.dataset.elMusicRecommendationFocus === focusKey) || heading).focus();
    else if (state.focusOnOpen && nav.dataset.recommendationKeyboardOpen && (nav.dataset.recommendationKeyboardOpen === state.epoch || nav.dataset.recommendationRequest?.startsWith('open/' + nav.dataset.recommendationKeyboardOpen + '/'))) heading.focus();
    delete nav.dataset.recommendationKeyboardOpen;
    return true;

  })()`;
}

export function installRecordRecommendations(contents: WebContents, getApiKey: () => string | undefined,
  onFailure: () => void, diagnostic?: (event: string, fields: Record<string, boolean | number>) => void): () => void {
  let state: State = { epoch: randomUUID(), mode: 'track', open: false, busy: false, focusOnOpen: false, result: empty() };
  let seedKey = ''; let lastKey: string | undefined; let stopped = false; let polling = false; let rendered = false;
  let request = new AbortController(); let ticket = 0;
  let relatedContext = false; let playing: RecommendationSeed | undefined;
  let saved: SavedList | undefined; let panelUrl = ''; let configuration = 0; let capture = 0; let captureDestination: string | undefined; let revision = 0;
  const forgetList = (): void => { saved = undefined; captureDestination = undefined; capture++; };
  const render = async (): Promise<void> => {
    if (stopped || contents.isDestroyed() || !isMusicPage(contents.getURL())) return;
    // El estado recibe el progreso; el DOM conserva los IDs que valida el comando SDK en vuelo.
    if (state.open && state.playback === 'loading') return;
    if (state.open) panelUrl = contents.getURL();
    rendered = await contents.mainFrame.executeJavaScript(uiScript({ ...state, playingId: recommendationNowPlaying(state.result.items, playing),
      returnToken: saved?.token, returnDestination: saved?.destination,
      pageUrl: contents.getURL(), revision: ++revision })).catch(() => { onFailure(); return false; }) === true;
    state.focusOnOpen = false; delete state.restoreScroll;
  };
  const stopRequest = (): void => { request.abort(); request = new AbortController(); ticket++; };
  const run = async (mode: RecommendationMode): Promise<void> => {
    if (!state.seed) return;
    forgetList(); relatedContext = false; delete state.playback;
    stopRequest(); const mine = ticket; const epoch = state.epoch; const apiKey = getApiKey();
    const seed = state.seed; const signal = request.signal;
    const current = (): boolean => !stopped && !contents.isDestroyed() && ticket === mine && state.epoch === epoch && state.open && isMusicPage(contents.getURL()) && getApiKey() === apiKey;
    state.mode = mode; state.focusOnOpen = !state.open; state.open = true; state.busy = true; state.result = empty();
    state.result.lastFmConfigured = !!apiKey; await render();
    if (!current()) return;
    const accept = async (result: RecommendationResult): Promise<void> => {
      if (current() && JSON.stringify(state.result) !== JSON.stringify(result)) { state.result = result; await render(); }
    };
    try {
      const result = await recommendations(seed, mode, signal, progress => { void accept(progress); }, apiKey, event => {
        if (!current()) return;
        diagnostic?.('Recomendaciones: ' + event.provider + ' · ' + event.stage + ' · ' + event.outcome + ' (' + event.failure + ')',
          { intento: event.attempt, ...(event.httpStatus === undefined ? {} : { estadoHTTP: event.httpStatus }) });
      }, event => {
        if (!current() || signal.aborted) return;
        const fields = recommendationMatchFields(event);
        if (fields) { try { diagnostic?.('Recomendaciones: selección de catálogo', fields); } catch { /* Sin efectos sobre el proveedor. */ } }
      });
      if (!current()) return; state.result = result;
      diagnostic?.('Recomendaciones completadas', { resultCount: result.items.length, rejected: result.rejected, unresolved: result.unresolved,
        providerUnavailable: result.providerUnavailable, artistFallback: result.artistFallback, lastFmConfigured: result.lastFmConfigured });
    } catch { if (current()) { state.result.providerUnavailable = true; onFailure(); } }
    finally { if (current()) { state.busy = false; await render(); } }
  };
  const play = async (id: string): Promise<void> => {
    if (!state.open || state.playback === 'loading') return;
    const songs = recommendationQueue(state.result.items, id, recommendationLimits.queue);
    if (!songs) return;
    const epoch = state.epoch; const key = getApiKey(); const origin = contents.getURL();
    // Mantener el panel original: el comando SDK valida su identidad hasta terminar setQueue.
    relatedContext = true; state.playback = 'loading';
    const mine = ticket;
    const current = (): boolean => !stopped && !contents.isDestroyed() && ticket === mine && state.open && state.epoch === epoch && getApiKey() === key && contents.getURL() === origin && isMusicPage(origin);
    if (!current()) return;
    const value = await contents.mainFrame.executeJavaScript(recommendationPlaybackScript(epoch, songs), true).catch(() => 'failed');
    if (!current()) return;
    state.playback = recommendationPlayback(value); await render();
    diagnostic?.('Solicitud de reproducción Related music', { cantidad: songs.length, solicitada: state.playback === 'requested' });
  };
  const reset = (): void => { forgetList(); relatedContext = false; stopRequest(); seedKey = ''; rendered = false; state = { epoch: randomUUID(), mode: 'track', open: false, busy: false, focusOnOpen: false, result: empty() }; };
  const closeForNavigation = (destination = contents.getURL(), verifiedSameUrl = false): void => {
    if (stopped || contents.isDestroyed()) return;
    if (state.open && destination === panelUrl && !verifiedSameUrl) {
      const epoch = state.epoch;
      // replaceState marca la entrada sin salir; la navegación del enlace llegará después.
      void contents.mainFrame.executeJavaScript(playerSampleScript).then(value => {
        if (state.open && state.epoch === epoch && recommendationRequest(playerSample(value)?.recommendationRequest, epoch)?.action !== 'follow') closeForNavigation(destination, true);
      }).catch(onFailure);
      return;
    }
    // Back mantiene el epoch cerrado hasta que popstate entregue su intención validada.
    if (!state.open && (captureDestination === destination || saved && (destination === saved.origin || destination === saved.destination))) { void render(); return; }
    const departing = state.open && state.seed ? {
      token: state.epoch, origin: panelUrl, country: state.seed.country, configuration,
      seed: { ...state.seed }, mode: state.mode, result: structuredClone({ ...state.result, items: state.result.items.slice(0, recommendationLimits.verified) }), relatedContext
    } : undefined;
    forgetList(); const mine = capture;
    if (departing) captureDestination = destination;
    stopRequest(); relatedContext = false; delete state.playback; state.epoch = randomUUID(); state.open = false; state.busy = false; state.focusOnOpen = false; state.result = empty();
    if (!departing) { void render(); return; }
    void contents.mainFrame.executeJavaScript(playerSampleScript).then(value => {
      if (stopped || contents.isDestroyed() || capture !== mine) return;
      const sample = playerSample(value); const action = recommendationRequest(sample?.recommendationRequest, departing.token);
      const item = action?.action === 'follow' ? departing.result.items.find(item => item.id === action.id) : undefined;
      const expected = action?.action === 'follow' && item ? action.kind === 'artist' ? item.artistUrl : action.kind === 'album' ? item.albumUrl : item.url : undefined;
      const validDestination = expected && isMusicPage(expected) && action?.action === 'follow' && (() => {
        const target = new URL(expected);
        return !target.search && !target.hash && new RegExp('^/' + departing.country + '/' + action.kind + '/(?:[^/]+/)?[0-9]{1,20}/?$').test(target.pathname);
      })();
      if (validDestination && expected === destination && contents.getURL() === destination && isMusicPage(departing.origin) &&
        configuration === departing.configuration && sample?.seed?.country === departing.country && getApiKey() === lastKey)
        saved = { ...departing, destination, scroll: action.scroll };
      captureDestination = undefined; void render();
    }).catch(() => { if (capture === mine) { captureDestination = undefined; onFailure(); void render(); } });
  };
  let wakeTimer: NodeJS.Timeout | undefined; let wakePending = false;
  const scheduleWake = (): void => {
    if (stopped || contents.isDestroyed() || wakeTimer) return;
    wakeTimer = setTimeout(() => { wakeTimer = undefined; void poll(); }, 100);
  };
  const poll = async (): Promise<void> => {
    if (stopped || contents.isDestroyed()) return;
    if (polling) { wakePending = true; return; }
    if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = undefined; }
    if (!isMusicPage(contents.getURL())) { reset(); return; }
    polling = true;
    try {
      const observed = contents.getURL();
      const sample = playerSample(await contents.mainFrame.executeJavaScript(playerSampleScript));
      if (!sample || contents.getURL() !== observed || !isMusicPage(observed)) return;
      const initialAction = recommendationRequest(sample.recommendationRequest, state.epoch);
      if (initialAction?.action === 'play' && state.open && recommendationQueue(state.result.items, initialAction.id, recommendationLimits.queue)) relatedContext = true;
      if (initialAction?.action === 'close') {
        forgetList(); relatedContext = false; delete state.playback;
        stopRequest(); state.open = false; state.busy = false; state.focusOnOpen = false; state.result = empty(); await render();
      }
      const next = sample.seed ? JSON.stringify(sample.seed) : '';
      const key = getApiKey(); playing = sample.seed;
      if (key !== lastKey || saved && (!sample.seed || sample.seed.country !== saved.country || observed !== saved.origin && observed !== saved.destination)) forgetList();
      if (next !== seedKey || key !== lastKey) {
        // La cola Related avanza: se conserva la lista y sólo cambia la fila marcada como en reproducción.
        if (relatedContext && state.open && (!sample.seed || sample.seed.country === state.seed?.country) && key === lastKey) { seedKey = next; await render(); }
        else {
          const wasOpen = state.open; relatedContext = false; delete state.playback; stopRequest(); seedKey = next; lastKey = key;
          state.epoch = randomUUID(); state.seed = sample.seed; state.result = empty(); state.busy = false; state.open = wasOpen && !!sample.seed;
          await render(); if (state.open && initialAction?.action !== 'restore' && initialAction?.action !== 'open') void run(state.mode);
        }
      } else if (!rendered || sample.recommendationUiPresent === false) await render();
      if (initialAction?.action === 'restore' && saved && initialAction.token === saved.token && observed === saved.origin &&
        sample.seed?.country === saved.country && key === lastKey && configuration === saved.configuration) {
        const previous = saved; forgetList(); stopRequest();
        relatedContext = previous.relatedContext;
        state = { epoch: randomUUID(), seed: previous.seed, mode: previous.mode, result: previous.result,
          open: true, busy: false, focusOnOpen: false, restoreScroll: previous.scroll };
        await render();
      } else if (saved && observed === saved.origin) { forgetList(); await render(); }
      if (sample.recommendationRequest) {
        if (initialAction?.action === 'open') { state.seed = sample.seed; void run(initialAction.mode); }
        await contents.mainFrame.executeJavaScript(`(() => {
          if (top !== self || location.href !== ${JSON.stringify(observed)} || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return;
          const nav = document.getElementById('el-music-navigation'); if (nav?.dataset.recommendationRequest === ${JSON.stringify(sample.recommendationRequest)}) delete nav.dataset.recommendationRequest;
        })()`);
        if (initialAction?.action === 'play') void play(initialAction.id);
      }
    } catch { onFailure(); }
    finally { polling = false; if (wakePending) { wakePending = false; scheduleWake(); } }
  };
  const wake = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.message !== requestWakeMessage || stopped || contents.isDestroyed() ||
      details.frame !== contents.mainFrame || details.frame.url !== contents.getURL() || !isMusicPage(contents.getURL())) return;
    scheduleWake();
  };
  contents.on('console-message', wake);
  const timer = setInterval(() => void poll(), 1500);
  contents.on('did-start-navigation', (details, url, inPlace, mainFrame) => {
    if (!(details.isMainFrame ?? mainFrame)) return;
    if (details.isSameDocument ?? inPlace) closeForNavigation(details.url ?? url); else reset();
  });
  contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) closeForNavigation(url); });
  contents.once('destroyed', () => {
    stopped = true; clearInterval(timer); if (wakeTimer) clearTimeout(wakeTimer);
    contents.removeListener('console-message', wake); reset();
  });
  return () => {
    if (stopped || contents.isDestroyed()) return;
    forgetList(); relatedContext = false; delete state.playback; configuration++; stopRequest(); lastKey = getApiKey(); state.epoch = randomUUID(); state.busy = false; state.result = empty();
    if (state.open && state.seed) void run(state.mode); else void render();
  };
}
