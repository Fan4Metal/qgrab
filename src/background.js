import { classify, isIgnoredUrl, patternKey } from './lib/media.js';
import { joinPath, nameFromUrl, parseContentDisposition } from './lib/filename.js';
import { describeMedia, parsePlaylist } from './lib/hls.js';
import { DEFAULTS, getSettings } from './lib/settings.js';
import { clearTabReferer, setHostReferer } from './lib/referer.js';

// After this many same-shaped small files on one tab they are treated as MSE chunks and hidden.
const FRAGMENT_LIMIT = 3;
const FRAGMENT_MAX_SIZE = 20 * 1024 * 1024;
const DOWNLOADER_PAGE = 'src/downloader/downloader.html';
const SELF_ORIGIN = new URL(chrome.runtime.getURL('')).origin;

/** tabId → {items: Map<key, item>, children: Set<url>, patterns: {[key]: count}} */
const tabs = new Map();
let settings = { ...DEFAULTS };

// The worker is restarted at any time; per-tab state survives in storage.session.
const ready = (async () => {
  settings = await getSettings();
  const stored = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith('tab:')) tabs.set(Number(key.slice(4)), reviveTab(value));
  }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue ?? DEFAULTS[key];
});

function reviveTab(value) {
  return {
    items: new Map((value.items || []).map((item) => [item.key, item])),
    children: new Set(value.children || []),
    patterns: value.patterns || {},
  };
}

function getTab(tabId) {
  let state = tabs.get(tabId);
  if (!state) {
    state = { items: new Map(), children: new Set(), patterns: {} };
    tabs.set(tabId, state);
  }
  return state;
}

const saveTimers = new Map();

function changed(tabId) {
  const count = tabs.get(tabId)?.items.size || 0;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'itemsChanged', tabId }).catch(() => {});
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(
    tabId,
    setTimeout(() => {
      saveTimers.delete(tabId);
      const state = tabs.get(tabId);
      if (!state || !state.items.size) {
        chrome.storage.session.remove(`tab:${tabId}`);
        return;
      }
      chrome.storage.session.set({
        [`tab:${tabId}`]: {
          items: [...state.items.values()],
          children: [...state.children],
          patterns: state.patterns,
        },
      });
    }, 300),
  );
}

function resetTab(tabId) {
  if (!tabs.has(tabId)) return;
  tabs.delete(tabId);
  changed(tabId);
}

function header(details, name) {
  return details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value || '';
}

function sizeFrom(details) {
  const range = /\/(\d+)\s*$/.exec(header(details, 'content-range'));
  if (range) return Number(range[1]);
  const length = Number(header(details, 'content-length'));
  return details.statusCode === 200 && length > 0 ? length : null;
}

async function tabInfo(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url || tab.pendingUrl || '', title: tab.title || '' };
  } catch {
    return { url: '', title: '' };
  }
}

// --- Detection -------------------------------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0) ready.then(() => resetTab(details.tabId));
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300) return;
    if (details.initiator?.startsWith('chrome-extension://') || !/^https?:/i.test(details.url)) return;
    const fileName = parseContentDisposition(header(details, 'content-disposition'));
    const mime = header(details, 'content-type');
    const kind = classify({ url: details.url, mime, fileName });
    if (!kind || kind.kind === 'segment' || isIgnoredUrl(details.url)) return;
    ready.then(() =>
      addItem(details.tabId, {
        url: details.url,
        kind: kind.kind,
        ext: kind.ext,
        mime,
        size: sizeFrom(details),
        headerName: fileName,
        frameId: details.frameId,
        initiator: details.initiator,
      }),
    );
  },
  {
    urls: ['<all_urls>'],
    types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'object', 'other'],
  },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => resetTab(tabId));
  clearTabReferer(tabId);
});

function refererFor(info, page) {
  if (info.frameId === 0 || !info.initiator || info.initiator === 'null') return page.url;
  try {
    if (new URL(page.url).origin === info.initiator) return page.url;
  } catch {
    // The tab URL is not a valid URL (e.g. about:blank): use the initiator.
  }
  return `${info.initiator}/`;
}

