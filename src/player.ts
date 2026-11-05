import type { RecommendationSeed } from './recommendation-types';

// Sólo el LCD visible de Apple; no propiedades privadas de Svelte/MusicKit.
export const nativePlayerFunction = String.raw`() => {
  if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return { seed: null, albumButton: null, metadataPresent: false };
  const metadata = document.querySelector('.chrome-player [data-testid="player-lcd-metadata"] [data-testid="lcd-metadata"]');
  const original = '.marquee-line__scrolling-text-chunk:not(.marquee-line__scrolling-text-chunk--copy) .marquee-line__text-content';
  const primary = metadata?.querySelector('.marquee--primary ' + original);
  const secondary = metadata?.querySelector('.marquee--secondary ' + original);
  const fragments = [...secondary?.querySelectorAll('[data-testid="marquee-text-item"]') || []].slice(0, 12);
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
  const separator = fragments.findIndex(item => clean(item.textContent) === '—');
  const artistItem = fragments[0];
  const albumItem = separator >= 1 && separator === fragments.length - 2 ? fragments[separator + 1] : null;
  const title = clean(primary?.textContent);
  const artist = clean(artistItem?.querySelector('[data-testid="marquee-text-item-button"]')?.textContent || artistItem?.textContent);
  const album = clean(albumItem?.textContent);
  // Las páginas de biblioteca (/library/…) no llevan país; entonces se toma el storefront de los enlaces públicos de la
  // barra lateral de Apple (Inicio, Novedades, Radio, Buscar).
  const storefront = [...document.querySelectorAll('.navigation a[href]')].map(link => link.getAttribute('href') || '')
    .map(href => href.match(/^(?:https:\/\/music\.apple\.com)?\/([a-z]{2})\/(?:home|new|radio|search|browse)(?:[\/?#]|$)/)?.[1]).find(Boolean);
  const country = location.pathname.match(/^\/([a-z]{2})(?:\/|$)/)?.[1] || storefront;
  const albumButton = albumItem?.querySelector('[data-testid="marquee-text-item-button"]');
  return { seed: title && artist && country ? { title, artist, album, country } : null,
    albumButton: album && albumButton instanceof HTMLButtonElement && !albumButton.disabled ? albumButton : null,
    metadataPresent: !!metadata };
}`;

export const playerSampleScript = `(() => {
  if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return null;
  const sample = (${nativePlayerFunction})();
  const nav = document.getElementById('el-music-navigation');
  const recommendationButton = document.getElementById('el-music-open-recommendations');
  const recommendationPanel = document.getElementById('el-music-recommendation-panel');
  const recommendationEpoch = nav?.dataset.recommendationEpoch;
  const recommendationUiPresent = !!nav && !!recommendationButton && typeof recommendationEpoch === 'string' && !!recommendationEpoch && recommendationButton.dataset.recommendationEpoch === recommendationEpoch && typeof recommendationButton.onclick === 'function' &&
    (recommendationButton.getAttribute('aria-expanded') !== 'true' || recommendationPanel?.dataset.recommendationEpoch === recommendationEpoch);
  const request = key => typeof nav?.dataset[key] === 'string' && nav.dataset[key].length < 128 ? nav.dataset[key] : null;
  return { seed: sample.seed, metadataPresent: sample.metadataPresent, albumButtonAvailable: !!sample.albumButton,
    albumUrl: location.href, recommendationRequest: request('recommendationRequest'), recommendationUiPresent };
})()`;

export interface PlayerSample {
  seed?: RecommendationSeed; metadataPresent: boolean; albumButtonAvailable: boolean;
  albumUrl?: string; recommendationRequest?: string;
  recommendationUiPresent?: boolean;
}
export function playerSample(value: unknown): PlayerSample | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  const result: PlayerSample = { metadataPresent: data.metadataPresent === true, albumButtonAvailable: data.albumButtonAvailable === true };
  if (typeof data.recommendationUiPresent === 'boolean') result.recommendationUiPresent = data.recommendationUiPresent;
  const seed = data.seed as Record<string, unknown> | undefined;
  const bounded = (text: unknown): text is string => typeof text === 'string' && text.length <= 240;
  if (seed && bounded(seed.title) && seed.title && bounded(seed.artist) && seed.artist && bounded(seed.album) && typeof seed.country === 'string' && /^[a-z]{2}$/.test(seed.country)) {
    result.seed = { title: seed.title, artist: seed.artist, album: seed.album, country: seed.country };
  }
  for (const field of ['recommendationRequest'] as const) {
    if (typeof data[field] === 'string' && data[field].length < 128) result[field] = data[field];
  }
  if (typeof data.albumUrl === 'string' && data.albumUrl.length <= 2048) result.albumUrl = data.albumUrl;
  return result;
}
