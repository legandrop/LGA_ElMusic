// History API pública: el router Apple conserva el mismo reproductor.
export const musicLinkFunctionScript = String.raw`const musicLink = (link, url, title, afterNavigation, beforeNavigation) => {
  link.href = url;
  link.addEventListener('click', event => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    let target;
    try { target = new URL(url); } catch { return; }
    if (target.protocol !== 'https:' || target.hostname !== 'music.apple.com' || target.port || target.username || target.password || target.search || target.hash || !/^\/[a-z]{2}\/(album|song|artist|label)\/(?:[^/]+\/)?\d{1,20}\/?$/.test(target.pathname)) return;
    const initial = location.href;
    document.getElementById('el-music-navigation-error')?.remove();
    const player = document.querySelector('.chrome-player');
    const clean = value => value.replace(/\s+/g, ' ').trim();
    const headings = () => [...document.querySelectorAll('h1')].filter(element => !element.closest('#el-music-label-panel,#el-music-recommendation-panel'));
    const initialHeadings = new Map(headings().map(element => [element, clean(element.textContent)]));
    const destinationOpen = location.origin === target.origin && location.pathname === target.pathname;
    if (destinationOpen && player && headings().some(element => clean(element.textContent) === clean(title))) {
      if (beforeNavigation && beforeNavigation() === false) return;
      if (afterNavigation) afterNavigation(); return;
    }
    let checks = 0;
    const interval = setInterval(() => {
      const sameDestination = location.origin === target.origin && location.pathname === target.pathname;
      const heading = headings().some(element => clean(element.textContent) === clean(title) &&
        (!initialHeadings.has(element) || initialHeadings.get(element) !== clean(element.textContent)));
      if (!sameDestination) { cleanup(); return; }
      if (sameDestination && heading && player === document.querySelector('.chrome-player')) {
        cleanup(); if (afterNavigation) afterNavigation();
      } else if (++checks >= 40 || !player?.isConnected) {
        cleanup();
        const error = document.createElement('span'); error.id = 'el-music-navigation-error'; error.setAttribute('role', 'alert');
        error.textContent = 'This page could not be opened. Try again.';
        const navigation = document.getElementById('el-music-navigation');
        if (navigation) navigation.appendChild(error); else if (link.isConnected) link.after(error);
      }
    }, 200);
    const cleanup = () => { clearInterval(interval); removeEventListener('pagehide', cleanup); };
    addEventListener('pagehide', cleanup, { once: true });
    if (!player) { cleanup(); return; }
    if (beforeNavigation && beforeNavigation() === false) { cleanup(); return; }
    history.pushState(null, '', target.href);
    dispatchEvent(new PopStateEvent('popstate', { state: null }));
  });
};`;
