import { applyI18n, t } from '../lib/i18n.js';
import { formatBitrate, formatBytes, formatDuration } from '../lib/format.js';
import { makeFileName, nameCandidates, sanitizeName, suggestName } from '../lib/filename.js';
import { getSettings } from '../lib/settings.js';

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const count = document.getElementById('count');
const template = document.getElementById('item-template');
const cards = new Map();
let refreshing = null;
let refreshAgain = false;

applyI18n();

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const settings = await getSettings();

document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('clear').addEventListener('click', async () => {
  if (tab) await send({ type: 'clearItems', tabId: tab.id });
  refresh();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'itemsChanged' && message.tabId === tab?.id) refresh();
});
refresh();

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      render(tab ? await send({ type: 'getItems', tabId: tab.id }) : []);
    } while (refreshAgain);
  })();
  try {
    await refreshing;
  } finally {
    refreshing = null;
  }
}

function render(items) {
  const keys = new Set(items.map((item) => item.key));
  for (const [key, card] of cards) {
    if (!keys.has(key)) {
      card.el.remove();
      cards.delete(key);
    }
  }
  items.forEach((item, index) => {
    let card = cards.get(item.key);
    if (!card) {
      card = createCard();
      cards.set(item.key, card);
    }
    card.update(item);
    if (list.children[index] !== card.el) list.insertBefore(card.el, list.children[index] || null);
  });
  empty.hidden = items.length > 0;
  count.textContent = items.length || '';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function variantLabel(v) {
  const quality = v.height ? `${v.height}p` : v.width ? `${v.width}w` : '';
  return [quality, formatBitrate(v.bandwidth)].filter(Boolean).join(' · ') || hostOf(v.url);
}

// Audio-only streams become .m4a after conversion.
function streamExt(item) {
  const variants = item.hls?.variants || [];
  const audioOnly = variants.length > 0 && variants.every((v) => !v.height && v.codecs && !/avc|hvc|hev|av01|vp0/i.test(v.codecs));
  return audioOnly ? 'm4a' : 'mp4';
}

function createCard() {
  const el = template.content.firstElementChild.cloneNode(true);
  applyI18n(el);
  const kind = el.querySelector('.kind');
  const name = el.querySelector('.name');
  const names = el.querySelector('.names');
  const ext = el.querySelector('.ext');
  const meta = el.querySelector('.meta');
  const note = el.querySelector('.note');
  const quality = el.querySelector('.quality');
  const copy = el.querySelector('.copy');
  const download = el.querySelector('.dl');

  let item = null;
  let suggestion = null;
  let nameEdited = false;
  let variantsSignature = '';
  let candidates = [];
  let candidatesSignature = '';
  let flashTimer = 0;

  function markActiveName() {
    for (const chip of names.children) chip.classList.toggle('active', chip.dataset.base === name.value);
  }

  function pickName(base) {
    name.value = base;
    nameEdited = true;
    markActiveName();
  }

  name.addEventListener('input', () => {
    nameEdited = true;
    markActiveName();
  });
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !download.disabled) download.click();
    // ↑/↓ cycle through the name variants.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && candidates.length > 1) {
      e.preventDefault();
      const current = candidates.findIndex((c) => c.base === name.value);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = current < 0 ? (step > 0 ? 0 : candidates.length - 1) : (current + step + candidates.length) % candidates.length;
      pickName(candidates[next].base);
      name.select();
    }
  });
  quality.addEventListener('change', () => describe());

  function selectedVariant() {
    return item.hls?.variants?.[Number(quality.value) || 0] || null;
  }

  function showNote(text, tone = '') {
    note.hidden = !text;
    note.textContent = text || '';
    note.className = `note ${tone}`;
  }

  function flash(text, tone) {
    clearTimeout(flashTimer);
    showNote(text, tone);
    flashTimer = setTimeout(describe, 2500);
  }

  // Meta line and notes; depends on the selected quality.
  function describe() {
    const parts = [];
    let warning = '';
    let blocked = false;
    if (item.kind === 'file') {
      parts.push(item.size ? formatBytes(item.size) : t('sizeUnknown'));
    } else if (item.kind === 'hls') {
      const hls = item.hls || {};
      const variant = selectedVariant();
      if (hls.live) parts.push(t('live'));
      else if (hls.duration) parts.push(formatDuration(hls.duration));
      if (variant?.bandwidth && hls.duration && !hls.live) parts.push(`~${formatBytes((variant.bandwidth * hls.duration) / 8)}`);
      if (hls.error) warning = `${t('noteHlsError')} ${hls.error}`;
      else if (hls.encryption === 'DRM' || hls.encryption === 'SAMPLE-AES') {
        warning = t('noteDrm');
        blocked = true;
      } else if (hls.live) warning = t('noteLive');
      else if (variant?.audioUrl && !settings.convertMp4) warning = t('noteAudio');
    } else {
      warning = t('noteDash');
      blocked = true;
    }
    parts.push(hostOf(item.url));
    meta.textContent = parts.filter(Boolean).join(' · ');
    meta.title = item.url;
    showNote(warning);
    download.disabled = blocked;
  }

  function update(next) {
    item = next;
    const pageTitle = item.pageUrl && item.pageUrl === tab?.url ? tab.title : item.pageTitle;
    suggestion = suggestName(item, settings.naming, pageTitle);
    if (!nameEdited) name.value = suggestion.base;
    candidates = nameCandidates(item, pageTitle);
    const namesSignature = candidates.map((c) => `${c.source}:${c.base}`).join('|');
    if (namesSignature !== candidatesSignature) {
      candidatesSignature = namesSignature;
      names.replaceChildren(
        ...candidates.map((c) => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'chip';
          chip.dataset.base = c.base;
          chip.textContent = t(`nameSource_${c.source}`);
          chip.title = c.base;
          chip.addEventListener('click', () => pickName(c.base));
          return chip;
        }),
      );
    }
    names.hidden = candidates.length < 2;
    markActiveName();
    name.title = [item.originalName ? `${t('originalName')}: ${item.originalName}` : '', candidates.length > 1 ? t('nameCycleHint') : '']
      .filter(Boolean)
      .join('\n');

    kind.className = `kind ${item.kind}`;
    kind.textContent = item.kind === 'file' ? (suggestion.ext || 'FILE').toUpperCase() : item.kind.toUpperCase();
    ext.textContent = suggestion.ext ? `.${suggestion.ext}` : item.kind === 'hls' && settings.convertMp4 ? `.${streamExt(item)}` : '';

    const variants = item.hls?.variants || [];
    const signature = variants.map((v) => v.url).join('|');
    if (signature !== variantsSignature) {
      variantsSignature = signature;
      quality.replaceChildren(
        ...variants.map((v, i) => {
          const option = document.createElement('option');
          option.value = String(i);
          option.textContent = variantLabel(v);
          return option;
        }),
      );
    }
    quality.hidden = variants.length < 2;
    describe();
  }

  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(selectedVariant()?.url || item.url);
    flash(t('statusCopied'), 'ok');
  });

  download.addEventListener('click', async () => {
    const base = sanitizeName(name.value) || suggestion.base;
    const fileName = item.kind === 'file' ? makeFileName(base, suggestion.ext) : base;
    download.disabled = true;
    try {
      await send({ type: 'download', tabId: tab.id, key: item.key, name: fileName, variant: Number(quality.value) || 0 });
      flash(item.kind === 'file' ? t('statusStarted') : t('statusStreamStarted'), 'ok');
    } catch (e) {
      flash(e.message, 'error');
    } finally {
      download.disabled = false;
    }
  });

  return { el, update };
}
