import { applyI18n, t } from '../lib/i18n.js';
import { formatBitrate, formatBytes, formatDuration } from '../lib/format.js';
import { cleanSelection, makeFileName, nameCandidates, sanitizeName, suggestName } from '../lib/filename.js';
import { getSettings } from '../lib/settings.js';
import { mainVideo, matchItems } from '../lib/focus.js';

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const count = document.getElementById('count');
const template = document.getElementById('item-template');
const pickNote = document.getElementById('pick-note');
const cards = new Map();
const others = document.createElement('li');
others.className = 'others';
let showOthers = false;
let refreshing = null;
let refreshAgain = false;

applyI18n();

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const settings = await getSettings();
const page = await readPage();
const selection = page.selection;

document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('clear').addEventListener('click', async () => {
  if (tab) await send({ type: 'clearItems', tabId: tab.id });
  refresh();
});
document.getElementById('pick').addEventListener('click', startPicker);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'itemsChanged' && message.tabId === tab?.id) refresh();
});
refresh();

// Runs in every frame of the page, in the content script's isolated world.
function grabFrame() {
  const el = document.activeElement;
  let current = '';
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && el.selectionEnd > el.selectionStart) {
    try {
      current = el.value.slice(el.selectionStart, el.selectionEnd);
    } catch {
      // Inputs without text selection support (number, email).
    }
  }
  current ||= String(getSelection() || '');

  const vw = innerWidth;
  const vh = innerHeight;
  const videos = [...document.querySelectorAll('video')].map((v) => {
    const r = v.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return {
      area: w * h,
      playing: !v.paused && !v.ended && v.readyState > 2,
      currentTime: v.currentTime,
      src: /^https?:/i.test(v.currentSrc) ? v.currentSrc : '',
    };
  });
  const resources = videos.length
    ? globalThis.__qgrabResources ||
      performance.getEntriesByType('resource').map((e) => ({ url: e.name, time: performance.timeOrigin + e.startTime }))
    : [];
  return { current: current.trim(), last: globalThis.__qgrabLastSelection || '', top: window === top, videos, resources };
}

/**
 * Snapshot of the page when the popup opens.
 * selection.current is applied as the name, selection.last (cleared since) is only offered as a variant;
 * frames carry the <video> elements and the requests made by each frame.
 */
async function readPage() {
  const nothing = { selection: { current: '', last: '' }, frames: [] };
  if (!tab) return nothing;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: grabFrame });
    const frames = results.map((f) => f.result).filter(Boolean).sort((a, b) => b.top - a.top);
    return {
      selection: {
        current: cleanSelection(frames.find((r) => r.current)?.current),
        last: cleanSelection(frames.find((r) => r.last)?.last),
      },
      frames,
    };
  } catch {
    return nothing; // Browser pages, the Web Store and other pages scripts cannot access.
  }
}

async function startPicker() {
  if (!page.frames.some((f) => f.videos.length)) {
    pickNote.textContent = t('pickNoVideos');
    pickNote.hidden = false;
    return;
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/picker.js'] }).catch(() => {});
  window.close();
}

/**
 * Items of the video being watched: picked on the page, or found automatically from the requests
 * of the main video's frame. @returns {{keys: string[], picked: boolean}}
 */
function focusOf(items, picked) {
  const known = new Set(items.map((i) => i.key));
  const pickedKeys = (picked?.keys || []).filter((k) => known.has(k));
  if (pickedKeys.length) return { keys: pickedKeys, picked: true };
  const main = mainVideo(page.frames);
  if (!main) return { keys: [], picked: false };
  const matches = matchItems(items, main.frame.resources, main.video.src);
  return { keys: [...matches].sort((a, b) => b[1] - a[1]).map(([key]) => key), picked: false };
}

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
      const [items, picked] = tab
        ? await Promise.all([send({ type: 'getItems', tabId: tab.id }), send({ type: 'getFocus', tabId: tab.id })])
        : [[], null];
      render(items, picked);
    } while (refreshAgain);
  })();
  try {
    await refreshing;
  } finally {
    refreshing = null;
  }
}

