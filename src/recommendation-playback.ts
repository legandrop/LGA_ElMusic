import { recommendationLimits } from './recommendation-types';

export type RecommendationPlayback = 'requested' | 'busy' | 'unavailable' | 'failed' | 'view-changed';

export function recommendationQueue(items: readonly { id: string }[], selected: string, limit: number): string[] | undefined {
  if (!Number.isInteger(limit) || limit < 1 || limit > recommendationLimits.queue || !items.length || items.length > recommendationLimits.verified ||
    items.some(item => !/^\d{1,20}$/.test(item.id)) || new Set(items.map(item => item.id)).size !== items.length) return;
  const index = items.findIndex(item => item.id === selected);
  return index < 0 ? undefined : [...items.slice(index), ...items.slice(0, index)].slice(0, limit).map(item => item.id);
}

// Sólo se ejecuta para un Play explícito; el SDK y la sesión pertenecen a la página oficial.
export function recommendationPlaybackScript(epoch: string, songs: readonly string[]): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(epoch) || !songs.length || songs.length > recommendationLimits.queue ||
    songs.some(id => !/^\d{1,20}$/.test(id)) || new Set(songs).size !== songs.length) throw new Error('Solicitud de reproducción inválida');
  return `(async () => {
    if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return 'unavailable';
    const epoch = ${JSON.stringify(epoch)}, songs = ${JSON.stringify(songs)}, origin = location.href;
    const root = document.documentElement, token = epoch + '/' + songs[0];
    const panel = document.getElementById('el-music-recommendation-panel');
    const ids = () => [...panel?.querySelectorAll('[data-el-music-recommendation-id]') || []].map(item => item.dataset.elMusicRecommendationId);
    const sourceIds = ids(), sourceKey = JSON.stringify(sourceIds);
    const valid = () => {
      const nav = document.getElementById('el-music-navigation');
      if (location.href !== origin || nav?.dataset.recommendationEpoch !== epoch || !panel || panel !== document.getElementById('el-music-recommendation-panel') || panel.dataset.recommendationEpoch !== epoch) return false;
      const pending = nav.dataset.recommendationRequest;
      if (pending === 'close/' + epoch || pending?.startsWith('open/' + epoch + '/') || pending?.startsWith('follow/' + epoch + '/')) return false;
      const currentIds = ids(), index = currentIds.indexOf(songs[0]);
      return currentIds.length <= ${recommendationLimits.verified} && currentIds.every(id => /^\\d{1,20}$/.test(id)) && new Set(currentIds).size === currentIds.length &&
        JSON.stringify(currentIds) === sourceKey && index >= 0 && JSON.stringify([...currentIds.slice(index), ...currentIds.slice(0, index)].slice(0, songs.length)) === JSON.stringify(songs);
    };
    if (!valid()) return 'view-changed';
    if (root.dataset.elMusicRecommendationQueueBusy) return 'busy';
    root.dataset.elMusicRecommendationQueueBusy = token;
    let accepted = false;
    try {
      const kit = globalThis.MusicKit, music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined;
      if (typeof music?.setQueue !== 'function' || kit.PlayerShuffleMode?.off === undefined || kit.PlayerRepeatMode?.none === undefined) return 'unavailable';
      const stateKey = Symbol.for('el-music.recommendation-queue'), previous = root[stateKey];
      const queueItems = music.queue?.items;
      const index = previous?.songs?.indexOf(songs[0]) ?? -1;
      // Las referencias públicas acreditan que sigue siendo la cola que cargó este contexto, sin propiedades internas del SDK.
      if (previous?.epoch === epoch && previous.origin === origin && previous.sourceKey === sourceKey && previous.music === music && previous.queue === music.queue &&
        Array.isArray(queueItems) && queueItems.length === previous.items?.length && queueItems.every((item, position) => item === previous.items[position]) && index >= 0 &&
        music.shuffleMode === kit.PlayerShuffleMode.off && music.repeatMode === kit.PlayerRepeatMode.none && typeof music.changeToMediaAtIndex === 'function') {
        if (!valid()) return 'view-changed';
        await music.changeToMediaAtIndex(index);
        return 'requested';
      }
      previous?.dispose?.();
      delete root[stateKey];
      music.shuffleMode = kit.PlayerShuffleMode.off;
      if (!valid()) return 'view-changed';
      // El Play humano inicia un único efecto; cerrar después no promete revertirlo ni emite otro play tardío.
      const queue = await music.setQueue({ songs, startPlaying: true, repeatMode: kit.PlayerRepeatMode.none });
      if (queue === undefined || queue === null) return 'unavailable';
      accepted = true;
      const items = music.queue?.items;
      if (valid() && queue === music.queue && Array.isArray(items) && items.length === songs.length &&
        typeof music.addEventListener === 'function' && typeof music.removeEventListener === 'function') {
        const state = { epoch, origin, sourceKey, music, queue, items: [...items], songs: [...songs], dispose: () => {
          music.removeEventListener('queueItemsDidChange', state.dispose);
          if (root[stateKey] === state) delete root[stateKey];
        } };
        root[stateKey] = state;
        music.addEventListener('queueItemsDidChange', state.dispose);
      }
      return 'requested';
    } catch { return accepted ? 'requested' : 'failed'; }
    finally {
      if (root.dataset.elMusicRecommendationQueueBusy === token) {
        delete root.dataset.elMusicRecommendationQueueBusy;
        for (const button of document.getElementById('el-music-recommendation-panel')?.querySelectorAll('[data-el-music-recommendation-play]') || []) button.disabled = false;
      }
    }
  })()`;
}

export function recommendationPlayback(value: unknown): RecommendationPlayback {
  return ['requested', 'busy', 'unavailable', 'failed', 'view-changed'].includes(value as string) ? value as RecommendationPlayback : 'failed';
}
