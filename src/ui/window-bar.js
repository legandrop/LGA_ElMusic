'use strict';
document.querySelector('button').addEventListener('click', async event => {
  const button = event.currentTarget;
  if (event.detail > 0) button.blur();
  try { await window.windowMenu.open(); }
  catch { button.title = 'Menu unavailable. Restart El Music.'; }
});