function render(items, picked) {
  const keys = new Set(items.map((item) => item.key));
  for (const [key, card] of cards) {
    if (!keys.has(key)) {
      card.el.remove();
      cards.delete(key);
    }
  }

  // The watched video's items first; the rest folds under "Other on the page".
  const focus = focusOf(items, picked);
  const rank = new Map(focus.keys.map((key, i) => [key, i]));
  const focused = focus.keys.map((key) => items.find((i) => i.key === key));
  const rest = items.filter((i) => !rank.has(i.key));
  const folded = focused.length > 0 && rest.length > 0;
  const nodes = [];
  for (const item of [...focused, ...rest]) {
    let card = cards.get(item.key);
    if (!card) {
      card = createCard();
      cards.set(item.key, card);
    }
    card.update(item, rank.has(item.key) ? (focus.picked ? 'picked' : 'playing') : '');
    card.el.hidden = folded && !rank.has(item.key) && !showOthers;
    if (folded && item === rest[0]) nodes.push(others);
    nodes.push(card.el);
  }
  if (folded) renderOthers(rest.length, focus.picked);
  else others.remove();
  nodes.forEach((node, index) => {
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
  empty.hidden = items.length > 0;
  count.textContent = items.length || '';
}

function renderOthers(n, picked) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'others-toggle';
  toggle.textContent = `${showOthers ? '▾' : '▸'} ${t('othersLabel')} (${n})`;
  toggle.addEventListener('click', () => {
    showOthers = !showOthers;
    refresh();
  });
  const parts = [toggle];
  if (picked) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'others-reset';
    reset.textContent = t('focusReset');
    reset.addEventListener('click', async () => {
      await send({ type: 'clearFocus', tabId: tab.id });
      refresh();
    });
    parts.push(reset);
  }
  others.replaceChildren(...parts);
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

/** Stream details from the playlist/manifest: {variants, duration, live, error, …}. */
function streamInfo(item) {
  return item.hls || item.dash || {};
}

// Audio-only streams become .m4a after conversion.
function streamExt(item) {
  if (item.kind === 'dash') return !item.dash?.variants?.length && item.dash?.audioId ? 'm4a' : 'mp4';
  const variants = item.hls?.variants || [];
  const audioOnly = variants.length > 0 && variants.every((v) => !v.height && v.codecs && !/avc|hvc|hev|av01|vp0/i.test(v.codecs));
  return audioOnly ? 'm4a' : 'mp4';
}

function createCard() {
  const el = template.content.firstElementChild.cloneNode(true);
  applyI18n(el);
  const kind = el.querySelector('.kind');
  const badge = el.querySelector('.focus-badge');
  const hide = el.querySelector('.hide');
  const name = el.querySelector('.name');
  const names = el.querySelector('.names');
  const ext = el.querySelector('.ext');
  const size = el.querySelector('.size');
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
    return streamInfo(item).variants?.[Number(quality.value) || 0] || null;
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
    // The size has its own element that never shrinks; duration and host may be cut off.
    const parts = [];
    let sizeText = '';
    let warning = '';
    let blocked = false;
    if (item.kind === 'file') {
      sizeText = item.size ? formatBytes(item.size) : '';
    } else {
      const info = streamInfo(item);
      const variant = selectedVariant();
      const bandwidth = (variant?.bandwidth || 0) + (info.audioBandwidth || 0);
      if (info.live) sizeText = t('live');
      else if (bandwidth && info.duration) sizeText = `~${formatBytes((bandwidth * info.duration) / 8)}`;
      if (info.duration && !info.live) parts.push(formatDuration(info.duration));
      if (info.error) warning = `${t('noteHlsError')} ${info.error}`;
      else if (info.problem) {
        warning = t(`dashProblem_${info.problem}`);
        blocked = true;
      } else if (info.encryption === 'DRM' || info.encryption === 'SAMPLE-AES') {
        warning = t('noteDrm');
        blocked = true;
      } else if (info.live) warning = t('noteLive');
      else if ((variant?.audioUrl || info.audioId) && !settings.convertMp4) warning = t('noteAudio');
    }
    size.textContent = sizeText || '—';
    size.title = sizeText ? '' : t('sizeUnknown');
    parts.push(hostOf(item.url));
    meta.textContent = parts.filter(Boolean).join(' · ');
    meta.title = item.url;
    showNote(warning);
    download.disabled = blocked;
  }

  function update(next, focus = '') {
    item = next;
    el.dataset.key = item.key;
    el.classList.toggle('focused', Boolean(focus));
    badge.hidden = !focus;
    badge.textContent = focus === 'picked' ? `◎ ${t('focusPicked')}` : `▶ ${t('focusPlaying')}`;
    const pageTitle = item.pageUrl && item.pageUrl === tab?.url ? tab.title : item.pageTitle;
    suggestion = suggestName(item, settings.naming, pageTitle);
    if (!nameEdited) name.value = selection.current || suggestion.base;
    candidates = nameCandidates(item, pageTitle, selection.current || selection.last);
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
    ext.textContent = suggestion.ext ? `.${suggestion.ext}` : item.kind !== 'file' && settings.convertMp4 ? `.${streamExt(item)}` : '';

    const variants = streamInfo(item).variants || [];
    const signature = variants.map((v) => v.url || v.id).join('|');
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

  hide.addEventListener('click', () => send({ type: 'hideItem', tabId: tab.id, key: item.key }));

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
