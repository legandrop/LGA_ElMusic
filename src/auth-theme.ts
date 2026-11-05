import type { WebContents, WebFrameMain } from 'electron';
import { isAllowedNavigation, isMusicUrl } from './policy';

// El iframe y su raíz deben compartir esquema para evitar un canvas blanco opaco.
const css = `iframe[src^="https://idmsa.apple.com/"],
iframe[src^="https://accounts.apple.com/"],
iframe[src^="https://appleid.apple.com/"] { color-scheme: inherit !important; }`;
const authRootCss = ':root { color-scheme: light dark !important; }';
const scrollCss = `* { scrollbar-color: #777 #202020 !important; }
@media (forced-colors: active) { * { scrollbar-color: auto !important; } }`;
const commerceCss = `.cc-modal__modal:not(.cc-modal__modal--flexible-size):not(.cc-modal__modal--alert):not(.cc-modal__modal--narrow) {
  max-height: min(720px, calc(100vh - 32px)) !important;
}`;

export function installAuthColorScheme(contents: WebContents, onFailure: () => void): void {
  const apply = (frame: WebFrameMain): void => {
    if (!isAllowedNavigation(frame.url)) return;
    const url = new URL(frame.url);
    const commerce = isMusicUrl(frame.url) && (url.pathname === '/includes/commerce' || url.pathname.startsWith('/includes/commerce/'));
    const frameCss = `${css}\n${scrollCss}${isMusicUrl(frame.url) ? '' : `\n${authRootCss}`}${commerce ? `\n${commerceCss}` : ''}`;
    void frame.executeJavaScript(`(() => {
      const id = 'lga-auth-color-scheme';
      if (document.getElementById(id)) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = ${JSON.stringify(frameCss)};
      (document.head || document.documentElement).appendChild(style);
    })()`).catch(onFailure);
  };
  contents.on('dom-ready', () => apply(contents.mainFrame));
  contents.on('frame-created', (_event, { frame }) => {
    if (frame) frame.on('dom-ready', () => apply(frame));
  });
}
