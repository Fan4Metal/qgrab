import { applyI18n } from '../lib/i18n.js';
import { DEFAULTS, getSettings, saveSettings } from '../lib/settings.js';

applyI18n();

const settings = await getSettings();
const saved = document.getElementById('saved');
let savedTimer = 0;

async function save(patch) {
  await saveSettings(patch);
  saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (saved.hidden = true), 1200);
}

for (const radio of document.querySelectorAll('input[name="naming"]')) {
  radio.checked = radio.value === settings.naming;
  radio.addEventListener('change', () => save({ naming: radio.value }));
}

for (const id of ['saveAs', 'autoClose']) {
  const input = document.getElementById(id);
  input.checked = Boolean(settings[id]);
  input.addEventListener('change', () => save({ [id]: input.checked }));
}

const subfolder = document.getElementById('subfolder');
subfolder.value = settings.subfolder;
subfolder.addEventListener('change', () => save({ subfolder: subfolder.value.trim() }));

for (const [id, min, max] of [
  ['concurrency', 1, 16],
  ['minSizeKB', 0, 1_000_000],
]) {
  const input = document.getElementById(id);
  input.value = settings[id];
  input.addEventListener('change', () => {
    const number = Math.round(Number(input.value));
    const value = Number.isFinite(number) && input.value !== '' ? Math.min(max, Math.max(min, number)) : DEFAULTS[id];
    input.value = value;
    save({ [id]: value });
  });
}