function addItem(tabId, info) {
  const state = getTab(tabId);
  const key = info.url;
  if (state.children.has(key)) return;

  const existing = state.items.get(key);
  if (existing) {
    let updated = false;
    for (const field of ['size', 'mime', 'headerName']) {
      if (info[field] && !existing[field]) {
        existing[field] = info[field];
        updated = true;
      }
    }
    if (info.headerName && existing.originalName !== info.headerName) {
      existing.originalName = info.headerName;
      updated = true;
    }
    if (updated) changed(tabId);
    return;
  }

  if (info.kind === 'file') {
    if (info.size != null && info.size < settings.minSizeKB * 1024) return;
    const pattern = patternKey(info.url);
    if (pattern && (info.size == null || info.size < FRAGMENT_MAX_SIZE)) {
      const count = (state.patterns[pattern] || 0) + 1;
      state.patterns[pattern] = count;
      if (count >= FRAGMENT_LIMIT) {
        for (const [k, item] of state.items) if (patternKey(item.url) === pattern) state.items.delete(k);
        changed(tabId);
        return;
      }
    }
  }

  const item = {
    key,
    url: info.url,
    kind: info.kind,
    ext: info.ext || '',
    mime: info.mime || '',
    size: info.kind === 'file' ? (info.size ?? null) : null,
    headerName: info.headerName || '',
    originalName: info.headerName || nameFromUrl(info.url),
    pageUrl: '',
    pageTitle: '',
    referer: '',
    firstSeen: Date.now(),
  };
  // Inserted synchronously so parallel range requests for the same file do not duplicate it.
  state.items.set(key, item);

  tabInfo(tabId).then((page) => {
    item.pageUrl = page.url;
    item.pageTitle = page.title;
    item.referer = refererFor(info, page);
    changed(tabId);
    if (item.kind === 'hls') inspectHls(tabId, item);
  });
}

async function fetchText(url) {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** Reads the playlist to show qualities and duration, and to hide its sub-playlists from the list. */
async function inspectHls(tabId, item) {
  try {
    await setHostReferer(item.url, item.referer);
    const playlist = parsePlaylist(await fetchText(item.url), item.url);
    const state = tabs.get(tabId);
    if (!state || state.items.get(item.key) !== item) return;

    if (playlist.type === 'master') {
      item.hls = { master: true, variants: playlist.variants };
      for (const url of playlist.uris) {
        state.children.add(url);
        state.items.delete(url);
      }
      const best = playlist.variants[0];
      if (best) {
        try {
          await setHostReferer(best.url, item.referer);
          Object.assign(item.hls, describeMedia(parsePlaylist(await fetchText(best.url), best.url)));
        } catch {
          // Duration is optional.
        }
      }
    } else {
      item.hls = { master: false, variants: [], ...describeMedia(playlist) };
    }
  } catch (e) {
    item.hls = { error: String(e?.message || e), variants: [] };
  }
  changed(tabId);
}

// --- Messages --------------------------------------------------------------------------------

const handlers = {
  async getItems({ tabId }) {
    await ready;
    return [...(tabs.get(tabId)?.items.values() || [])].sort((a, b) => b.firstSeen - a.firstSeen);
  },

  async clearItems({ tabId }) {
    await ready;
    resetTab(tabId);
    return { ok: true };
  },

  // <video>/<audio> sources found in the page (covers media loaded before the extension started).
  async contentMedia({ items }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null || tabId < 0) return { ok: false };
    await ready;
    for (const { url, mime } of items || []) {
      if (!/^https?:/i.test(url) || isIgnoredUrl(url)) continue;
      const kind = classify({ url, mime }) || { kind: 'file', ext: '' };
      if (kind.kind === 'segment') continue;
      addItem(tabId, { url, kind: kind.kind, ext: kind.ext, mime, size: null, frameId: sender.frameId, initiator: sender.origin });
    }
    return { ok: true };
  },

  async download({ tabId, key, name, variant }) {
    await ready;
    const item = tabs.get(tabId)?.items.get(key);
    if (!item) throw new Error('The item is no longer available. Reload the page.');

    if (item.kind === 'file') {
      await setHostReferer(item.url, item.referer);
      const options = { url: item.url, conflictAction: 'uniquify', saveAs: settings.saveAs };
      try {
        await chrome.downloads.download({ ...options, filename: joinPath(settings.subfolder, name) });
      } catch (e) {
        if (!/filename/i.test(String(e?.message))) throw e;
        await chrome.downloads.download({ ...options, filename: joinPath(settings.subfolder, `video.${item.ext || 'mp4'}`) });
      }
      return { ok: true };
    }

    if (item.kind === 'hls') {
      const chosen = item.hls?.variants?.[variant];
      const params = new URLSearchParams({ url: chosen?.url || item.url, name, referer: item.referer || '' });
      if (chosen?.audioUrl) params.set('audio', chosen.audioUrl);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      await chrome.tabs.create({
        url: `${chrome.runtime.getURL(DOWNLOADER_PAGE)}?${params}`,
        active: false,
        ...(tab ? { index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId } : {}),
      });
      return { ok: true };
    }

    throw new Error('This stream type cannot be downloaded.');
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  if (message.type !== 'contentMedia' && sender.origin !== SELF_ORIGIN) return false;
  Promise.resolve(handler(message, sender)).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
