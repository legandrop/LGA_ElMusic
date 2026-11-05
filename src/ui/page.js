'use strict';
const state = new URL(location.href).searchParams.get('state') || 'loading';
document.body.dataset.page = state;
const heading = document.getElementById('heading');
const description = document.getElementById('description');
const feedback = document.getElementById('feedback');
async function initialize() {
  try {
    const info = await window.elMusic.getAppInfo();
    document.title = info.name;
    if (state === 'recommendation-settings') {
      heading.textContent = 'Settings';
      description.textContent = 'Choose how El Music looks and how it discovers related music.';
      document.getElementById('loading').hidden = true;
      document.getElementById('appearance-settings').hidden = false;
      document.getElementById('recommendation-settings').hidden = false;
      defaultArtistColor = info.defaultArtistColor;
      artistColor.value = info.artistColor;
      appearanceError = info.appearance === 'Configuration error';
      artistColor.disabled = resetArtistColor.disabled = appearanceError;
      configurationError = info.lastFm === 'Configuration error';
      renderLastFm(info.lastFm === 'Configured');
      if (configurationError) showFeedback('Saved settings could not be read. Restart El Music before trying again.', 'error');
      document.getElementById('settings-done').hidden = false;
    } else if (state === 'about') {
      heading.textContent = info.name;
      description.textContent = 'A personal desktop home for Apple Music.';
      document.getElementById('loading').hidden = true;
      document.getElementById('info').hidden = false;
      document.getElementById('actions').hidden = false;
      const rows = [['Version', info.version], ['Runtime', info.electron], ['Chromium', info.chromium], ['Playback', info.playback], ['Profile', info.mode]];
      for (const [label, value] of rows) {
        const term = document.createElement('dt'); term.textContent = label;
        const detail = document.createElement('dd'); detail.textContent = value;
        document.getElementById('info').append(term, detail);
      }
    } else if (state === 'error') {
      heading.textContent = 'Playback is not ready';
      description.textContent = 'Secure playback or the music page could not be loaded. Check your connection, then choose El Music → Retry loading. You can copy a diagnostic report below.';
      document.getElementById('loading').hidden = true;
      document.getElementById('actions').hidden = false;
    }
    document.body.dataset.ready = 'true';
  } catch {
    feedback.textContent = 'Application information could not be loaded.';
    document.body.dataset.ready = 'error';
  }
}
document.getElementById('copy').addEventListener('click', async () => {
  try { await window.elMusic.copyDiagnostics(); feedback.textContent = 'Diagnostics copied.'; }
  catch { feedback.textContent = 'Diagnostics could not be copied.'; }
});
document.getElementById('data').addEventListener('click', async () => {
  try { await window.elMusic.openDataDirectory(); feedback.textContent = 'Data folder opened.'; }
  catch { feedback.textContent = 'Data folder could not be opened.'; }
});
const artistColor = document.getElementById('artist-color');
const resetArtistColor = document.getElementById('reset-artist-color');
let defaultArtistColor = '';
let appearanceError = false;
let colorSaving = false;
let pendingColor;
// El selector emite muchos cambios al arrastrar: se guarda uno a la vez y sólo el último pendiente.
async function saveArtistColor(color) {
  if (appearanceError || !/^#[0-9a-f]{6}$/i.test(color)) return;
  if (colorSaving) { pendingColor = color; return; }
  colorSaving = true;
  try {
    const result = await window.elMusic.setArtistColor(color);
    if (!pendingColor) artistColor.value = result.color;
    if (result.saved) showFeedback('Artist color saved.', 'success');
    else {
      pendingColor = undefined; artistColor.value = result.color;
      appearanceError = true; artistColor.disabled = resetArtistColor.disabled = true;
      showFeedback('The artist color could not be saved. Restart El Music before trying again.', 'error');
    }
  } catch { showFeedback('The artist color could not be saved. Please try again.', 'error'); }
  finally {
    colorSaving = false;
    if (pendingColor) { const next = pendingColor; pendingColor = undefined; void saveArtistColor(next); }
  }
}
artistColor.addEventListener('input', () => void saveArtistColor(artistColor.value));
resetArtistColor.addEventListener('click', () => { if (defaultArtistColor) { artistColor.value = defaultArtistColor; void saveArtistColor(defaultArtistColor); } });
initialize();
const keyInput = document.getElementById('lastfm-key');
const saveKey = document.getElementById('save-lastfm');
const clearKey = document.getElementById('clear-lastfm');
const changeKey = document.getElementById('change-lastfm');
const cancelKey = document.getElementById('cancel-lastfm');
const doneSettings = document.getElementById('done-settings');
let configured = false;
let busy = false;
let configurationError = false;
function renderLastFm(saved, editing = false) {
  configured = saved;
  const masked = saved && !editing;
  keyInput.readOnly = masked || configurationError;
  keyInput.value = masked ? '•'.repeat(16) : '';
  keyInput.placeholder = masked ? '' : 'Paste your API key';
  document.getElementById('lastfm-status').textContent = configurationError ? 'Last.fm: Configuration error' : saved ? 'Last.fm: API key saved' : 'Last.fm: Not configured';
  document.getElementById('lastfm-help').textContent = masked
    ? 'Your key is saved. Choose Change API key to replace it.'
    : 'Add Last.fm as another recommendation source. ListenBrainz also works without a key.';
  document.getElementById('lastfm-steps').hidden = masked;
  saveKey.hidden = masked; changeKey.hidden = !masked; cancelKey.hidden = !saved || masked;
  saveKey.disabled = true; clearKey.hidden = !saved;
  clearKey.disabled = !saved;
}
function showFeedback(message, kind) { feedback.textContent = message; feedback.dataset.kind = kind; }
keyInput.addEventListener('input', () => {
  saveKey.disabled = busy || configurationError || !/^[a-f\d]{32}$/i.test(keyInput.value);
  feedback.textContent = ''; delete feedback.dataset.kind;
});
changeKey.addEventListener('click', () => { if (!busy) { renderLastFm(configured, true); feedback.textContent = ''; delete feedback.dataset.kind; keyInput.focus(); } });
cancelKey.addEventListener('click', () => { if (!busy) { renderLastFm(configured); changeKey.focus(); } });
async function updateLastFm(key) {
  if (busy) return;
  if (configurationError) return;
  let focusDone = false;
  busy = true;
  for (const button of [saveKey, clearKey, changeKey, cancelKey, doneSettings]) button.disabled = true;
  keyInput.readOnly = true;
  saveKey.textContent = key ? 'Checking…' : 'Save API key';
  showFeedback(key ? 'Checking your API key with Last.fm…' : 'Removing saved API key…', 'pending');
  try {
    const result = await window.elMusic.setLastFmKey(key);
    if (result.saved) {
      renderLastFm(result.configured);
      showFeedback(result.configured ? 'API key verified and saved successfully.' : 'Saved API key removed successfully.', 'success');
      focusDone = true;
    } else {
      if (result.error === 'save-uncertain') {
        renderLastFm(result.configured);
        showFeedback('The saved state could not be confirmed. Restart El Music before trying again.', 'error');
      } else {
        const errors = {
          'invalid-key': 'Last.fm rejected this API key. Check it and try again. Your saved key was not changed.',
          'busy': 'Another save is in progress. Please wait and try again.',
          'unavailable': 'Last.fm could not be reached or is temporarily unavailable. Try again. Your saved key was not changed.'
        };
        showFeedback(errors[result.error] || 'Settings could not be saved. Please try again.', 'error');
      }
    }
  } catch { showFeedback('Settings could not be saved. Please try again.', 'error'); }
  finally {
    busy = false; saveKey.textContent = 'Save API key';
    const masked = configured && saveKey.hidden;
    keyInput.readOnly = masked || configurationError;
    for (const button of [changeKey, cancelKey, doneSettings]) button.disabled = false;
    clearKey.disabled = !configured;
    saveKey.disabled = configurationError || masked || !/^[a-f\d]{32}$/i.test(keyInput.value);
    if (focusDone) doneSettings.focus();
  }
}
saveKey.addEventListener('click', () => { if (/^[a-f\d]{32}$/i.test(keyInput.value)) void updateLastFm(keyInput.value); });
clearKey.addEventListener('click', () => void updateLastFm(''));
doneSettings.addEventListener('click', async () => {
  if (busy) return;
  try { await window.elMusic.closeRecommendationSettings(); }
  catch { showFeedback('This window could not be closed. You can use its close button.', 'error'); }
});
document.getElementById('get-lastfm').addEventListener('click', async () => {
  try { await window.elMusic.openLastFmSetup(); }
  catch { feedback.textContent = 'The Last.fm setup page could not be opened.'; }
});
