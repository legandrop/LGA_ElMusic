(() => {
  'use strict';
  if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return;
  if (document.getElementById('el-music-navigation')) return;
  const nav = document.createElement('nav');
  nav.id = 'el-music-navigation'; nav.className = 'el-music-navigation'; nav.setAttribute('aria-label', 'Page navigation');
  const icon = (button, label, path) => {
    button.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const glyph = document.createElementNS(svg.namespaceURI, 'path'); glyph.setAttribute('d', path);
    svg.appendChild(glyph); button.replaceChildren(svg);
  };
  for (const [label, direction, points] of [['Back', -1, '14 5 7 12 14 19'], ['Forward', 1, '10 5 17 12 10 19']]) {
    const button = document.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('points', points); svg.appendChild(line); button.appendChild(svg);
    button.addEventListener('click', event => { if (event.detail > 0) button.blur(); historyStep(direction); }); nav.appendChild(button);
  }
  // Back y Forward propios, y Alt+Left/Alt+Right del menú (evento el-music:history): el mismo recorrido. Back con un panel
  // propio abierto (Related, New releases o un sello) lo cierra y deja a la vista la página de abajo, que es donde se
  // estaba antes de abrirlo; si no, va al historial.
  function historyStep(direction) {
    if (direction < 0) {
      const close = document.querySelector('#el-music-recommendation-panel [data-close-recommendations], #el-music-label-panel:not(.el-music-panel--parked) [data-close-labels]');
      if (close) { close.click(); return; }
    }
    if (!canGoHistory(direction)) return; // sin entrada hacia ese lado no se marca ninguna intención
    // Si el destino es la entrada de un panel escondido, el panel aparece ya con el clic: Apple procesa el regreso en una
    // tarea larga que no deja dibujar nada hasta terminar (goHistory espera un cuadro antes de llamar a history.back()).
    const parked = document.querySelector('#el-music-label-panel.el-music-panel--parked');
    const navigationApi = globalThis.navigation, index = navigationApi?.currentEntry?.index;
    const destination = Number.isInteger(index) && typeof navigationApi.entries === 'function' ? navigationApi.entries()[index + direction] : undefined;
    if (parked?.dataset?.entryKey && destination?.key === parked.dataset.entryKey) {
      showParkedPanel(parked, false);
      const from = navigationApi.currentEntry?.key, asked = performance.now();
      setTimeout(() => {
        if (lastNavigateAt >= asked || navigationApi.currentEntry?.key !== from || !parked.isConnected || parked.classList.contains('el-music-panel--parked')) return;
        parked.classList.add('el-music-panel--parked'); syncReleasesPanel();
      }, 2000);
    }
    if (direction < 0 && nav.dataset.recommendationReturnToken && nav.dataset.recommendationReturnDestination === location.href)
      nav.dataset.recommendationBackIntent = nav.dataset.recommendationReturnToken;
    goHistory(direction);
  }
  const album = document.createElement('button'); album.type = 'button'; album.id = 'el-music-open-playing-album'; album.className = 'el-music-text-button';
  icon(album, 'Playing album', 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Zm0 6a3 3 0 1 0 0 6a3 3 0 0 0 0-6Z'); album.title = 'Open the playing album';
  album.addEventListener('click', event => { if (event.detail > 0) album.blur(); const button = readPlaying().albumButton; if (button) { busyForButton('album', button.textContent); button.click(); } }); nav.appendChild(album);
  const recommendations = document.createElement('button'); recommendations.type = 'button'; recommendations.id = 'el-music-open-recommendations';
  recommendations.className = 'el-music-text-button'; icon(recommendations, 'Related music', 'M6 9a3 3 0 1 0 0-6a3 3 0 0 0 0 6Zm12 6a3 3 0 1 0 0-6a3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6a3 3 0 0 0 0 6Zm3-14l6 4m-6 6l6-4'); nav.appendChild(recommendations);
  recommendations.disabled = true;
  nav.insertBefore(recommendations, album);
  // Novedades de los artistas de la biblioteca: abre el panel por el canal de sellos (main lo arma).
  const newReleases = document.createElement('button'); newReleases.type = 'button'; newReleases.id = 'el-music-open-new-releases';
  newReleases.className = 'el-music-text-button'; icon(newReleases, 'New releases', 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2Z'); newReleases.title = 'New releases from the artists in your library';
  newReleases.addEventListener('click', event => {
    if (event.detail > 0) newReleases.blur();
    document.querySelector('#el-music-recommendation-panel [data-close-recommendations]')?.click();
    sendLabelRequest('new-releases');
  });
  nav.insertBefore(newReleases, album);
  // El panel lo dibuja main: aria-expanded del botón sigue a «panel de New releases abierto», y con él se marca su ítem en
  // la barra lateral. Un clic en un enlace de esa barra cierra el panel (aunque la página ya sea ésa y Apple no navegue).
  newReleases.setAttribute('aria-expanded', 'false');
  const syncReleasesPanel = () => {
    const panel = document.getElementById('el-music-label-panel');
    const open = String(panel?.dataset.kind === 'new-releases' && !panel.classList.contains('el-music-panel--parked'));
    if (newReleases.getAttribute('aria-expanded') !== open) newReleases.setAttribute('aria-expanded', open);
  };
  new MutationObserver(syncReleasesPanel).observe(document.body, { childList: true });
  // Un clic en un enlace de la barra lateral hacia la página que ya está debajo del panel lo cierra (Apple no navega); hacia
  // otra página, la navegación lo esconde y Back vuelve a él.
  document.addEventListener('click', event => {
    if (event.button !== 0 || event.ctrlKey || event.shiftKey || event.metaKey || event.altKey || !(event.target instanceof Element)) return;
    const link = event.target.closest('.navigation-items a[href]'); if (!link) return;
    let here = true;
    try { const url = new URL(link.href, location.href); here = url.origin === location.origin && url.pathname.replace(/\/$/, '') === location.pathname.replace(/\/$/, '') && url.search === location.search; } catch { /* se cierra */ }
    if (here) document.querySelector('#el-music-label-panel:not(.el-music-panel--parked) [data-close-labels]')?.click();
  }, true);
  const unavailableLyrics = document.createElement('button'); unavailableLyrics.type = 'button'; unavailableLyrics.disabled = true;
  unavailableLyrics.className = 'el-music-lyrics-placeholder'; unavailableLyrics.title = 'Lyrics unavailable'; unavailableLyrics.setAttribute('aria-label', 'Lyrics unavailable');
  icon(unavailableLyrics, 'Lyrics unavailable', 'M4 4h16v12H10l-5 4v-4H4V4Zm4 4h2m4 0h2M8 11h2m4 0h2');
  let installed = false;
  const volumes = new WeakSet();
  const repeats = new WeakSet();
  const ranges = new WeakSet();
  const prepareRepeat = player => {
    const repeat = player.querySelector('amp-playback-controls-repeat');
    if (!repeat?.shadowRoot || repeats.has(repeat)) return;
    const update = () => {
      const button = repeat.shadowRoot.querySelector('button');
      if (!button) return;
      repeat.dataset.elMusicRepeatActive = String(button.getAttribute('aria-checked') === 'true');
      repeat.dataset.elMusicRepeatOne = String(repeat.shadowRoot.querySelector('amp-icon')?.getAttribute('name') === 'player-repeat-1');
      repeat.dataset.elMusicRepeatDisabled = String(button.disabled);
    };
    new MutationObserver(update).observe(repeat.shadowRoot, { childList: true, subtree: true,
      attributes: true, attributeFilter: ['aria-checked', 'name', 'disabled'] });
    repeats.add(repeat); update();
  };
  let inlineVolume = false;
  const prepareVolume = player => {
    const volume = player.querySelector('.chrome-volume');
    if (!volume) return;
    const wide = innerWidth > 1100;
    if (!volumes.has(volume)) {
      // Apple crea el rango al abrirlo y lo destruye al salir; conservarlo sólo en modo inline.
      for (const name of ['mouseleave', 'focusout']) volume.addEventListener(name, event => {
        if (innerWidth > 1100) event.stopImmediatePropagation();
      }, true);
      volume.addEventListener('wheel', event => {
        const range = volume.querySelector('input.volume-control__range');
        if (!range || range.disabled || !event.deltaY) return;
        event.preventDefault();
        range.value = String(Math.max(0, Math.min(1, Number(range.value) + (event.deltaY < 0 ? .01 : -.01))));
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
        volume.title = `${Math.round(Number(range.value) * 100)}%`;
      }, { passive: false });
      volumes.add(volume);
    }
    if (wide && !volume.querySelector('input.volume-control__range')) volume.querySelector('button.chrome-volume__button')?.click();
    else if (!wide && inlineVolume) volume.dispatchEvent(new MouseEvent('mouseleave'));
    const range = volume.querySelector('input.volume-control__range');
    if (range && !ranges.has(range)) {
      const update = () => {
        const value = Math.max(0, Math.min(1, Number(range.value) || 0));
        range.parentElement.style.setProperty('--el-volume-fraction', String(value));
        volume.title = `${Math.round(value * 100)}%`;
      };
      range.addEventListener('input', update); range.addEventListener('change', update);
      new MutationObserver(update).observe(range, { attributes: true, attributeFilter: ['style', 'aria-valuenow'] });
      ranges.add(range); update();
    }
    inlineVolume = wide;
  };
  let sidebar;
  let sidebarObserver;
  const refreshSidebar = navigation => {
    if (navigation === sidebar) return;
    sidebarObserver?.disconnect(); sidebar = navigation;
    if (sidebar) {
      sidebarObserver = new ResizeObserver(entries => {
        const width = Math.round(entries[0].borderBoxSize?.[0]?.inlineSize ?? entries[0].contentRect.width);
        document.documentElement.style.setProperty('--el-sidebar-width', `${width}px`);
      });
      sidebarObserver.observe(sidebar);
    }
  };
  // Ítems propios en la barra lateral de Apple: «New releases» y «Related music» van con Buscar/Inicio/
  // Novedades/Radio, clonando la estructura y las clases de un ítem de Apple para heredar su estilo. Son botones y no <a>:
  // el cierre de Related al navegar escucha los enlaces de esa barra y no debe dispararse con ellos. Disparan los botones
  // de la barra superior, que quedan ocultos y conservan su estado (Related deshabilitado sin tema sonando, aria-expanded).
  const sidebarItems = [
    ['el-music-nav-new-releases', 'New releases', newReleases, 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2Z'],
    ['el-music-nav-related', 'Related music', recommendations, 'M6 9a3 3 0 1 0 0-6a3 3 0 0 0 0 6Zm12 6a3 3 0 1 0 0-6a3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6a3 3 0 0 0 0 6Zm3-14l6 4m-6 6l6-4']];
  const installSidebarItems = navigation => {
    const list = navigation?.querySelector('.navigation-items--primary .navigation-items__list');
    const template = list?.querySelector('li.navigation-item');
    if (!list || !template || list.querySelector('.el-music-nav-item')) return;
    let installed = 0;
    for (const [id, label, source, path] of sidebarItems) {
      const item = template.cloneNode(true);
      const link = item.querySelector('a'), svg = item.querySelector('svg'), text = item.querySelector('.navigation-item__label');
      if (!link || !svg || !text) { pageLog('sidebar-item-shape', { }); return; }
      item.id = id; item.classList.remove('navigation-item--selected'); item.classList.add('el-music-nav-item'); item.setAttribute('aria-selected', 'false');
      const button = document.createElement('button'); button.type = 'button'; button.className = link.className; button.setAttribute('aria-label', label); button.title = source.title || label;
      for (const child of [...link.childNodes]) button.appendChild(child);
      link.replaceWith(button);
      for (const element of item.querySelectorAll('[data-testid]')) element.removeAttribute('data-testid');
      svg.replaceChildren(); svg.setAttribute('viewBox', '0 0 24 24');
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path'); shape.setAttribute('d', path); svg.appendChild(shape);
      text.textContent = label;
      const sync = () => {
        const open = source.getAttribute('aria-expanded') === 'true';
        button.disabled = source.disabled; item.classList.toggle('el-music-nav-item--disabled', source.disabled); button.title = source.title || label;
        item.classList.toggle('navigation-item--selected', open); item.setAttribute('aria-selected', open ? 'true' : 'false');
        // Con un ítem propio seleccionado, el de Apple (la ruta de abajo del panel) deja de verse seleccionado.
        document.documentElement.classList.toggle('el-music-own-nav', !!list.querySelector('.el-music-nav-item.navigation-item--selected'));
      };
      new MutationObserver(sync).observe(source, { attributes: true, attributeFilter: ['disabled', 'aria-expanded', 'title'] }); sync();
      button.addEventListener('click', event => { event.preventDefault(); if (event.detail > 0) button.blur(); source.click(); });
      list.appendChild(item); installed++;
    }
    document.documentElement.classList.toggle('el-music-own-nav', !!list.querySelector('.el-music-nav-item.navigation-item--selected'));
    pageLog('sidebar-items', { items: installed });
  };
  // Fluidez de la página. Además de la medición de carga de
  // playlist, las tareas largas y los cuadros lentos se vigilan siempre. Un episodio empieza con la primera tarea larga y
  // termina tras 1,5 s sin ninguna; si bloqueó 400 ms o más se registra «page-slow» con su reparto (script de Apple, nuestro,
  // diseño, portadas cargadas, pasadas de las listas) y cuánto pasó desde el último clic en Play/Shuffle y el último scroll al
  // tema. Un episodio que no termina se registra cada 10 s. perf acumula para que la espera del Play informe lo suyo.
  const perf = { longMs: 0, passes: 0, passMs: 0, images: 0, records: 0 };
  let slow, slowTimer, slowLogs = 0, lastPlayClick = -Infinity, lastFollowScroll = -Infinity;
  const slowSegment = start => ({ start, longCount: 0, longMs: 0, longMax: 0, frames: 0, layout: 0, forced: 0, apple: 0, own: 0, other: 0, passes: perf.passes, passMs: perf.passMs, images: perf.images, records: perf.records, culprits: new Map() });
  const reportSlow = ongoing => {
    const segment = slow; if (!segment) return;
    const now = performance.now(), since = at => now - at < 120000 ? Math.round(now - at) : -1;
    if (segment.longMs >= 400 && slowLogs < 40) {
      slowLogs++;
      pageLog('page-slow', { ms: Math.round(now - segment.start), bloqueos: segment.longCount, bloqueoTotalMs: Math.round(segment.longMs), bloqueoMaxMs: Math.round(segment.longMax),
        cuadrosLentos: segment.frames, disenoMs: Math.round(segment.layout), disenoForzadoMs: Math.round(segment.forced), scriptAppleMs: Math.round(segment.apple),
        scriptPropioMs: Math.round(segment.own), scriptOtroMs: Math.round(segment.other), pasadas: perf.passes - segment.passes, nuestroMs: Math.round(perf.passMs - segment.passMs),
        imagenes: perf.images - segment.images, mutaciones: perf.records - segment.records, filas: document.querySelectorAll('.songs-list .songs-list-row').length,
        desdeClicMs: since(lastPlayClick), desdeScrollMs: since(lastFollowScroll), sigue: ongoing ? 1 : 0,
        texto: [...segment.culprits].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, ms]) => name + ' ' + Math.round(ms)).join('; ') || '-' });
    }
    slow = ongoing ? slowSegment(now) : undefined;
  };
  const slowEntry = () => {
    const now = performance.now();
    if (!slow) slow = slowSegment(now); else if (now - slow.start > 10000) reportSlow(true);
    clearTimeout(slowTimer); slowTimer = setTimeout(() => reportSlow(false), 1500);
    return slow;
  };
  // Línea de carga. Medido: tras el clic en un enlace Apple deja la página vieja ~650 ms sin ninguna señal, recién ahí pone
  // su spinner, y el contenido llega a ~1–1,3 s. La línea aparece con el clic y queda hasta que la página nueva está en
  // pantalla. Arranca con:
  //   link   clic en un enlace interno de otra ruta (sidebar, tarjetas, nuestros enlaces de artista/álbum),
  //   button botones que navegan sin ser enlaces (artista/álbum del LCD, Playing album),
  //   nav    una navegación del enrutador que cambia de ruta (Navigation API pública: push o traverse; sin tocar history),
  //   paste y label: pedidos que resuelve main (enlace pegado, sello, New releases), que la retiran con el evento
  //          el-music:busy {op:'end', owner} si abren un panel en lugar de navegar.
  // Una navegación que llega durante otra espera la continúa (mismo punto de partida). Termina cuando la ruta cambió, no
  // hay spinner de Apple a la vista y el título de la página (h1 de main) es otro; con el mismo título, 2,5 s después del
  // cambio de ruta. Sin cambio de ruta: 8 s para los clics, y el tope de cada pedido de main. Sólo se escuchan clics y
  // navegaciones: no se detiene ni se cambia nada de Apple.
  // Log «busy»: motivo 0 link, 1 button, 2 nav, 3 paste, 4 label; fin 0 página lista, 1 sin cambio de ruta, 2 tope,
  // 3 main la retiró, 4 otra espera la reemplazó.
  const busyKinds = ['link', 'button', 'nav', 'paste', 'label'];
  const busyLine = document.createElement('div'); busyLine.id = 'el-music-busy'; busyLine.setAttribute('aria-hidden', 'true');
  // Ya en el documento desde el inicio: un elemento recién insertado no anima la entrada y la primera espera parpadearía.
  document.documentElement.appendChild(busyLine);
  let busy = null, busyTimer, lastInput = null;
  // Títulos (h1) de main sólo por su texto: no fuerza un cálculo de diseño (se lee en cada clic y cada 100 ms de espera).
  const pageTitles = () => [...document.querySelectorAll('main h1')].map(heading => heading.textContent.replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 4);
  const pageHeading = () => pageTitles().join(' | ');
  const appleLoading = () => [...document.querySelectorAll('main .loading-spinner')].some(item => {
    if (item.closest('.infinite-scroll-spinner')) return false;
    const box = item.getBoundingClientRect(); return box.width > 0 && box.bottom > 0 && box.top < innerHeight;
  });
  const endBusy = reason => {
    if (!busy) return;
    pageLog('busy', { motivo: busyKinds.indexOf(busy.kind), fin: reason, ms: Math.round(performance.now() - busy.since), rutaMs: busy.changedAt ? Math.round(busy.changedAt - busy.since) : -1 });
    busy = null; clearInterval(busyTimer); busyTimer = undefined;
    busyLine.classList.remove('el-music-busy--on'); document.documentElement.classList.remove('el-music-busy');
  };
  const busyTick = () => {
    if (!busy) return;
    const now = performance.now();
    if (!busy.changedAt && location.href !== busy.href) busy.changedAt = now;
    if (busy.changedAt) {
      const heading = pageHeading();
      if (heading && heading !== busy.heading && !busy.headingAt) busy.headingAt = now;
      // Con el título nuevo, un spinner que sigue a la vista (una sección que carga más abajo) se ignora a los 1,2 s.
      if (busy.headingAt && (!appleLoading() || now - busy.headingAt > 1200)) return endBusy(0);
      if (!appleLoading() && now - busy.changedAt > 2500) return endBusy(0);
    } else if (now - busy.since > busy.idle) return endBusy(busy.idle < busy.limit ? 1 : 2);
    if (now - busy.since > busy.limit) endBusy(2);
  };
  // from: el punto de partida (ruta y título) que se compara; por defecto, la página tal como está ahora.
  const startBusy = (kind, owner = kind, limit = 15000, from) => {
    if (busy) endBusy(4);
    busy = { kind, owner, since: performance.now(), href: from?.href ?? location.href, heading: from?.heading ?? pageHeading(), changedAt: 0, headingAt: 0,
      idle: kind === 'link' || kind === 'button' ? 8000 : limit, limit };
    if (!busyLine.isConnected) document.documentElement.appendChild(busyLine);
    // Sobre el borde inferior de la barra del reproductor, donde empieza el contenido que se está cargando.
    const bar = document.querySelector('.player-bar')?.getBoundingClientRect();
    busyLine.style.top = (bar && bar.bottom > 2 && bar.bottom < innerHeight / 2 ? Math.round(bar.bottom) - 2 : 0) + 'px';
    busyLine.classList.add('el-music-busy--on'); document.documentElement.classList.add('el-music-busy');
    busyTimer = setInterval(busyTick, 100);
  };
  addEventListener('el-music:busy', event => {
    const detail = event.detail; if (!detail || typeof detail !== 'object' || typeof detail.owner !== 'string' || detail.owner.length > 40) return;
    if (detail.op === 'start' && busyKinds.includes(detail.kind)) startBusy(detail.kind, detail.owner, Math.min(Math.max(Number(detail.limit) || 15000, 1000), 180000));
    else if (detail.op === 'end' && busy?.owner === detail.owner) endBusy(3);
  });
  // Lo último que tocó el usuario y en qué página: el enrutador de Apple cambia la URL recién con la página nueva ya
  // dibujada (clic en un botón que no es enlace), y entonces el punto de partida es la página del clic, no la de ahora.
  // Teclado: sólo Enter y Espacio activan algo (no se lee la página con cada tecla del buscador).
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, event => {
    if (type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    lastInput = { at: performance.now(), href: location.href, heading: pageHeading() };
  }, true);
  // ▶, «…» o cualquier control dentro de una tarjeta enlazada reproducen o abren un menú, no navegan. Se recorre el camino
  // completo del evento (composedPath) porque un control dentro de un componente con shadow DOM llega retargeteado al host.
  const controlSelector = 'button, [role="button"], input, label, select, .play-button, [data-testid="play-button"]';
  const linkOfClick = event => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (!path.length) {
      const target = event.target instanceof Element ? event.target : null, link = target?.closest('a[href]');
      const control = link && target.closest(controlSelector);
      return control && link.contains(control) && control !== link ? null : link || null;
    }
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (node.matches('a[href]')) return node;
      if (node.matches(controlSelector)) return null;
    }
    return null;
  };
  document.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = linkOfClick(event);
    // data-el-music-inline: enlaces propios que despliegan el disco en el mismo panel, sin navegar.
    if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download') || link.dataset?.elMusicInline === 'true') return;
    let url; try { url = new URL(link.href, location.href); } catch { return; }
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
    startBusy('link');
  }, true);
  globalThis.navigation?.addEventListener?.('navigate', event => {
    try {
      if (event.navigationType !== 'push' && event.navigationType !== 'traverse') return;
      const url = new URL(event.destination.url);
      if (url.origin !== location.origin) return;
      // Una espera en curso sigue con la navegación aunque sea a la misma ruta (por ejemplo, otra búsqueda); un regreso a
      // la misma URL no cambia la página y la termina.
      if (busy && !busy.changedAt) {
        if (url.href === location.href) { if (event.navigationType === 'traverse') endBusy(0); return; }
        busy.kind = 'nav'; busy.owner = 'nav'; busy.idle = busy.limit = performance.now() - busy.since + 15000; return;
      }
      if (url.pathname === location.pathname) return;
      const recent = lastInput && lastInput.href === location.href && performance.now() - lastInput.at < 10000 ? lastInput : undefined;
      startBusy('nav', 'nav', 15000, recent);
    } catch { /* destino sin URL */ }
  });
  // Back y Forward (botones propios y Alt+Left del menú, que llega con el evento el-music:history). Medido:
  // Apple procesa el regreso en una tarea larga de ~650 ms que no deja pintar nada; por eso la línea se enciende antes, se
  // espera un cuadro (con un respaldo de 50 ms si la ventana no pinta) y recién entonces se pide el historial: la animación
  // corre en el compositor y se sigue viendo mientras Apple trabaja. Sin entrada hacia ese lado, no se hace nada.
  function canGoHistory(direction) {
    const nav = globalThis.navigation;
    return !(nav && (direction < 0 ? nav.canGoBack === false : nav.canGoForward === false));
  }
  function goHistory(direction) {
    if (!canGoHistory(direction)) return;
    startBusy('button');
    let done = false;
    const go = () => { if (done) return; done = true; if (direction < 0) history.back(); else history.forward(); };
    requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 50);
  }
  addEventListener('el-music:history', event => { if (event.detail === -1 || event.detail === 1) historyStep(event.detail); });
  // Pedido de sello o de New releases a main (canal de sellos), con la línea de carga encendida y su dueño único.
  let labelBusySeq = 0;
  function sendLabelRequest(request) {
    const owner = 'label:' + (labelBusySeq = labelBusySeq % 1e8 + 1);
    startBusy('label', owner, 20000);
    document.documentElement.dataset.elMusicLabelBusy = owner; document.documentElement.dataset.elMusicLabelRequest = request;
    console.debug('elMusic.labels.request-ready');
  }
  // Artista o disco del tema que suena (botones de Apple, no enlaces): si la página ya es ésa, Apple no navega y no hay espera.
  const titleKey = value => String(value || '').replace(/\s+/g, ' ').replace(/ - (?:Single|EP)$/i, '').trim().toLowerCase();
  const busyForButton = (part, name) => { if (!(location.pathname.includes('/' + part + '/') && titleKey(name) && pageTitles().some(title => titleKey(title) === titleKey(name)))) startBusy('button'); };
  // Respuesta inmediata al Play: entre el clic y la reacción de Apple pasan unos 3 s sin señal. Un aviso
  // propio sobre el LCD muestra enseguida qué se pidió, con un indicador de carga, hasta que el LCD cambia de tema, el
  // reproductor pasa a reproducir (evento público playbackStateDidChange del singleton), main avisa que falló o pasan 15 s.
  // Lo piden nuestras listas (evento el-music:pending-play con canción, artista y álbum del catálogo), el encabezado de una
  // lista y las filas que Apple marca is-loading (canción, artista y álbum de la fila). El log «play-wait» guarda cuánto
  // tardó y cómo terminó (sólo números).
  // El aviso no tapa el LCD: la línea propia de dos filas muestra lo pedido
  // en el mismo lugar que el tema sonando («…» en lo que falta) y un anillo gira sobre la portada.
  let pending = null, pendingTimer;
  const lcdTitle = () => document.querySelector('.chrome-player [data-testid="lcd-metadata"] .marquee--primary .marquee-line__scrolling-text-chunk:not(.marquee-line__scrolling-text-chunk--copy) .marquee-line__text-content')?.textContent.replace(/\s+/g, ' ').trim() || '';
  const overlay = document.createElement('div'); overlay.id = 'el-music-lcd-pending'; overlay.hidden = true; overlay.setAttribute('role', 'status');
  const spinner = document.createElement('span'); spinner.className = 'el-music-lcd-pending__spinner'; spinner.setAttribute('aria-hidden', 'true');
  const pendingLabel = document.createElement('span'); pendingLabel.className = 'el-music-visually-hidden';
  overlay.append(spinner, pendingLabel);
  let pendingInfo = { song: '', artist: '', album: '' };
  // fin: 0 el LCD cambió de tema, 1 empezó a reproducir, 2 main avisó que falló, 3 se agotaron los 15 s.
  // via: 1 nuestras listas, 2 fila is-loading de Apple, 3 Play/Shuffle del encabezado. filaMs: cuándo Apple marcó la fila
  // (-1 si no la marcó); bloqueoMs, pasadas e imagenes: tareas largas, pasadas de las listas y portadas durante la espera.
  const settlePending = reason => {
    if (!pending) return;
    pageLog('play-wait', { ms: Date.now() - pending.since, via: pending.via, fin: reason, filaMs: pending.rowAt ? pending.rowAt - pending.since : -1,
      bloqueoMs: Math.round(perf.longMs - pending.perf.longMs), pasadas: perf.passes - pending.perf.passes, imagenes: perf.images - pending.perf.images });
    pending = null; clearTimeout(pendingTimer); overlay.hidden = true; document.documentElement.classList.remove('el-music-play-pending');
    renderLcdLine();
    dispatchEvent(new CustomEvent('el-music:pending-play-done'));
    setTimeout(() => autoloadPages(), 0); // La carga de tandas, en pausa durante la espera, sigue enseguida.
  };
  const cleanPending = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const pendingFields = detail => ({ song: cleanPending(detail.song), artist: cleanPending(detail.artist), album: cleanPending(detail.album) });
  const startPending = (detail, via) => {
    const info = pendingFields(detail);
    if (pending) { clearTimeout(pendingTimer); pending = null; }
    pending = { since: Date.now(), via, lcdBefore: lcdTitle(), rowAt: 0, perf: { ...perf } };
    pendingInfo = info; pendingLabel.textContent = 'Loading ' + (info.song || info.album || 'music');
    const host = document.querySelector('.chrome-player__lcd'); if (host && overlay.parentElement !== host) host.appendChild(overlay);
    overlay.hidden = false; document.documentElement.classList.add('el-music-play-pending');
    renderLcdLine();
    pendingTimer = setTimeout(() => settlePending(3), 15000);
  };
  addEventListener('el-music:pending-play', event => { const detail = event.detail; if (detail === null) settlePending(2); else if (detail && typeof detail === 'object') startPending(detail, 1); });
  const checkPending = () => { if (!pending) return; const now = lcdTitle(); if (now && now !== pending.lcdBefore) settlePending(0); };
  // Fila que Apple marca cargando: con un aviso ya en curso (clic en el encabezado o en nuestras listas) se completa con el
  // tema elegido; se conservan el inicio y el LCD de antes, para no perder el cambio si Apple ya lo escribió.
  const rowPending = detail => {
    if (!pending) { startPending(detail, 2); if (pending) pending.rowAt = pending.since; return; }
    if (!pending.rowAt) pending.rowAt = Date.now();
    const info = pendingFields(detail);
    if (info.song) { pendingInfo = info; pendingLabel.textContent = 'Loading ' + info.song; renderLcdLine(); }
  };
  // Play y Shuffle del encabezado de una playlist o un álbum: Apple
  // arma la cola sin ninguna señal y recién después marca la fila. El aviso del LCD aparece con el clic, con el nombre de la
  // lista. Sólo se escucha el clic en fase de captura: no se detiene ni se cambia nada de Apple.
  document.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('.container-detail-header .primary-actions__button--play button, .container-detail-header .primary-actions__button--shuffle button') : null;
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    const shuffle = !!button.closest('.primary-actions__button--shuffle');
    const header = button.closest('.container-detail-header');
    lastPlayClick = performance.now();
    pageLog('header-play', { tipo: shuffle ? 1 : 0, filas: document.querySelectorAll('.songs-list .songs-list-row').length });
    // En un álbum se conocen el disco y su artista; en una playlist todavía no se sabe qué tema sale («…» hasta que Apple lo marca).
    const album = /\/album\//.test(location.pathname) ? header?.querySelector('.headings__title')?.textContent : '';
    startPending({ album, artist: album ? header?.querySelector('a[href*="/artist/"]')?.textContent : '' }, 3);
    rememberSource();
  }, true);
  // Origen del tema que suena: un clic en la canción del LCD vuelve a la playlist o sección desde donde se disparó y hace
  // scroll hasta ella; sin origen, abre el disco. Se recuerda
  // el último Play que dio el usuario, en el momento del clic: una página de Apple (Play/Shuffle del encabezado, ▶ o doble
  // clic en una fila, ▶ de una tarjeta de cualquier sección), Related, New releases, el panel de un sello o la lista de
  // discos al pie de la página de un sello. Stream Deck sólo mueve la cola ya armada: no cambia el origen. La memoria vive
  // en la página: después de reiniciar la app no hay origen y el clic abre el disco con el botón de álbum de Apple.
  // tipo (log play-source-set): 0 página de Apple, 1 Related, 2 New releases, 3 panel de un sello.
  const sourceKinds = ['page', 'related', 'new-releases', 'label-panel'];
  let playSource = null, revealUntil = 0, lastLabelKey = '', lastUserInput = -Infinity;
  const currentPath = () => location.pathname.replace(/\/$/, '');
  const rememberSource = (kind = 'page', extra = {}) => {
    playSource = { kind, href: location.href, path: currentPath(), ...extra };
    pageLog('play-source-set', { tipo: sourceKinds.indexOf(kind) });
  };
  // Play desde nuestras listas: el evento dice de qué lista salió (source); sin ese dato, la página visible.
  addEventListener('el-music:pending-play', event => {
    const detail = event.detail; if (!detail || typeof detail !== 'object') return;
    if (detail.source === 'related' || detail.source === 'new-releases') rememberSource(detail.source);
    else if (detail.source === 'label-panel') rememberSource('label-panel', { key: lastLabelKey });
    else rememberSource('page');
  });
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { lastUserInput = performance.now(); }, true);
  // Play en la página de Apple: ▶ de una fila o de una tarjeta, doble clic o Enter en una fila de una lista de canciones.
  // El encabezado se recuerda en su propio listener; el doble clic sobre el sello no reproduce (ver más abajo).
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('.scrollable-page') || target.closest('.container-detail-header .primary-actions')) return;
    if (target.closest('.play-button,[data-testid="play-button"]')) rememberSource('page');
  }, true);
  document.addEventListener('dblclick', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.songs-list .songs-list-row') && !target.closest('.el-music-label-link,.el-music-album-link,.el-music-artist-link')) rememberSource('page');
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target instanceof Element && event.target.closest('.songs-list .songs-list-row')) rememberSource('page');
  }, true);
  const revealPlaying = list => {
    const row = list.querySelector(':scope > .songs-list-row.is-playing, :scope > .songs-list-row.is-loading, :scope > .songs-list-row.is-paused');
    if (!row) return false;
    revealUntil = 0;
    const distance = Math.round(row.getBoundingClientRect().top - innerHeight / 2), far = Math.abs(distance) > innerHeight * 2;
    row.scrollIntoView({ block: 'center', behavior: far ? 'instant' : 'smooth' }); lastFollowScroll = performance.now();
    pageLog('follow-playing', { distancia: distance, suave: far ? 0 : 1, filas: rowsOf(list).length, origen: 1 });
    return true;
  };
  const sourceLink = path => [...document.querySelectorAll('.navigation a[href]')].find(link => {
    try { const url = new URL(link.href); return url.origin === location.origin && url.pathname.replace(/\/$/, '') === path; } catch { return false; }
  });
  // Related y los paneles propios: si siguen abiertos, scroll al tema o disco que suena (Related lo marca con aria-current,
  // las listas de discos con is-playing); si se cerraron, se vuelven a abrir como con su botón y se espera la fila 8 s.
  let panelReveal;
  const revealInPanel = selector => {
    clearInterval(panelReveal); const until = Date.now() + 8000;
    const find = () => {
      const row = document.querySelector(selector);
      if (row) { row.scrollIntoView({ block: 'center', behavior: 'instant' }); lastFollowScroll = performance.now(); }
      if (row || Date.now() > until) { clearInterval(panelReveal); pageLog('follow-playing', { distancia: 0, suave: 0, filas: 0, origen: row ? 2 : 3 }); return true; }
      return false;
    };
    if (!find()) panelReveal = setInterval(find, 300);
  };
  const openAlbum = () => { const button = readPlaying().albumButton; pageLog('play-source', { via: button ? 4 : 9 }); if (button) { busyForButton('album', button.textContent); button.click(); } };
  const labelRequest = request => sendLabelRequest(request);
  // via (log play-source): 0 ya en la página, 1 enlace de la barra lateral, 2 historial, 3 enrutador, 4 disco (sin origen),
  // 5 Related abierto, 6 Related reabierto, 7 panel propio abierto, 8 panel propio reabierto, 9 sin origen ni disco;
  // y los otros clics de la línea del LCD: 10 álbum, 11 artista.
  const openSource = () => {
    const source = playSource;
    if (!source) { openAlbum(); return; }
    if (source.kind === 'related') {
      const open = !!document.getElementById('el-music-recommendation-panel');
      pageLog('play-source', { via: open ? 5 : 6 });
      if (!open) document.getElementById('el-music-open-recommendations')?.click();
      revealInPanel('#el-music-recommendation-panel [aria-current="true"]');
      return;
    }
    if (source.kind === 'new-releases' || source.kind === 'label-panel') {
      document.querySelector('#el-music-recommendation-panel [data-close-recommendations]')?.click();
      const panel = document.getElementById('el-music-label-panel');
      // Escondido (se salió de él a otra página): se muestra sobre la página actual, que pasa a ser la suya.
      if (panel && panel.dataset.kind === source.kind && panel.classList.contains('el-music-panel--parked')) showParkedPanel(panel, true);
      if (!panel || panel.dataset.kind !== source.kind) {
        const request = source.kind === 'new-releases' ? 'new-releases' : /^[amp][a-f\d-]{1,40}$/.test(source.key || '') ? 'open/' + source.key : '';
        if (!request) { openAlbum(); return; }
        pageLog('play-source', { via: 8 }); labelRequest(request);
      } else pageLog('play-source', { via: 7 });
      revealInPanel('#el-music-label-panel .el-music-label-grid > li.is-playing, #el-music-label-panel .el-music-releases tr.is-playing');
      return;
    }
    document.querySelector('#el-music-recommendation-panel [data-close-recommendations]')?.click();
    // Si el origen es la página de abajo, el panel se cierra para verla; si es otra, la navegación lo esconde (Back vuelve).
    if (currentPath() === source.path) document.querySelector('#el-music-label-panel:not(.el-music-panel--parked) [data-close-labels]')?.click();
    revealUntil = Date.now() + 15000;
    // Página de un sello: el disco que suena está en nuestra lista al pie (is-playing).
    if (/\/label\//.test(source.path)) revealInPanel('#el-music-label-releases .el-music-releases tr.is-playing');
    if (currentPath() === source.path) {
      pageLog('play-source', { via: 0 });
      for (const list of document.querySelectorAll('.songs-list')) if (revealPlaying(list)) break;
      return;
    }
    const link = sourceLink(source.path);
    if (link) { pageLog('play-source', { via: 1 }); link.click(); return; }
    const entry = globalThis.navigation?.entries?.().filter(item => { try { return new URL(item.url).pathname.replace(/\/$/, '') === source.path; } catch { return false; } }).at(-1);
    if (entry && typeof navigation.traverseTo === 'function') {
      pageLog('play-source', { via: 2 });
      const result = navigation.traverseTo(entry.key); result?.committed?.catch(() => {}); result?.finished?.catch(() => {});
      return;
    }
    pageLog('play-source', { via: 3 });
    history.pushState(null, '', source.href); dispatchEvent(new PopStateEvent('popstate', { state: null }));
  };
  // Back vuelve al panel propio: al abrir un disco desde New releases o el panel de un sello se recuerda la entrada del
  // historial desde la que se salió (Navigation API pública: clave de la entrada, sin tocar history.state de Apple), con
  // el scroll del panel. Al volver a esa entrada por cualquier camino (Back propio, Alt+Left, historial), el panel se
  // reabre como con su botón y con el mismo scroll. Cerrar el panel o salir de esa página sin el panel lo olvida.
  // Log panel-return: tipo 0 New releases, 1 sello; scroll aplicado (px) o -1 si no se pudo; ms hasta aplicarlo.
  const panelReturns = new Map();
  let panelLeaving = null;
  const panelRequest = panel => panel.dataset.kind === 'new-releases' ? 'new-releases' : /^[amp][a-f\d-]{1,40}$/.test(lastLabelKey) ? 'open/' + lastLabelKey : '';
  document.addEventListener('click', event => {
    const panel = document.getElementById('el-music-label-panel');
    if (!panel || !(event.target instanceof Element)) return;
    if (event.target.closest('[data-close-labels]') && panel.contains(event.target)) { panelReturns.delete(globalThis.navigation?.currentEntry?.key); return; }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]'), request = link && panel.contains(link) && link.dataset?.elMusicInline !== 'true' ? panelRequest(panel) : '';
    if (request) panelLeaving = { request, scroll: Math.round(panel.scrollTop), at: performance.now() };
  }, true);
  globalThis.navigation?.addEventListener?.('navigate', event => {
    if (event.navigationType !== 'push') return;
    // Durante el evento navigate la entrada actual todavía es la de partida.
    const key = globalThis.navigation.currentEntry?.key; if (!key) return;
    if (panelLeaving && performance.now() - panelLeaving.at < 3000) {
      panelReturns.delete(key); panelReturns.set(key, panelLeaving);
      if (panelReturns.size > 30) panelReturns.delete(panelReturns.keys().next().value);
    } else panelReturns.delete(key);
    panelLeaving = null;
  });
  // Panel escondido al salir de su página: al empezar una navegación (enlace, barra lateral, LCD, Forward) el panel visible
  // se esconde sin cerrarse (visibility: hidden conserva su scroll, su disco desplegado y lo que sigue cargando); al volver
  // a la entrada del historial donde se abrió se muestra en el evento navigate, antes de que Apple dibuje la página de abajo,
  // así Back va directo al panel. Log panel-park: accion 0 escondido, 1 mostrado al volver, 2 mostrado desde el LCD.
  const showParkedPanel = (panel, here) => {
    panel.classList.remove('el-music-panel--parked');
    if (here) panel.dataset.entryKey = globalThis.navigation?.currentEntry?.key || '';
    syncReleasesPanel(); pageLog('panel-park', { accion: here ? 2 : 1, tipo: panel.dataset.kind === 'new-releases' ? 0 : 1, scroll: Math.round(panel.scrollTop) });
  };
  let lastNavigateAt = 0;
  globalThis.navigation?.addEventListener?.('navigate', event => {
    lastNavigateAt = performance.now();
    const panel = document.getElementById('el-music-label-panel');
    if (!panel || event.navigationType === 'reload') return;
    const parked = panel.classList.contains('el-music-panel--parked');
    // Un replace del enrutador que cambia de ruta deja otra página bajo el panel visible: se cierra, como antes hacía main.
    // Un replace de la misma ruta (sólo la query) no lo toca.
    if (event.navigationType === 'replace') {
      let path = ''; try { path = new URL(event.destination?.url || '').pathname; } catch {}
      if (!parked && path && path !== location.pathname) panel.querySelector('[data-close-labels]')?.click();
      return;
    }
    if (event.navigationType === 'traverse' && panel.dataset.entryKey && event.destination?.key === panel.dataset.entryKey) { if (parked) showParkedPanel(panel, false); return; }
    if (parked) return;
    panel.classList.add('el-music-panel--parked'); syncReleasesPanel();
    pageLog('panel-park', { accion: 0, tipo: panel.dataset.kind === 'new-releases' ? 0 : 1, scroll: Math.round(panel.scrollTop) });
  });
  const reopenPanel = saved => {
    const open = document.getElementById('el-music-label-panel');
    if (open && !open.classList.contains('el-music-panel--parked')) return;
    document.querySelector('#el-music-recommendation-panel [data-close-recommendations]')?.click();
    sendLabelRequest(saved.request);
    // Mismo scroll, cuando el panel ya tiene sus discos y alcanza esa altura (o pasado 1,5 s, con lo que haya); hasta 10 s.
    const since = performance.now();
    const applyScroll = () => {
      const panel = document.getElementById('el-music-label-panel'), elapsed = performance.now() - since;
      if (panel && panel.querySelector('.el-music-label-grid > li') && (panel.scrollHeight - panel.clientHeight >= saved.scroll || elapsed > 1500)) {
        panel.scrollTop = saved.scroll;
        pageLog('panel-return', { tipo: saved.request === 'new-releases' ? 0 : 1, scroll: Math.round(panel.scrollTop), ms: Math.round(elapsed) }); return;
      }
      if (elapsed < 10000) setTimeout(applyScroll, 100); else pageLog('panel-return', { tipo: saved.request === 'new-releases' ? 0 : 1, scroll: -1, ms: Math.round(elapsed) });
    };
    applyScroll();
  };
  globalThis.navigation?.addEventListener?.('currententrychange', event => {
    if (event.navigationType !== 'traverse') return;
    const saved = panelReturns.get(globalThis.navigation.currentEntry?.key);
    // Un instante después: main cierra los paneles al empezar cada navegación y el pedido tiene que llegarle después.
    if (saved) setTimeout(() => reopenPanel(saved), 150);
  });
  // LCD en dos filas: arriba la canción; abajo
  // «by Artista from Álbum», con «by» y «from» en gris. Apple dibuja «artista — álbum» sin rótulos, pegado a la zona
  // clickeable de su barra de progreso (22 px de alto, de 21 a 43 px del LCD): nuestras filas van de 4 a 32 px, encima de
  // esa zona, y la franja de progreso baja 4 px (pista a 36 px), con el mismo espacio arriba del texto que hasta la pista.
  // Los textos de Apple quedan invisibles pero en su lugar (main y el seguimiento los siguen leyendo). Artista y álbum
  // hacen clic en los botones de Apple, con sus listeners; la canción vuelve al origen del Play (openSource) y, sin origen,
  // abre el disco. Con un Play esperando, las mismas filas muestran lo pedido y «…» en lo que todavía no se sabe; nunca
  // cambia la forma. Se copia sólo texto (textContent), nunca HTML de la página.
  const lcdLine = document.createElement('div'); lcdLine.id = 'el-music-lcd-line'; lcdLine.hidden = true;
  const lcdTop = document.createElement('div'); lcdTop.className = 'el-music-lcd-line__top';
  const lcdBottom = document.createElement('div'); lcdBottom.className = 'el-music-lcd-line__bottom';
  lcdLine.append(lcdTop, lcdBottom);
  const lcdFragments = () => [...document.querySelectorAll('.chrome-player [data-testid="lcd-metadata"] .marquee--secondary .marquee-line__scrolling-text-chunk:not(.marquee-line__scrolling-text-chunk--copy) [data-testid="marquee-text-item"]')].slice(0, 12);
  const lcdClean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const lcdArtistItems = () => {
    const fragments = lcdFragments(), separator = fragments.findIndex(item => lcdClean(item.textContent) === '—');
    return { fragments, separator, artistItems: separator < 0 ? fragments.slice(0, 1) : fragments.slice(0, separator) };
  };
  const lcdPart = (tag, className, text) => { const part = document.createElement(tag); part.className = className; part.textContent = text; if (tag === 'button') part.type = 'button'; return part; };
  const lcdMissing = () => { const part = lcdPart('span', 'el-music-lcd-line__missing', '…'); part.setAttribute('aria-label', 'Loading'); return part; };
  const lcdWord = text => { const part = lcdPart('span', 'el-music-lcd-line__word', text); part.setAttribute('aria-hidden', 'true'); return part; };
  let lcdSignature = '';
  const renderLcdLine = () => {
    const metadata = document.querySelector('.chrome-player .player-lcd__metadata');
    const host = metadata || document.querySelector('.chrome-player__lcd');
    const { fragments, separator, artistItems } = lcdArtistItems();
    const albumItem = separator >= 1 && separator === fragments.length - 2 ? fragments[separator + 1] : null;
    // Con un Play esperando, lo pedido; si no, lo que muestra Apple. live: hay botones de Apple para el artista y el álbum.
    const live = !pending;
    const title = live ? lcdTitle() : pendingInfo.song;
    const artists = live ? artistItems.map(item => lcdClean(item.textContent)) : [pendingInfo.artist];
    const album = live ? lcdClean(albumItem?.textContent) : pendingInfo.album;
    const show = !!host && (!live || !!title && artists.some(Boolean));
    if (host && lcdLine.parentElement !== host) host.appendChild(lcdLine);
    lcdLine.classList.toggle('el-music-lcd-line--free', !metadata);
    document.documentElement.classList.toggle('el-music-lcd-rows', show);
    lcdLine.hidden = !show;
    const signature = show ? JSON.stringify([live, title, artists, album]) : '';
    if (signature === lcdSignature) return;
    lcdSignature = signature;
    if (!show) return;
    // Canción: siempre clickeable (origen del Play o, sin él, el disco); «…» mientras no se sabe.
    if (title) {
      const song = lcdPart('button', 'el-music-lcd-line__title', title); song.title = title + ' — Go to where it was played';
      song.addEventListener('click', event => { if (event.detail > 0) song.blur(); openSource(); });
      lcdTop.replaceChildren(song);
    } else lcdTop.replaceChildren(lcdMissing());
    // Varios artistas: Apple pone un fragmento por artista (con su botón) y separadores de texto entre ellos. El botón de
    // Apple se busca al hacer clic (por posición y texto): Apple redibuja los fragmentos con el mismo texto.
    const artistParts = artists.some(Boolean) ? artists.map((text, index) => {
      if (!live || !artistItems[index]?.querySelector('[data-testid="marquee-text-item-button"]')) return lcdPart('span', live ? 'el-music-lcd-line__plain' : 'el-music-lcd-line__artist', text);
      const button = lcdPart('button', 'el-music-lcd-line__artist', text); button.title = 'Open artist ' + text;
      button.addEventListener('click', event => {
        if (event.detail > 0) button.blur();
        const now = lcdArtistItems().artistItems[index], source = now?.querySelector('[data-testid="marquee-text-item-button"]');
        pageLog('play-source', { via: 11 });
        if (source instanceof HTMLButtonElement && !source.disabled && lcdClean(now.textContent) === button.textContent) { busyForButton('artist', button.textContent); source.click(); }
      });
      return button;
    }) : [lcdMissing()];
    let albumPart = lcdMissing();
    if (album && live) {
      albumPart = lcdPart('button', 'el-music-lcd-line__album', album); albumPart.title = 'Open album ' + album;
      albumPart.addEventListener('click', event => { if (event.detail > 0) albumPart.blur(); pageLog('play-source', { via: 10 }); const button = readPlaying().albumButton; if (button) { busyForButton('album', button.textContent); button.click(); } });
    } else if (album) albumPart = lcdPart('span', 'el-music-lcd-line__album', album);
    const artistBox = lcdPart('span', 'el-music-lcd-line__artists', ''); artistBox.append(...artistParts);
    lcdBottom.replaceChildren(lcdWord('by'), artistBox, lcdWord('from'), albumPart);
  };
  const syncLcdLine = () => renderLcdLine();
  let playbackBound = false;
  const bindPlayback = () => {
    if (playbackBound) return;
    try {
      const kit = globalThis.MusicKit, music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined;
      if (typeof music?.addEventListener !== 'function') return;
      music.addEventListener('playbackStateDidChange', event => { if (pending && Number(event?.state) === 2) settlePending(1); });
      // Cola de discos (main la alarga con los discos siguientes): con una activa, cada cambio de tema o de posición despierta
      // a main con un mensaje de consola fijo, sin datos.
      const wakeQueue = () => { if (document.documentElement.dataset.elMusicAlbumQueue === '1') console.debug('elMusic.albumQueue.tick'); };
      music.addEventListener('nowPlayingItemDidChange', wakeQueue); music.addEventListener('queuePositionDidChange', wakeQueue);
      playbackBound = true;
    } catch { /* sin MusicKit todavía; se reintenta en el próximo apply */ }
  };
  // Disco que suena en las listas de discos: la fila cuyo álbum y artista coinciden con el LCD público
  // lleva el ▶ rojo a la izquierda, como la fila que suena en las playlists. Se revisa al cambiar el LCD y al redibujar la tabla.
  const lcdSecondary = () => {
    const items = [...document.querySelectorAll('.chrome-player [data-testid="lcd-metadata"] .marquee--secondary .marquee-line__scrolling-text-chunk:not(.marquee-line__scrolling-text-chunk--copy) [data-testid="marquee-text-item"]')]
      .slice(0, 12).map(item => item.textContent.replace(/\s+/g, ' ').trim());
    const separator = items.indexOf('—');
    return { artist: items[0] || '', album: separator >= 1 ? items.slice(separator + 1).join(' ').trim() : '' };
  };
  const normalize = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Las tarjetas de los paneles propios también: la que suena queda marcada (borde y Play visibles). En el disco desplegado,
  // el tema que suena (mismo disco y mismo título que el LCD). Cuando el disco que suena pasa a otra tarjeta de la lista
  // (Next, o el final de un disco), el panel recibe el-music:playing-release y el desplegado pasa a ese disco.
  let playingRelease = '';
  const markPlayingRelease = () => {
    const tables = document.querySelectorAll('.el-music-releases'), cards = document.querySelectorAll('#el-music-label-panel .el-music-label-grid > li');
    const release = document.querySelector('#el-music-label-panel .el-music-release:not([hidden])');
    if (!tables.length && !cards.length && !release) return;
    const now = lcdSecondary(), album = normalize(now.album), artist = normalize(now.artist);
    const matches = (title, other) => !!album && normalize(title) === album && (!artist || normalize(other).includes(artist) || artist.includes(normalize(other)));
    for (const table of tables) for (const row of table.querySelectorAll('tbody tr')) {
      const playing = matches(row.querySelector('td[data-key="title"]')?.textContent, row.querySelector('td[data-key="artist"]')?.textContent);
      if (row.classList.contains('is-playing') !== playing) row.classList.toggle('is-playing', playing);
    }
    let playingCard = '';
    for (const card of cards) {
      const playing = matches(card.dataset.title, card.dataset.artist);
      if (card.classList.contains('is-playing') !== playing) card.classList.toggle('is-playing', playing);
      if (playing && !playingCard) playingCard = card.dataset.id || '';
    }
    if (release) {
      const song = matches(release.dataset.title, release.dataset.artist) ? normalize(lcdTitle()) : '';
      for (const row of release.querySelectorAll('.el-music-release__track')) {
        const playing = !!song && normalize(row.dataset.title) === song;
        if (row.classList.contains('is-playing') !== playing) row.classList.toggle('is-playing', playing);
      }
    }
    if (playingCard !== playingRelease) {
      playingRelease = playingCard;
      if (playingCard) dispatchEvent(new CustomEvent('el-music:playing-release', { detail: { id: playingCard } }));
    }
  };
  addEventListener('el-music:releases-rendered', markPlayingRelease);
  // Marca los fragmentos de artista (antes del separador «—») para colorearlos; incluye la copia del marquee.
  const markArtists = player => {
    for (const line of player.querySelectorAll('[data-testid="lcd-metadata"] .marquee--secondary .marquee-line__text-content')) {
      const items = [...line.querySelectorAll('[data-testid="marquee-text-item"]')].slice(0, 12);
      const separator = items.findIndex(item => item.textContent.trim() === '—');
      items.forEach((item, index) => {
        const artist = separator < 0 ? index === 0 : index < separator;
        if (artist && !item.hasAttribute('data-el-music-artist')) item.setAttribute('data-el-music-artist', '');
        else if (!artist && item.hasAttribute('data-el-music-artist')) item.removeAttribute('data-el-music-artist');
      });
    }
  };
  // Listas de canciones con columna Álbum (playlists): orden por columna y columna Label.
  // El orden sólo mueve las filas visibles; la playlist y la cola de Apple no cambian. data-row guarda el orden original.
  const labelStore = document.documentElement[Symbol.for('el-music.playlist-labels')] ||= new Map();
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  // Clave del álbum de la fila: su ID si Apple puso el enlace; si no (tandas de biblioteca cargadas después), artista y
  // nombre del álbum, armada igual que en main (playlist-labels.ts, nameKey). El enlace propio (linkAlbum) no cambia la
  // clave: con él la fila pasaba a la del ID, quedaba sin sello un momento y main pedía el álbum otra vez (0.1.50).
  const albumOf = row => {
    const cell = row.querySelector('.songs-list__col--tertiary');
    const href = cell?.querySelector('a[href]:not(.el-music-album-link)')?.getAttribute('href') || '';
    const match = href.match(/^(?:https:\/\/music\.apple\.com)?\/([a-z]{2})\/album\/(?:[^/?#]+\/)?(\d{1,20})(?:[?#]|$)/);
    if (match) return match[2];
    const clean = value => (value || '').replace(/\s+/g, ' ').trim().slice(0, 200).trim();
    const album = clean(cell?.textContent), artist = clean(row.querySelector('.songs-list__col--secondary')?.textContent);
    return album && artist ? 'n:' + artist + '\u0001' + album : '';
  };
  const rowsOf = list => [...list.children].filter(child => child.matches('.songs-list-row[data-row]'));
  // Columnas: orden, ocultas y anchos vienen de main (columns.json) en un símbolo propio;
  // cada cambio del usuario se guarda entero en un dataset que main valida. Apple dibuja la lista como tabla (table-layout
  // fixed): el orden es el orden de las celdas en el DOM y el ancho lo fija la celda del encabezado. La columna ★ queda
  // siempre primera (Apple ubica su estrella y nuestro ▶ respecto de ella) y Canción nunca se oculta.
  const columnKeys = ['song', 'artist', 'album', 'released', 'label', 'genre', 'time'];
  const columnLabels = { song: 'Song', artist: 'Artist', album: 'Album', released: 'Released', label: 'Label', genre: 'Genre', time: 'Time' };
  const ownColumns = { label: 'Label', released: 'Released', genre: 'Genre' };
  const defaultColumns = { order: ['song', 'artist', 'album', 'released', 'label', 'genre', 'time'], hidden: [], widths: {} };
  const columnsKey = Symbol.for('el-music.columns');
  const columns = () => {
    const value = document.documentElement[columnsKey];
    return value && Array.isArray(value.order) && value.order.length === columnKeys.length ? value : defaultColumns;
  };
  const saveColumns = (next, event, fields) => {
    document.documentElement[columnsKey] = next;
    document.documentElement.dataset.elMusicColumnsRequest = JSON.stringify(next);
    console.debug('elMusic.columns.changed'); pageLog(event, fields);
    for (const list of document.querySelectorAll('.songs-list')) prepareSongList(list);
  };
  const columnOf = cell => cell.dataset.elMusicCol || (cell.dataset.elMusicCol = (cell.classList.contains('songs-list__col--favorite-or-popular') ? 'favorite' :
    cell.classList.contains('songs-list__col--song') ? 'song' : cell.classList.contains('songs-list__col--secondary') ? 'artist' :
    cell.classList.contains('songs-list__col--tertiary') ? 'album' : cell.classList.contains('songs-list__col--time') ? 'time' :
    cell.classList.contains('el-music-col--label') ? 'label' : cell.classList.contains('el-music-col--released') ? 'released' :
    cell.classList.contains('el-music-col--genre') ? 'genre' : cell.classList.contains('el-music-col--artwork') ? 'artwork' : 'other'));
  // Ordena las celdas de una fila (o del encabezado) según la configuración; sólo escribe si el orden difiere.
  const arrangeCells = (row, config) => {
    const cells = [...row.children].filter(cell => cell.matches('.songs-list__col,.songs-list__header-col,.el-music-col'));
    const byKey = new Map(cells.map(cell => [columnOf(cell), cell]));
    const wanted = [byKey.get('favorite'), byKey.get('artwork'), ...config.order.map(key => byKey.get(key)),
      ...cells.filter(cell => !columnKeys.includes(columnOf(cell)) && !['favorite', 'artwork'].includes(columnOf(cell)))].filter(Boolean);
    for (const cell of cells) {
      const key = columnOf(cell), hidden = config.hidden.includes(key);
      if (cell.classList.contains('el-music-col--hidden') !== hidden) cell.classList.toggle('el-music-col--hidden', hidden);
    }
    if (wanted.every((cell, index) => cell === cells[index])) return false;
    for (const cell of wanted) row.appendChild(cell);
    return true;
  };
  const infoStore = document.documentElement[Symbol.for('el-music.playlist-info')] ||= new Map();
  // Aviso a main: con claves de álbum nuevas sin sello, o al hacer
  // scroll mientras falten sellos o fechas, un mensaje de consola fijo y sin datos despierta el sondeo de sellos de main
  // (playlist-labels.ts) en vez de esperar su intervalo; main sólo vuelve a leer las filas con su propio script.
  const labelsWake = 'elMusic.labels.rows', wakeKeys = new Set();
  let labelsMissing = 0, labelsWakeAt = -Infinity;
  const wakeLabels = () => { labelsWakeAt = performance.now(); console.debug(labelsWake); };
  addEventListener('scroll', () => { if (labelsMissing && performance.now() - labelsWakeAt > 400) wakeLabels(); }, { capture: true, passive: true });
  // Favorito: el botón propio de Apple en la fila (.favorite.is-favorited). «0» ordena los favoritos primero en asc.
  const cellText = (row, key) => {
    if (key === 'favorite') return row.querySelector('.songs-list__col--favorite-or-popular .favorite.is-favorited') ? '0' : '1';
    if (key === 'time') return String(duration(row)).padStart(8, '0');
    const cell = key === 'song' ? row.querySelector('.songs-list__col--song [data-testid="track-title"]') : key === 'artist' ? row.querySelector('.songs-list__col--secondary') :
      key === 'album' ? row.querySelector('.songs-list__col--tertiary') : row.querySelector('.el-music-col--' + key);
    return cell?.textContent.replace(/\s+/g, ' ').trim().replace(/^—$/, '').replace(/^℗ /, '') || '';
  };
  const applySort = list => {
    const rows = rowsOf(list); if (rows.length < 2) return;
    const [key, direction] = (list.dataset.elMusicSort || '').split(':');
    const original = row => Number(row.dataset.row) || 0;
    const keys = key ? new Map(rows.map(row => [row, cellText(row, key)])) : undefined;
    const sorted = [...rows].sort((a, b) => {
      if (keys) {
        const left = keys.get(a), right = keys.get(b);
        if (!left !== !right) return left ? -1 : 1; // Vacíos (sello sin cargar) siempre al final.
        const order = collator.compare(left, right) * (direction === 'desc' ? -1 : 1);
        if (order) return order;
      }
      return original(a) - original(b);
    });
    if (sorted.every((row, index) => row === rows[index])) return;
    const anchor = rows.at(-1).nextSibling;
    for (const row of sorted) list.insertBefore(row, anchor);
  };
  // Sello clickeable: main publica una clave opaca por álbum y sólo esa clave vuelve en el pedido.
  const labelLinks = document.documentElement[Symbol.for('el-music.playlist-label-links')] ||= new Map();
  const fillLabel = (cell, album) => {
    const value = album ? labelStore.get(album) : null;
    const text = value === undefined ? '' : value || '—';
    const key = value ? labelLinks.get(album) : undefined, current = cell.firstElementChild;
    if (key) {
      if (current?.dataset.elMusicLabel !== key || current.textContent !== text) {
        const link = document.createElement('a'); link.href = '#'; link.className = 'el-music-label-link'; link.dataset.elMusicLabel = key;
        link.title = 'Music from this label'; link.textContent = text; cell.replaceChildren(link);
      }
    } else if (current || cell.textContent !== text) cell.textContent = text;
    cell.classList.toggle('el-music-col--pending', value === undefined && !!album);
  };
  // Estado de la columna Label por lista, para el log: filas sin
  // clave de álbum, pendientes de main, sin dato («—»), con error y con sello. Se registra cuando cambia; mientras quedan
  // pendientes, como mucho cada 3 s (con una lectura diferida para no perder el estado final).
  const labelReportTimers = new WeakMap();
  const reportLabels = list => {
    const rows = rowsOf(list); let sinClave = 0, pendientes = 0, sinDato = 0, errores = 0, conSello = 0;
    for (const row of rows) {
      const id = albumOf(row);
      if (!id) { sinClave++; continue; }
      const value = labelStore.get(id);
      if (value === undefined) pendientes++; else if (value === null) errores++; else if (value) conSello++; else sinDato++;
    }
    const state = [rows.length, sinClave, pendientes, sinDato, errores, conSello].join(',');
    if (state === list.dataset.elMusicLabelState) return;
    const now = performance.now(), wait = Number(list.dataset.elMusicLabelStateAt || -Infinity) + 3000 - now;
    if (pendientes && wait > 0) {
      if (!labelReportTimers.has(list)) labelReportTimers.set(list, setTimeout(() => { labelReportTimers.delete(list); reportLabels(list); }, wait));
      return;
    }
    list.dataset.elMusicLabelState = state; list.dataset.elMusicLabelStateAt = String(now);
    pageLog('labels-state', { filas: rows.length, sinClave, pendientes, sinDato, errores, conSello });
  };
  const labelLinkOf = event => event.target instanceof Element ? event.target.closest('.songs-list .el-music-label-link') : null;
  document.addEventListener('click', event => {
    const link = labelLinkOf(event); if (!link) return;
    event.preventDefault(); event.stopPropagation();
    const key = link.dataset.elMusicLabel || '';
    if (!/^[amp][a-f\d-]{1,40}$/.test(key)) return;
    lastLabelKey = key; // para volver a abrir ese panel desde la canción del LCD
    document.querySelector('#el-music-recommendation-panel [data-close-recommendations]')?.click();
    sendLabelRequest('open/' + key);
  }, true);
  // Doble clic en la fila reproduce el tema: sobre el sello no debe hacerlo.
  document.addEventListener('dblclick', event => { if (labelLinkOf(event)) event.stopPropagation(); }, true);
  // Tema que suena: Apple marca la fila con is-playing/is-loading. Si la fila anterior estaba a la vista, o es
  // la primera en esta lista (play o shuffle recién dado), se lleva la nueva al centro. Si el usuario se fue a otra parte de
  // la lista, no se la mueve.
  // Durante el refresco de una playlist tras un agregado la lista se recrea; manda el scroll restaurado, no el tema que suena.
  let refreshedAt = 0;
  const followPlaying = list => {
    const row = list.querySelector(':scope > .songs-list-row.is-playing, :scope > .songs-list-row.is-loading');
    const id = row?.dataset.row || '', previous = list.dataset.elMusicPlayingRow || '';
    if (!row || id === previous) { if (!row && !list.querySelector(':scope > .songs-list-row.is-paused')) delete list.dataset.elMusicPlayingRow; return; }
    list.dataset.elMusicPlayingRow = id;
    // Fila que Apple ya marca como cargando: aviso inmediato en el LCD con su título y artista.
    // Respaldo del origen para un Play que no pasó por los listeners (por ejemplo, el menú contextual de Apple): sólo si
    // hubo un clic o una tecla en los últimos 3 s; el avance natural de la cola no cambia el origen.
    if (row.classList.contains('is-loading')) {
      rowPending({ song: cellText(row, 'song'), artist: cellText(row, 'artist'), album: cellText(row, 'album') });
      if (performance.now() - lastUserInput < 3000 && playSource?.path !== currentPath()) rememberSource('page');
    }
    const onScreen = element => { const box = element.getBoundingClientRect(); return box.bottom > 70 && box.top < innerHeight - 40; };
    const before = previous ? list.querySelector(':scope > .songs-list-row[data-row="' + CSS.escape(previous) + '"]') : null;
    if (Date.now() - refreshedAt < 6000) return;
    if ((!previous || before && onScreen(before)) && !onScreen(row)) {
      // Lejos (más de dos pantallas, típico de un Shuffle en una playlist larga) el salto es instantáneo: el scroll suave
      // pasaba por cientos de filas y cada una dejaba pedida su portada (img lazy de Apple, que no se cancela al salir de
      // la vista); las de destino quedaban al final de esa cola y la página se arrastraba mientras se cargaban todas.
      const distance = Math.round(row.getBoundingClientRect().top - innerHeight / 2), far = Math.abs(distance) > innerHeight * 2;
      row.scrollIntoView({ block: 'center', behavior: far ? 'instant' : 'smooth' });
      lastFollowScroll = performance.now();
      pageLog('follow-playing', { distancia: distance, suave: far ? 0 : 1, filas: rowsOf(list).length });
    }
  };
  // Fecha de lanzamiento y género del álbum (mismo pedido de catálogo que el sello): '' mientras no llegan.
  const fillInfo = (cell, album, field) => {
    const value = album ? infoStore.get(album)?.[field] : undefined;
    const text = value === undefined ? (album && labelStore.get(album) === undefined ? '' : '—') : value || '—';
    if (cell.textContent !== text) cell.textContent = text;
    cell.classList.toggle('el-music-col--pending', !text && !!album);
  };
  // Portada siempre a la izquierda: la celda Canción de Apple trae portada y título juntos. La
  // portada (con el rango y el botón de reproducción de Apple) pasa a una celda fija propia después de ★, que no se mueve ni
  // se oculta; el título queda en la celda Canción, que sí se reordena. Si Apple vuelve a dibujar la celda, se repite.
  const placeArtwork = row => {
    const songCell = row.querySelector(':scope > .songs-list__col--song'); if (!songCell) return;
    let cell = row.querySelector(':scope > .el-music-col--artwork');
    const container = songCell.querySelector(':scope > .songs-list-row__song-container') || cell?.querySelector(':scope > .songs-list-row__song-container');
    if (!container) return;
    const wrapper = container.querySelector(':scope > .songs-list-row__song-wrapper');
    if (!wrapper && container.parentElement === cell) return;
    if (!cell) {
      // Clon de la celda ★ para heredar las clases de Apple (su display: table-cell va por clase svelte); sin ellas sería un bloque.
      const favorite = row.querySelector(':scope > .songs-list__col--favorite-or-popular');
      cell = favorite ? favorite.cloneNode(false) : document.createElement('div'); cell.classList.remove('songs-list__col--favorite-or-popular'); delete cell.dataset.elMusicCol;
      cell.classList.add('songs-list__col', 'el-music-col', 'el-music-col--artwork'); cell.setAttribute('role', 'cell'); cell.dataset.testid = 'el-music-track-column-artwork';
      if (favorite) favorite.after(cell); else row.prepend(cell);
    }
    if (container.parentElement !== cell) cell.replaceChildren(container);
    if (wrapper) { const stale = songCell.querySelector(':scope > .songs-list-row__song-wrapper'); if (stale && stale !== wrapper) stale.remove(); songCell.appendChild(wrapper); }
  };
  // Ancho de la columna de portada: la suma de las pistas de la grilla de Apple (portada, rango) más su relleno, una vez por lista.
  const sizeArtworkHeader = (list, header) => {
    const column = header.querySelector(':scope > .el-music-col--artwork'); if (!column || column.style.width) return;
    const container = list.querySelector('.songs-list-row > .el-music-col--artwork > .songs-list-row__song-container'); if (!container) return;
    const style = getComputedStyle(container), tracks = style.gridTemplateColumns.split(' ').map(parseFloat).filter(Number.isFinite);
    const width = tracks.reduce((sum, value) => sum + value, 0) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    if (width > 20) column.style.width = Math.ceil(width + 4) + 'px';
  };
  // Álbum clickeable: en las tandas de biblioteca Apple deja el álbum sin enlace; con el ID de
  // catálogo que main encontró al buscar el sello se arma uno propio, con la misma navegación del enrutador de Apple
  // (pushState + popstate) que usan los enlaces del panel de sellos, así Back vuelve a la lista.
  const pageCountry = () => location.pathname.match(/^\/([a-z]{2})(?:\/|$)/)?.[1] || [...document.querySelectorAll('.navigation a[href]')].map(link => link.getAttribute('href') || '')
    .map(href => href.match(/^(?:https:\/\/music\.apple\.com)?\/([a-z]{2})\/(?:home|new|radio|search|browse)(?:[\/?#]|$)/)?.[1]).find(Boolean);
  const linkAlbum = (album, id) => {
    if (!id.startsWith('n:') || album.querySelector('a[href]')) return;
    const catalog = infoStore.get(id)?.album; if (!catalog || !/^\d{1,20}$/.test(catalog)) return;
    const country = pageCountry(), text = album.textContent.replace(/\s+/g, ' ').trim(); if (!country || !text) return;
    const link = document.createElement('a'); link.className = 'el-music-album-link'; link.href = 'https://music.apple.com/' + country + '/album/' + catalog; link.textContent = text;
    link.addEventListener('click', event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation(); pageLog('album-link', { clave: catalog });
      history.pushState(null, '', link.href); dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    album.replaceChildren(link);
  };
  // Artista clickeable y en violeta:
  // Apple enlaza el artista sólo en la primera tanda de una playlist de biblioteca; ordenada por artista, las filas de
  // tandas distintas se mezclan. En las filas sin enlace, cada nombre de artista que aparezca entero en el texto de la celda
  // se enlaza con el ID de catálogo que trajo el pedido /albums del sello (artistas del álbum) o, si todavía no llegó, con
  // el enlace de Apple del mismo nombre en otra fila de la lista. Misma navegación que el enlace de álbum propio.
  const artistAliases = list => {
    const aliases = new Map();
    for (const link of list.querySelectorAll(':scope > .songs-list-row > .songs-list__col--secondary a[href*="/artist/"]:not(.el-music-artist-link)')) {
      const name = link.textContent.replace(/\s+/g, ' ').trim().toLowerCase(), href = link.getAttribute('href') || '';
      if (name && !aliases.has(name) && /^(?:https:\/\/music\.apple\.com)?\/[a-z]{2}\/artist\/(?:[^/?#]+\/)?\d{1,20}$/.test(href)) aliases.set(name, new URL(href, location.origin).href);
      if (aliases.size >= 2000) break;
    }
    return aliases;
  };
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkArtists = (cell, id, aliases) => {
    if (!cell || cell.querySelector('a[href]')) return;
    const text = cell.textContent.replace(/\s+/g, ' ').trim(); if (!text || text.length > 400) return;
    // Sin datos nuevos (artistas del álbum o enlaces de otras filas) no se vuelve a intentar en cada pasada.
    const stamp = (id || '') + '|' + aliases.size + '|' + ((id && infoStore.get(id)?.artists?.length) ?? -1);
    if (cell.dataset.elMusicArtistTry === stamp) return;
    cell.dataset.elMusicArtistTry = stamp;
    const country = pageCountry(), known = new Map();
    for (const [name, artist] of (id && infoStore.get(id)?.artists) || []) if (country && /^\d{1,20}$/.test(artist)) known.set(name.toLowerCase(), 'https://music.apple.com/' + country + '/artist/' + artist);
    for (const [name, href] of aliases) if (!known.has(name)) known.set(name, href);
    const names = [...known.keys()].filter(name => text.toLowerCase().includes(name)).sort((a, b) => b.length - a.length);
    if (!names.length) return;
    // Nombre entero: ni letra ni número pegados antes o después («Rae» no se enlaza dentro de «Raedio»).
    const pattern = new RegExp('(?<![\\p{L}\\p{N}])(?:' + names.map(escapeRegExp).join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
    const parts = []; let at = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > at) parts.push(text.slice(at, match.index));
      const link = document.createElement('a'); link.className = 'el-music-artist-link'; link.href = known.get(match[0].toLowerCase()); link.textContent = match[0];
      link.addEventListener('click', event => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); event.stopPropagation(); pageLog('artist-link', { clave: link.href.split('/').pop() });
        history.pushState(null, '', link.href); dispatchEvent(new PopStateEvent('popstate', { state: null }));
      });
      parts.push(link); at = match.index + match[0].length;
    }
    if (!at) return;
    if (at < text.length) parts.push(text.slice(at));
    cell.replaceChildren(...parts);
  };
  let suppressSortClick = 0;
  let windowErrors = 0;
  globalThis.addEventListener?.('error', event => { if (windowErrors++ < 20) pageLog('error', { donde: 'window', texto: String(event.message || '').slice(0, 100) + ' @ ' + String(event.filename || '').split('/').pop().slice(0, 40) + ':' + (event.lineno || 0) }); });
  // Gesto del encabezado en curso (mover o redimensionar): mientras dura se bloquea el arrastre nativo de Apple.
  let headerGesture = false;
  // Ningún ancho guardado deja sin lugar a otra columna (con Label a 501 px, en una ventana real la suma de anchos
  // en px pasaba el de la lista; la tabla fija se desbordaba y Álbum, la única en porcentaje, quedaba en 0 px, así que los
  // sellos parecían la columna de álbum). Al cambiar la configuración o el ancho disponible se mide una vez el encabezado:
  // si sobra tabla o una columna visible quedó por debajo de 64 px, ésta recibe 100 px y los anchos guardados de más de 120
  // px se achican, proporcionalmente y sólo en pantalla, lo que haga falta para entrar; columns.json no cambia.
  const fits = new WeakMap(), listWidths = new WeakMap();
  const fitKey = (list, config) => JSON.stringify([config.widths, config.hidden, config.order]) + '|' + (listWidths.get(list) ?? 0);
  const shownWidths = (list, config) => { const fit = fits.get(list); return fit?.key === fitKey(list, config) ? fit.widths : config.widths; };
  const fitColumns = (list, header, config) => {
    const key = fitKey(list, config); if (fits.get(list)?.key === key) return;
    let widths = config.widths;
    // Ancho para la tabla: el interior de su contenedor menos los márgenes de la tabla (sin ellos, los «…» de cada fila
    // quedaban afuera). Lo que la tabla mide de verdad no sirve: crece al desbordarse.
    const parent = list.parentElement, outer = parent ? getComputedStyle(parent) : null, own = getComputedStyle(list), px = value => parseFloat(value) || 0;
    const available = outer ? parent.clientWidth - px(outer.paddingLeft) - px(outer.paddingRight) - px(own.marginLeft) - px(own.marginRight) : 0;
    if (Object.keys(widths).length && available > 200) {
      const cells = [...header.children].filter(cell => cell.matches('[data-el-music-col]') && !cell.classList.contains('el-music-col--hidden'));
      const measured = new Map(cells.map(cell => [columnOf(cell), cell.getBoundingClientRect().width]));
      const total = [...measured.values()].reduce((sum, width) => sum + width, 0);
      const narrow = [...measured].filter(([name, width]) => columnKeys.includes(name) && width < 64 && !config.widths[name]);
      const cut = Math.max(0, total - available) + narrow.reduce((sum, [, width]) => sum + 100 - width, 0);
      if (cut > 1) {
        const shrinkable = Object.entries(widths).filter(([name, width]) => measured.has(name) && width > 120);
        const spare = shrinkable.reduce((sum, [, width]) => sum + width - 120, 0), share = spare > 0 ? Math.min(1, cut / spare) : 0;
        widths = { ...widths };
        for (const [name, width] of shrinkable) widths[name] = Math.round(width - (width - 120) * share);
        for (const [name] of narrow) widths[name] = 100;
        for (const cell of cells) { const name = columnOf(cell); if (widths[name]) cell.style.width = widths[name] + 'px'; }
        pageLog('columns-fit', { clave: narrow.map(([name]) => name).join(',') || '-', sobra: Math.round(total - available), recorte: Math.round(cut), achicables: Math.round(spare), ancho: Math.round(available) });
      }
    }
    fits.set(list, { key, widths });
  };
  const prepareSongList = list => {
    const header = list.querySelector(':scope > .songs-list__header'), albumHeader = header?.querySelector('.songs-list__header-col--tertiary');
    if (!header || !albumHeader) return;
    const config = columns(), shown = shownWidths(list, config);
    for (const [key, text] of Object.entries(ownColumns)) {
      if (header.querySelector('.el-music-col--' + key)) continue;
      const column = albumHeader.cloneNode(false), label = albumHeader.firstElementChild?.cloneNode(false) || document.createElement('div');
      column.classList.remove('songs-list__col--tertiary', 'songs-list__header-col--tertiary'); column.classList.add('el-music-col', 'el-music-col--' + key);
      column.dataset.testid = 'el-music-column-header-' + key; label.textContent = text; column.appendChild(label);
      albumHeader.after(column);
    }
    const favoriteHeader = header.querySelector('.songs-list__header-col--favorite-or-popular');
    if (!header.querySelector(':scope > .el-music-col--artwork')) {
      const column = favoriteHeader ? favoriteHeader.cloneNode(false) : document.createElement('div'); column.classList.remove('songs-list__col--favorite-or-popular', 'songs-list__header-col--favorite-or-popular'); delete column.dataset.elMusicCol;
      column.classList.add('songs-list__col', 'songs-list__header-col', 'el-music-col', 'el-music-col--artwork'); column.setAttribute('role', 'columnheader'); column.removeAttribute('title');
      column.dataset.testid = 'el-music-column-header-artwork'; if (favoriteHeader) favoriteHeader.after(column); else header.prepend(column);
    }
    if (favoriteHeader && !favoriteHeader.querySelector('.el-music-favorite-header')) {
      const star = document.createElement('span'); star.className = 'el-music-favorite-header'; star.textContent = '★'; star.setAttribute('aria-label', 'Favorite');
      favoriteHeader.appendChild(star);
    }
    for (const column of header.querySelectorAll('.songs-list__header-col,.el-music-col')) {
      const key = columnOf(column);
      if (key === 'other' || key === 'artwork') continue;
      if (column.dataset.elMusicSortKey !== key) {
        column.dataset.elMusicSortKey = key; column.title = 'Sort by ' + (columnLabels[key] || 'favorite').toLowerCase() + (key === 'favorite' ? '' : ' · drag to move · right-click for columns');
        column.addEventListener('click', event => {
          if (event.target.closest('.el-music-col-resize,.el-music-columns-button') || Date.now() - suppressSortClick < 400) return;
          const [current, direction] = (list.dataset.elMusicSort || '').split(':');
          list.dataset.elMusicSort = current !== key ? key + ':asc' : direction === 'asc' ? key + ':desc' : '';
          pageLog('list-sort', { clave: key, direccion: list.dataset.elMusicSort.endsWith(':asc') ? 1 : list.dataset.elMusicSort ? -1 : 0, filas: rowsOf(list).length });
          prepareSongList(list);
        });
        if (key !== 'favorite' && !column.querySelector('.el-music-col-resize')) {
          const handle = document.createElement('span'); handle.className = 'el-music-col-resize'; handle.title = 'Resize column'; column.appendChild(handle);
        }
      }
      // Sólo si cambia: reescribir el mismo valor era una escritura de atributo en el encabezado (cinco por pasada) sin
      // efecto visible. No dispara pasadas: el observador de abajo sólo mira childList.
      const [current, direction] = (list.dataset.elMusicSort || '').split(':'), sortDirection = current === key ? direction : '';
      if ((column.dataset.elMusicSortDirection ?? '') !== sortDirection) column.dataset.elMusicSortDirection = sortDirection;
      // Ancho: el guardado en px o el de Apple/CSS (porcentajes que la tabla fija reparte). Canción sin ancho guardado conserva
      // su 42 % de Apple: con 'auto' quedaba en 0 px, porque los porcentajes de las otras ya cubrían la tabla (QA 0.1.40).
      const width = key === 'favorite' ? '' : shown[key] ? shown[key] + 'px' : '';
      if (column.style.width !== width) column.style.width = width;
    }
    installColumnGestures(list, header);
    // Medidas del encabezado, una vez por lista: dónde dibuja Apple su divisor
    // (borde o pseudoelemento de la celda o de su hijo) para ubicar ahí la asa. Sólo números y palabras clave de CSS.
    if (!document.documentElement.dataset.elMusicHeaderMetrics) {
      document.documentElement.dataset.elMusicHeaderMetrics = '1';
      try {
        const describe = (element, pseudo) => { const style = getComputedStyle(element, pseudo); const box = pseudo ? null : element.getBoundingClientRect();
          return (box ? 'l=' + Math.round(box.left) + ' r=' + Math.round(box.right) + ' ' : '') + 'pl=' + style.paddingLeft + ' pr=' + style.paddingRight + ' bl=' + style.borderLeftWidth + ' br=' + style.borderRightWidth +
            (pseudo ? ' c=' + style.content.slice(0, 12) + ' pos=' + style.position + ' left=' + style.left + ' right=' + style.right + ' w=' + style.width : ''); };
        for (const column of header.querySelectorAll('.songs-list__header-col,.el-music-col')) {
          const key = columnOf(column), child = column.firstElementChild;
          if (!columnKeys.includes(key)) continue;
          pageLog('header-metrics', { clave: key, texto: describe(column) + ' | before ' + describe(column, '::before') + ' | after ' + describe(column, '::after'),
            donde: child ? 'hijo ' + describe(child) + ' | before ' + describe(child, '::before') : 'sin hijo' });
        }
      } catch (error) { pageLog('error', { donde: 'header-metrics', texto: String(error) }); }
    }
    arrangeCells(header, config);
    fitColumns(list, header, config);
    placeColumnsButton(header);
    let fresh = false, missing = 0, aliases;
    for (const row of rowsOf(list)) {
      placeArtwork(row);
      const album = row.querySelector(':scope > .songs-list__col--tertiary');
      if (!album) continue;
      const id = albumOf(row);
      linkAlbum(album, id);
      const artist = row.querySelector(':scope > .songs-list__col--secondary');
      if (artist && !artist.querySelector('a[href]')) linkArtists(artist, id, aliases ??= artistAliases(list));
      if (id) {
        const label = labelStore.get(id);
        if (label === undefined) { missing++; if (!wakeKeys.has(id)) { if (wakeKeys.size >= 5000) wakeKeys.clear(); wakeKeys.add(id); fresh = true; } }
        else if (label && !infoStore.get(id)?.released) missing++;
      }
      for (const key of Object.keys(ownColumns)) {
        let cell = row.querySelector(':scope > .el-music-col--' + key);
        if (!cell) {
          cell = album.cloneNode(false); cell.classList.remove('songs-list__col--tertiary'); cell.classList.add('el-music-col', 'el-music-col--' + key);
          cell.dataset.testid = 'el-music-track-column-' + key; album.after(cell);
        }
        if (cell.dataset.elMusicAlbum !== id) cell.dataset.elMusicAlbum = id;
        if (key === 'label') fillLabel(cell, id); else fillInfo(cell, id, key);
      }
      arrangeCells(row, config);
    }
    labelsMissing = missing;
    if (fresh) wakeLabels();
    sizeArtworkHeader(list, header);
    if (!list.dataset.elMusicColumnsLogged) { list.dataset.elMusicColumnsLogged = '1'; pageLog('columns-applied', { orden: config.order.join(','), ocultas: config.hidden.join(',') || '-', filas: rowsOf(list).length }); }
    applySort(list);
    summarize(list);
    if (revealUntil && playSource && currentPath() === playSource.path) { if (Date.now() > revealUntil) revealUntil = 0; else revealPlaying(list); }
    followPlaying(list);
    reportLabels(list);
  };
  // Gestos del encabezado: arrastrar una columna la mueve, el borde derecho la redimensiona, y el botón ⚙ (o el clic
  // derecho) abre el menú para mostrar u ocultar columnas. Cada cambio se guarda entero (saveColumns) y se registra.
  const headersReady = new WeakSet();
  const installColumnGestures = (list, header) => {
    if (headersReady.has(header)) return;
    headersReady.add(header);
    // Ancho disponible para fitColumns (el contenedor de la lista, no la tabla, que crece al desbordarse): al cambiar
    // (ventana, barra lateral, Related) se vuelve a medir el encabezado.
    try {
      if (list.parentElement) new ResizeObserver(entries => {
        const width = Math.round(entries[0].contentRect.width);
        if (listWidths.get(list) !== width) { listWidths.set(list, width); scheduleSongLists(); }
      }).observe(list.parentElement);
    } catch { /* sin ResizeObserver se ajusta sólo al cambiar la configuración */ }
    header.addEventListener('contextmenu', event => {
      const cell = event.target.closest('[data-el-music-col]'); if (!cell) return;
      event.preventDefault(); event.stopPropagation(); openColumnsMenu(event.clientX, event.clientY);
    });
    header.addEventListener('pointerdown', event => {
      try {
        let cell = event.target.closest('[data-el-music-col]');
        if (!cell || event.button !== 0 || event.target.closest('.el-music-columns-button')) return;
        let key = columnOf(cell);
        if (key === 'other' || key === 'artwork') return;
        const cells = () => [...header.querySelectorAll('[data-el-music-col]')].filter(item => !['favorite', 'other', 'artwork'].includes(columnOf(item)) && !item.classList.contains('el-music-col--hidden'));
        // Redimensión por coordenadas y no sólo por la asa. El
        // separador que se ve es el de Apple: el ::before de cada encabezado, 15 px a la izquierda de su celda, o sea 15 px
        // antes del borde derecho de la columna anterior (List CSS, songs-list__header-col:before). A 8 px de esa línea se
        // cambia el ancho de la columna a su izquierda; Canción también.
        let box = cell.getBoundingClientRect(), edge = box.right - 15;
        let resize = !!event.target.closest('.el-music-col-resize') || (key !== 'favorite' && Math.abs(edge - event.clientX) <= 8);
        // El divisor es un pseudoelemento de la celda siguiente, fuera de su caja: un clic justo sobre él llega a esa celda.
        // A 8 px de su divisor izquierdo (box.left - 15) se redimensiona la columna visible anterior.
        if (!resize && Math.abs(box.left - 15 - event.clientX) <= 8) {
          const visible = cells(), index = visible.indexOf(cell);
          if (index > 0) { cell = visible[index - 1]; key = columnOf(cell); box = cell.getBoundingClientRect(); edge = box.right - 15; resize = true; }
        }
        if (key === 'favorite') return;
        // La última columna visible no se redimensiona desde su borde derecho (es el de la tabla y ahí está el botón ⚙).
        if (resize && cell === cells().at(-1)) return;
        const startBox = cell.getBoundingClientRect(), startX = event.clientX, startWidth = startBox.width;
        // Redimensión con línea guía: mientras se arrastra sólo se mueve una línea fija
        // con el ancho; la tabla (cientos de filas con diseño fijo) se vuelve a diseñar una sola vez al soltar.
        let active = false, ghost, guide, pendingWidth, target, after = false;
        headerGesture = true;
        const move = moveEvent => { try {
          const dx = moveEvent.clientX - startX;
          if (!active) { if (Math.abs(dx) < 6) return; active = true; header.classList.add(resize ? 'el-music-header--resizing' : 'el-music-header--dragging'); cell.classList.add('el-music-col--active');
            pageLog('columns-gesture', { clave: key, tipo: resize ? 1 : 0, desdeDivisor: Math.round(edge - startX), ancho: Math.round(startWidth) });
            if (!resize) { ghost = document.createElement('div'); ghost.className = 'el-music-col-ghost'; ghost.textContent = columnLabels[key]; document.body.appendChild(ghost); }
            else { guide = document.createElement('div'); guide.className = 'el-music-col-guide'; document.body.appendChild(guide); } }
          if (resize) {
            pendingWidth = Math.max(40, Math.min(1200, Math.round(startWidth + dx)));
            guide.style.transform = 'translateX(' + Math.round(startBox.left + pendingWidth) + 'px)'; guide.dataset.width = pendingWidth + ' px';
            return;
          }
          ghost.style.transform = 'translate(' + (moveEvent.clientX + 12) + 'px,' + (moveEvent.clientY - 14) + 'px)';
          const over = cells().find(item => { const box = item.getBoundingClientRect(); return moveEvent.clientX >= box.left && moveEvent.clientX <= box.right; });
          for (const item of cells()) if (item !== over) delete item.dataset.elMusicDrop;
          if (over && over !== cell) { const box = over.getBoundingClientRect(); after = moveEvent.clientX > box.left + box.width / 2; over.dataset.elMusicDrop = after ? 'after' : 'before'; target = over; }
          else { target = undefined; }
        } catch (error) { pageLog('error', { donde: 'columns-move', texto: String(error) }); } };
        const finish = upEvent => { try {
          document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', finish);
          headerGesture = false;
          if (upEvent.type === 'pointercancel') pageLog('error', { donde: 'columns-gesture', texto: 'pointercancel con gesto ' + (active ? 'activo' : 'inicial') });
          if (!active) return;
          suppressSortClick = Date.now(); upEvent.preventDefault();
          header.classList.remove('el-music-header--resizing', 'el-music-header--dragging'); cell.classList.remove('el-music-col--active'); ghost?.remove(); guide?.remove();
          for (const item of cells()) delete item.dataset.elMusicDrop;
          const config = columns();
          if (resize) {
            if (Number.isFinite(pendingWidth) && pendingWidth >= 40 && pendingWidth !== Math.round(startWidth)) {
              cell.style.width = pendingWidth + 'px';
              saveColumns({ ...config, widths: { ...config.widths, [key]: pendingWidth } }, 'columns-resize', { clave: key, ancho: pendingWidth, antes: Math.round(startWidth) });
            }
            return;
          }
          if (!target) return;
          const order = config.order.filter(item => item !== key), targetKey = columnOf(target), index = order.indexOf(targetKey);
          if (index < 0) return;
          order.splice(index + (after ? 1 : 0), 0, key);
          if (order.join() !== config.order.join()) saveColumns({ ...config, order }, 'columns-reorder', { clave: key, orden: order.join(',') });
        } catch (error) { headerGesture = false; pageLog('error', { donde: 'columns-finish', texto: String(error) }); } };
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', finish); document.addEventListener('pointercancel', finish);
      } catch (error) { pageLog('error', { donde: 'columns-pointerdown', texto: String(error) }); }
    });
    const button = document.createElement('button'); button.type = 'button'; button.className = 'el-music-columns-button'; button.title = 'Choose columns'; button.setAttribute('aria-label', 'Choose columns');
    button.textContent = '⚙'; button.addEventListener('click', event => { event.stopPropagation(); const box = button.getBoundingClientRect(); openColumnsMenu(box.right, box.bottom); });
    button.addEventListener('pointerdown', event => event.stopPropagation());
    columnsButtons.set(header, button);
  };
  // El ⚙ vive dentro de la última celda visible del encabezado: un hijo suelto de la fila sería una columna fantasma.
  const columnsButtons = new WeakMap();
  const placeColumnsButton = header => {
    const button = columnsButtons.get(header), last = [...header.querySelectorAll('[data-el-music-col]')].filter(cell => !cell.classList.contains('el-music-col--hidden')).at(-1);
    if (button && last && button.parentElement !== last) last.appendChild(button);
  };
  // Menú de columnas: una casilla por columna (Canción siempre visible) y un botón para volver a las de fábrica.
  const openColumnsMenu = (x, y) => {
    document.getElementById('el-music-columns-menu')?.remove();
    const config = columns();
    const menu = document.createElement('div'); menu.id = 'el-music-columns-menu'; menu.setAttribute('role', 'menu');
    const title = document.createElement('div'); title.className = 'el-music-columns-menu__title'; title.textContent = 'Columns'; menu.appendChild(title);
    for (const key of config.order) {
      const label = document.createElement('label'); const box = document.createElement('input'); box.type = 'checkbox';
      box.checked = !config.hidden.includes(key); box.disabled = key === 'song';
      box.addEventListener('change', () => {
        const hidden = box.checked ? config.hidden.filter(item => item !== key) : [...config.hidden.filter(item => item !== key), key];
        saveColumns({ ...config, hidden }, 'columns-toggle', { clave: key, visible: box.checked ? 1 : 0 }); openColumnsMenu(x, y);
      });
      label.append(box, document.createTextNode(' ' + columnLabels[key])); menu.appendChild(label);
    }
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset columns';
    reset.addEventListener('click', () => { saveColumns({ order: [...defaultColumns.order], hidden: [], widths: {} }, 'columns-reset', {}); menu.remove(); });
    menu.appendChild(reset);
    document.body.appendChild(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x - box.width, innerWidth - box.width - 8)) + 'px'; menu.style.top = Math.min(y + 4, innerHeight - box.height - 8) + 'px';
    const closeMenu = event => { if (event.type === 'keydown' ? event.key !== 'Escape' : menu.contains(event.target)) return; menu.remove(); document.removeEventListener('pointerdown', closeMenu, true); document.removeEventListener('keydown', closeMenu, true); };
    setTimeout(() => { document.addEventListener('pointerdown', closeMenu, true); document.addEventListener('keydown', closeMenu, true); }, 0);
    pageLog('columns-menu', { ocultas: config.hidden.join(',') || '-' });
  };
  document.addEventListener('el-music-columns', () => { for (const list of document.querySelectorAll('.songs-list')) prepareSongList(list); });
  // Años en las tarjetas de la página de un sello: main deja un mapa ID → año y acá se escribe junto al
  // artista de cada tarjeta «Top releases» que todavía no lo tenga; se repite cuando Apple vuelve a dibujar tarjetas.
  const fillLabelYears = () => {
    const years = document.documentElement[Symbol.for('el-music.label-years')];
    if (!(years instanceof Map)) return;
    let filled = 0;
    for (const title of document.querySelectorAll('.content-container .product-lockup__title[href]')) {
      const id = title.getAttribute('href').match(/\/album\/(?:[^/?#]+\/)?(\d{1,20})(?:[?#]|$)/)?.[1], year = id && years.get(id);
      const subtitle = title.closest('.product-lockup')?.querySelector('.product-lockup__subtitle');
      if (!year || !subtitle || subtitle.querySelector('.el-music-year')) continue;
      const span = document.createElement('span'); span.className = 'el-music-year'; span.textContent = ' · ' + year; subtitle.appendChild(span); filled++;
    }
    if (filled) pageLog('label-years', { tarjetas: filled, conocidos: years.size });
  };
  let yearsFrame;
  const scheduleYears = () => { if (yearsFrame === undefined) yearsFrame = requestAnimationFrame(() => { yearsFrame = undefined; fillLabelYears(); }); };
  document.addEventListener('el-music-label-years', scheduleYears);
  // Pie con cantidad y duración de las filas cargadas, como el de la app de Apple.
  // Apple tiene el suyo pero lo oculta mientras quedan tandas por cargar; el propio sólo cubre ese tramo.
  const duration = row => {
    const match = row.querySelector('.songs-list__col--time')?.textContent.match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
    return match ? (Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) : 0;
  };
  const summarize = list => {
    const rows = rowsOf(list);
    const seconds = rows.reduce((total, row) => total + duration(row), 0);
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
    const parts = [rows.length + (rows.length === 1 ? ' song' : ' songs')];
    if (hours) parts.push(hours + (hours === 1 ? ' hour' : ' hours'));
    parts.push(minutes + (minutes === 1 ? ' minute' : ' minutes'));
    const text = parts.join(', ') + (document.querySelector('.infinite-scroll-spinner') ? ' · loading more…' : '');
    let summary = list.nextElementSibling?.classList.contains('el-music-list-summary') ? list.nextElementSibling : null;
    // Al terminar la carga Apple muestra su propio pie, exacto (suma también los temas no disponibles, que no muestran
    // duración en la fila); entonces el propio se retira.
    if (document.querySelector('[data-testid="tracklist-footer-description"]')) { summary?.remove(); return; }
    if (!summary) { summary = document.createElement('div'); summary.className = 'el-music-list-summary'; summary.setAttribute('role', 'status'); list.after(summary); }
    if (summary.textContent !== text) summary.textContent = text;
  };
  // Carga de la playlist completa sin tener que bajar. Apple pide la tanda siguiente de
  // 100 cuando su marcador .infinite-scroll-spinner entra en pantalla (IntersectionObserver). La clase
  // el-music-autoload lo fija dentro de la ventana, invisible; se quita y se vuelve a poner tras cada tanda para que
  // Apple vea una entrada nueva. Sólo en playlists; nada de API propia ni de internos de Apple. Si tres intentos
  // seguidos no suman filas (error de red), se detiene hasta que cambie la lista o la página.
  let autoloadRows = -1, autoloadTries = 0, autoloadPath = '';
  const autoloadPages = () => {
    const root = document.documentElement, spinner = document.querySelector('.infinite-scroll-spinner');
    const rows = document.querySelectorAll('.songs-list .songs-list-row').length;
    for (const list of document.querySelectorAll('.songs-list')) followPlaying(list); // respaldo si el cambio fue sólo de clase
    if (!spinner) for (const summary of document.querySelectorAll('.el-music-list-summary')) if (summary.previousElementSibling) summarize(summary.previousElementSibling);
    if (!spinner && rows && timing?.first) finishTiming(rows);
    if (!spinner || !rows || !/\/playlist\//.test(location.pathname)) { root.classList.remove('el-music-autoload'); return; }
    // Con un Play esperando (0.1.48: Shuffle con 200 de 397 filas cargadas) no se pide otra tanda: dibujar 100 filas compite con
    // el arranque del tema. Se sigue al cerrarse el aviso (settlePending) o, como mucho, a los 15 s.
    if (pending) { root.classList.remove('el-music-autoload'); return; }
    if (spinner.getAttribute('aria-busy') === 'true') return;
    if (rows !== autoloadRows || location.pathname !== autoloadPath) { autoloadRows = rows; autoloadPath = location.pathname; autoloadTries = 0; }
    if (autoloadTries >= 3) { root.classList.remove('el-music-autoload'); return; }
    autoloadTries++;
    root.classList.remove('el-music-autoload');
    setTimeout(() => root.classList.add('el-music-autoload'), 100);
  };
  setInterval(autoloadPages, 1500);
  // Sin espera fija: la tanda siguiente se pide apenas Apple termina la anterior, cuando el
  // aria-busy público de su marcador vuelve a false. El intervalo de arriba queda de respaldo.
  new MutationObserver(records => {
    for (const record of records) {
      if (!record.target.classList?.contains('infinite-scroll-spinner')) continue;
      const busy = record.target.getAttribute('aria-busy') === 'true';
      if (timing && !timing.done) {
        if (busy && !timing.busySince) timing.busySince = performance.now();
        else if (!busy && timing.busySince) { timing.busyMs += performance.now() - timing.busySince; timing.busySince = 0; timing.batches++; }
      }
    }
    if (records.some(record => record.target.classList?.contains('infinite-scroll-spinner') && record.target.getAttribute('aria-busy') !== 'true'))
      setTimeout(autoloadPages, 0);
  }).observe(document.body, { attributes: true, attributeFilter: ['aria-busy'], subtree: true });
  // Medición de la carga de una playlist: desde la navegación hasta tener todas las filas,
  // cuántas tandas pidió Apple, cuánto esperó a Apple, cuánto tardó nuestro código y cuánto quedó bloqueado el navegador
  // (tareas de más de 50 ms). Al terminar deja sólo números en un dataset que main vuelca al log.
  let timing;
  const startTiming = (path, start) => {
    timing = { path, start, first: 0, batches: 0, busyMs: 0, busySince: 0, ours: 0, oursMax: 0, passes: 0, longCount: 0, longTotal: 0, longMax: 0,
      frames: 0, frameMs: 0, layoutMs: 0, forcedMs: 0, apple: 0, own: 0, other: 0, done: false };
  };
  const finishTiming = rows => {
    if (!timing || timing.done || location.pathname !== timing.path) return;
    timing.done = true;
    const round = value => Math.round(value);
    document.documentElement.dataset.elMusicPlaylistTiming = JSON.stringify({ filas: rows, tandasExtra: timing.batches,
      primerasFilasMs: round(timing.first), todasMs: round(performance.now() - timing.start), esperaAppleMs: round(timing.busyMs),
      nuestroMs: round(timing.ours), nuestroMaxMs: round(timing.oursMax), pasadas: timing.passes,
      bloqueos: timing.longCount, bloqueoTotalMs: round(timing.longTotal), bloqueoMaxMs: round(timing.longMax),
      cuadrosLentos: timing.frames, cuadrosLentosMs: round(timing.frameMs), disenoMs: round(timing.layoutMs), disenoForzadoMs: round(timing.forcedMs),
      scriptAppleMs: round(timing.apple), scriptPropioMs: round(timing.own), scriptOtroMs: round(timing.other) });
  };
  if (/\/playlist\//.test(location.pathname)) startTiming(location.pathname, 0);
  // Navigation API pública: avisa las navegaciones del enrutador de Apple sin tocar history.
  globalThis.navigation?.addEventListener?.('navigate', event => {
    try {
      const path = new URL(event.destination.url).pathname;
      if (/\/playlist\//.test(path)) startTiming(path, performance.now()); else timing = undefined;
    } catch { /* destino sin URL */ }
  });
  try {
    new PerformanceObserver(list => {
      const measuring = timing && !timing.done;
      for (const entry of list.getEntries()) {
        perf.longMs += entry.duration;
        const segment = slowEntry(); segment.longCount++; segment.longMs += entry.duration; segment.longMax = Math.max(segment.longMax, entry.duration);
        if (measuring) { timing.longCount++; timing.longTotal += entry.duration; timing.longMax = Math.max(timing.longMax, entry.duration); }
      }
    }).observe({ type: 'longtask' });
  } catch { /* sin longtask, la medición sale sin bloqueos */ }
  // Cuadros lentos (Long Animation Frames, más de 50 ms): cuánto fue recalcular estilos y diseño de la página y cuánto
  // script, separado por origen: el código de Apple (sus archivos en apple.com), el nuestro (inyectado, sin archivo) y otro.
  try {
    new PerformanceObserver(list => {
      const measuring = timing && !timing.done;
      for (const entry of list.getEntries()) {
        const segment = slowEntry(), layout = entry.styleAndLayoutDuration || 0;
        segment.frames++; segment.layout += layout;
        if (measuring) { timing.frames++; timing.frameMs += entry.duration; timing.layoutMs += layout; }
        for (const script of entry.scripts || []) {
          const source = script.sourceURL || '', forced = script.forcedStyleAndLayoutDuration || 0;
          const origin = /^https:\/\/(?:[a-z\d-]+\.)*apple\.com\//.test(source) ? 'apple' : !source ? 'own' : 'other';
          segment.forced += forced; segment[origin] += script.duration;
          // Culpables del episodio: archivo (sólo el nombre, sin URL) y función para Apple; para el nuestro, quién lo invocó.
          const where = origin === 'own' ? String(script.invoker || '').slice(0, 40) : source.split(/[?#]/)[0].split('/').pop().slice(0, 40) + ':' + String(script.sourceFunctionName || '').slice(0, 30);
          const culprit = origin + ' ' + where + ' (' + String(script.invokerType || '').slice(0, 20) + ')';
          if (segment.culprits.size < 200 || segment.culprits.has(culprit)) segment.culprits.set(culprit, (segment.culprits.get(culprit) || 0) + script.duration);
          if (measuring) { timing.forcedMs += forced; timing[origin] += script.duration; }
        }
      }
    }).observe({ type: 'long-animation-frame' });
  } catch { /* sin Long Animation Frames, la medición sale sin atribución */ }
  let lastPageError = 0;
  const prepareSongLists = () => {
    const started = performance.now();
    try { for (const list of document.querySelectorAll('.songs-list')) prepareSongList(list); }
    catch (error) { if (Date.now() - lastPageError > 10000) { lastPageError = Date.now(); pageLog('error', { donde: 'prepareSongLists', texto: String(error && error.stack || error) }); } }
    const spent = performance.now() - started;
    perf.passes++; perf.passMs += spent;
    if (timing && !timing.done && location.pathname === timing.path) {
      timing.ours += spent; timing.oursMax = Math.max(timing.oursMax, spent); timing.passes++;
      if (!timing.first && document.querySelector('.songs-list .songs-list-row')) timing.first = performance.now() - timing.start;
    }
    autoloadPages();
  };
  // Con la vista ordenada no se permite arrastrar filas: Apple podría reordenar la playlist real según la posición visual.
  // Apple inicia un arrastre nativo con la lista entera (.songs-list) como origen, también al apretar en el encabezado, y
  // eso cancela nuestros eventos de puntero (pointercancel, visto en QA 0.1.40): mientras hay un gesto nuestro se bloquea.
  document.addEventListener('dragstart', event => {
    if (headerGesture || event.target instanceof Element && event.target.closest('.songs-list[data-el-music-sort]:not([data-el-music-sort=""]) .songs-list-row')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  const updatePlayer = player => {
    prepareVolume(player); prepareRepeat(player); markArtists(player); syncLcdLine(); checkPending(); bindPlayback(); markPlayingRelease(); album.disabled = !readPlaying().albumButton;
    const actions = player.querySelector('.action-buttons'), volume = actions?.querySelector('.chrome-volume');
    if (actions && volume) {
      if (actions.querySelector('button[data-testid="lyrics-button"]')) unavailableLyrics.remove();
      else if (unavailableLyrics.parentElement !== actions) actions.insertBefore(unavailableLyrics, volume);
    }
  };
  // Sin colores de portada: en playlists y álbumes con tema Apple agrega
  // has-theme-override e is-dark-theme/is-light-theme, y escribe --joe-color en el style del contenedor. Se observan
  // class y style del contenedor; Apple sólo los vuelve a escribir al cambiar de página, y entonces se quitan otra vez.
  let themedContainer;
  const themeObserver = new MutationObserver(() => neutralizeTheme());
  const neutralizeTheme = () => {
    const container = document.querySelector('.app-container');
    if (container && container !== themedContainer) { themeObserver.disconnect(); themeObserver.observe(container, { attributes: true, attributeFilter: ['class', 'style'] }); themedContainer = container; }
    if (container?.classList.contains('has-theme-override')) container.classList.remove('has-theme-override', 'is-dark-theme', 'is-light-theme');
    // El color también llega como variables en el style del contenedor (--joe-color y sus mezclas «-blended-»), que
    // tiñen encabezado, barra lateral y fondo aunque no esté la clase. Se quitan sólo ésas; el resto del style queda.
    if (container) for (const name of [...container.style].filter(name => /^--(?:.*-)?joe-color$|-blended-/.test(name))) container.style.removeProperty(name);
  };
  const apply = () => {
    const container = document.querySelector('.app-container'); const player = container?.querySelector('.player-bar .chrome-player');
    neutralizeTheme();
    if (!container || !player) return;
    updatePlayer(player);
    document.documentElement.classList.add('el-music-shell');
    const controls = player.querySelector('.chrome-player__playback-controls');
    // Navegación al extremo izquierdo, pegada a los tres puntos de la barra de ventana; luego un espacio y los controles de Apple.
    if (controls && controls.firstElementChild !== nav) controls.prepend(nav);
    const navigation = container.querySelector('.navigation');
    refreshSidebar(navigation);
    installSidebarItems(navigation);
    // shortcut: Apple puede cambiar estos selectores; omitir el ajuste hasta adaptarlos.
    for (const child of container.children) if (child.classList.contains('scrollable-page')) child.classList.add('el-music-content');
    const logo = document.querySelector('.navigation__header a');
    if (logo && !logo.querySelector('.el-music-brand')) {
      const icon = logo.querySelector('svg,amp-icon'); if (icon) icon.style.display = 'none';
      const brand = document.createElement('span'); brand.className = 'el-music-brand'; brand.textContent = 'El Music'; logo.appendChild(brand); logo.setAttribute('aria-label', 'El Music');
    }
    installed = true;
    document.documentElement.dataset.elMusicShell = 'ready';
  };
  // Refresco de la playlist abierta tras agregar un tema. La página de playlist de Apple
  // no escucha «tema agregado» (sí reordenar o borrar). Se hace clic en el enlace de la barra lateral a esa misma
  // página: el enrutador navega como siempre (pushState con estado propio), vuelve a pedirla y conserva la página en su
  // historial. Un popstate sin estado (0.1.26) también la pedía, pero Apple aplica cada tanda de 100 temas con
  // updateState sobre ese estado guardado: sin él, la playlist quedaba en los primeros 100. Sin enlace visible (por
  // ejemplo dentro de una carpeta cerrada) no se refresca. No recarga el documento, así que el audio sigue.
  const pagePath = () => location.pathname.replace(/\/$/, '');
  const playlistOnPage = id => pagePath().split('/').slice(-3).join('/') === 'library/playlist/' + id;
  const sidebarLink = () => [...document.querySelectorAll('.navigation a[href]')].find(link => {
    try { const url = new URL(link.href); return url.origin === location.origin && url.pathname.replace(/\/$/, '') === pagePath(); } catch { return false; }
  });
  let refreshTimer;
  const refreshPlaylist = id => {
    if (typeof id !== 'string' || !/^p\.[A-Za-z0-9]{1,64}$/.test(id) || !playlistOnPage(id)) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const link = playlistOnPage(id) && sidebarLink();
      if (!link) return;
      refreshedAt = Date.now();
      const scroll = document.getElementById('scrollable-page')?.scrollTop ?? 0;
      const old = document.querySelector('.songs-list-row');
      link.click();
      const restore = () => {
        const row = document.querySelector('.songs-list-row');
        if (row && row !== old && !old?.isConnected) { const page = document.getElementById('scrollable-page'); if (page) page.scrollTop = scroll; return; }
        if (Date.now() - refreshedAt < 6000) setTimeout(restore, 150);
      };
      if (scroll > 0) setTimeout(restore, 150);
    }, 600);
  };
  // Agregado desde Stream Deck: el script de main avisa con el ID de la playlist una vez confirmada la escritura.
  document.addEventListener('el-music-playlist-added', event => refreshPlaylist(event.detail));
  // Agregado desde el menú de Apple: su POST es el único pedido a /tracks con representation=resources; la carga de la
  // página y sus tandas no lo usan. Se lee sólo la URL del recurso; la pausa de 5 s evita cualquier ciclo con el refresco.
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.initiatorType === 'img') { perf.images++; continue; }
        const match = /^https:\/\/amp-api\.music\.apple\.com\/v1\/me\/library\/playlists\/(p\.[A-Za-z0-9]{1,64})\/tracks\?(?:[^#]*&)?representation=resources(?:&|$)/.exec(entry.name);
        if (match && Date.now() - refreshedAt > 5000) refreshPlaylist(match[1]);
      }
    }).observe({ type: 'resource' });
  } catch { /* sin PerformanceObserver queda sólo el aviso de Stream Deck */ }
  // Una pasada por cuadro, justo antes de que el navegador recalcule el diseño: las celdas de sello entran en
  // el mismo diseño que las filas nuevas de Apple en lugar de forzar otro 120 ms después. Entre el fin de una pasada y la
  // siguiente pasan al menos 120 ms. Sin cuadros (ventana oculta o tapada) requestAnimationFrame no corre y el respaldo
  // hace la pasada a los 120 ms, como antes. Las mutaciones de la propia pasada se descartan (takeRecords): antes cada
  // una pedía otra pasada sin nada que cambiar.
  let songListTimer, songListFrame, songListsAt = -Infinity;
  const runSongLists = () => {
    cancelAnimationFrame(songListFrame); clearTimeout(songListTimer); songListFrame = songListTimer = undefined;
    prepareSongLists(); observer.takeRecords(); songListsAt = performance.now();
  };
  const scheduleSongLists = () => {
    if (songListFrame !== undefined || songListTimer !== undefined) return;
    const wait = songListsAt + 120 - performance.now();
    if (wait > 0) { songListTimer = setTimeout(() => { songListTimer = undefined; scheduleSongLists(); }, wait); return; }
    songListFrame = requestAnimationFrame(runSongLists); songListTimer = setTimeout(runSongLists, 120);
  };
  document.addEventListener('el-music-playlist-labels', scheduleSongLists);
  let scheduled = false;
  let pendingRebuild = false;
  const observer = new MutationObserver(records => {
    perf.records += records.length;
    if (records.some(record => record.target.closest?.('.songs-list') || [...record.addedNodes].some(node => node.nodeType === 1 && (node.matches?.('.songs-list') || node.querySelector?.('.songs-list'))))) scheduleSongLists();
    if (document.documentElement?.[Symbol.for('el-music.label-years')] && records.some(record => record.target.closest?.('.content-container'))) scheduleYears();
    const rebuild = records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && (node.matches?.('.app-container,.player-bar,.chrome-player,.chrome-player__playback-controls,.navigation__header,.navigation-items__list') || node.querySelector?.('.player-bar,.chrome-player,.chrome-player__playback-controls,.navigation__header,.navigation-items__list'))));
    const playerChanged = records.some(record => record.target.closest?.('.player-lcd,.chrome-volume,.action-buttons') || record.target.parentElement?.closest('.player-lcd,.chrome-volume,.action-buttons'));
    if (!rebuild && !playerChanged) return;
    pendingRebuild ||= rebuild || !installed;
    if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; if (pendingRebuild) { pendingRebuild = false; apply(); } else { const player = document.querySelector('.player-bar .chrome-player'); if (player) updatePlayer(player); } }); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  addEventListener('resize', apply); apply();
  document.documentElement.dataset.elMusicShell = installed ? 'ready' : 'waiting';
})();
