// Downloads an HLS stream: fetches the playlist, all segments (decrypting AES-128),
// concatenates them and hands the result to chrome.downloads under the chosen name.

import { applyI18n, t } from '../lib/i18n.js';
import { formatBytes, formatDuration } from '../lib/format.js';
import { parsePlaylist } from '../lib/hls.js';
import { joinPath, makeFileName } from '../lib/filename.js';
import { getSettings } from '../lib/settings.js';
import { clearTabReferer, setTabReferer } from '../lib/referer.js';
import { createRemuxer } from '../lib/mp4/remux.js';
import { buildMp4 } from '../lib/mp4/muxer.js';

const RETRIES = 4;
const RAW_AUDIO_EXT = new Set(['aac', 'mp3', 'ac3', 'ec3']);

const params = new URLSearchParams(location.search);
const source = params.get('url');
const audioSource = params.get('audio') || '';
const baseName = params.get('name') || 'video';
const referer = params.get('referer') || '';

const $ = (id) => document.getElementById(id);
const ui = {
  name: $('name'),
  source: $('source'),
  status: $('status'),
  percent: $('percent'),
  bar: $('bar'),
  stats: $('stats'),
  warnings: $('warnings'),
  failed: $('failed'),
  failedText: $('failed-text'),
  retry: $('retry'),
  skip: $('skip'),
  saveAgain: $('save-again'),
  cancel: $('cancel'),
  close: $('close'),
};

const controller = new AbortController();
let settings;
let tabId = null;
let busy = true;

class Cancelled extends Error {}

applyI18n();
main();

async function main() {
  ui.name.textContent = baseName;
  document.title = baseName;
  try {
    ui.source.textContent = new URL(source).hostname;
  } catch {
    // Shown empty.
  }
  ui.cancel.addEventListener('click', () => controller.abort());
  ui.close.addEventListener('click', closeTab);
  window.addEventListener('beforeunload', (e) => {
    if (busy) e.preventDefault();
  });

  settings = await getSettings();
  tabId = (await chrome.tabs.getCurrent())?.id ?? null;
  if (tabId != null) {
    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    await setTabReferer(tabId, referer);
  }

  try {
    setStatus(t('dlLoading'));
    let video = await loadPlaylist(source);
    let audioUrl = audioSource;
    if (video.type === 'master') {
      const best = video.variants[0];
      if (!best) throw new Error(t('errEmpty'));
      audioUrl ||= best.audioUrl || '';
      video = await loadPlaylist(best.url);
      if (video.type !== 'media') throw new Error(t('errEmpty'));
    }

    const tracks = [{ label: t('trackVideo'), playlist: video, suffix: '', audio: false }];
    if (audioUrl) tracks.push({ label: t('trackAudio'), url: audioUrl, suffix: ` (${t('trackAudioSuffix')})`, audio: true });

    // Converted tracks go into one MP4; tracks left in the original container are saved separately.
    const mp4Tracks = [];
    const rawFiles = [];
    for (const [index, track] of tracks.entries()) {
      track.playlist ||= await loadPlaylist(track.url);
      const label = tracks.length > 1 ? `${track.label} ${index + 1}/${tracks.length}` : '';
      const result = await downloadTrack(track.playlist, track.audio, label);
      if (result.tracks) mp4Tracks.push(...result.tracks);
      else rawFiles.push({ ...result, suffix: track.suffix });
    }
    if (mp4Tracks.length) {
      setStatus(t('dlMuxing'));
      const { blob, ext } = buildMp4(mp4Tracks);
      await save(blob, makeFileName(baseName, ext), ext);
    }
    for (const file of rawFiles) {
      await save(file.blob, makeFileName(baseName + file.suffix, file.ext), file.ext);
    }

    finish(t('dlDone'), 'done');
    if (settings.autoClose) setTimeout(closeTab, 2000);
  } catch (e) {
    if (e instanceof Cancelled || controller.signal.aborted) finish(t('dlCancelled'), '');
    else finish(`${t('dlError')}: ${e.message || e}`, 'error');
  }
}

function setStatus(text, tone = '') {
  ui.status.textContent = text;
  ui.status.className = tone;
}

function setProgress(fraction) {
  const pct = Math.floor(fraction * 100);
  ui.bar.style.width = `${pct}%`;
  ui.percent.textContent = `${pct}%`;
  document.title = `${pct}% · ${baseName}`;
}

function warn(text) {
  const li = document.createElement('li');
  li.textContent = text;
  ui.warnings.append(li);
}

function finish(text, tone) {
  busy = false;
  setStatus(text, tone);
  document.title = `${tone === 'done' ? '✓' : '✕'} ${baseName}`;
  ui.cancel.hidden = true;
  ui.close.hidden = false;
  ui.failed.hidden = true;
  if (tabId != null) clearTabReferer(tabId);
}

function closeTab() {
  if (tabId != null) chrome.tabs.remove(tabId);
  else window.close();
}

function checkAborted() {
  if (controller.signal.aborted) throw new Cancelled();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, range, as) {
  for (let attempt = 0; ; attempt++) {
    checkAborted();
    try {
      const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined;
      const response = await fetch(url, { headers, credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return as === 'text' ? await response.text() : await response.arrayBuffer();
    } catch (e) {
      if (controller.signal.aborted) throw new Cancelled();
      if (attempt >= RETRIES || /HTTP 40[14]|HTTP 410/.test(e.message)) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function loadPlaylist(url) {
  return parsePlaylist(await fetchWithRetry(url, null, 'text'), url);
}

// --- AES-128 ---------------------------------------------------------------------------------

const keys = new Map();

function cryptoKey(url) {
  if (!keys.has(url)) {
    const promise = fetchWithRetry(url, null, 'buffer').then((raw) =>
      crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']),
    );
    promise.catch(() => keys.delete(url));
    keys.set(url, promise);
  }
  return keys.get(url);
}

function ivFor(segment) {
  const iv = new Uint8Array(16);
  if (segment.key.iv) {
    const hex = segment.key.iv.replace(/^0x/i, '').padStart(32, '0').slice(-32);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    // Default IV is the media sequence number, big-endian.
    let n = segment.seq;
    for (let i = 15; i >= 0 && n > 0; i--) {
      iv[i] = n % 256;
      n = Math.floor(n / 256);
    }
  }
  return iv;
}

async function fetchSegment(segment) {
  const data = await fetchWithRetry(segment.url, segment.range, 'buffer');
  if (segment.key?.method !== 'AES-128') return data;
  const key = await cryptoKey(segment.key.url);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(segment) }, key, data);
}

// --- Track download --------------------------------------------------------------------------

function mapKey(map) {
  return map ? `${map.url}#${map.range?.offset ?? ''}-${map.range?.length ?? ''}` : '';
}

function outputType(playlist, audio) {
  if (playlist.segments.some((s) => s.map)) return audio ? { ext: 'm4a', mime: 'audio/mp4' } : { ext: 'mp4', mime: 'video/mp4' };
  let ext = '';
  try {
    ext = new URL(playlist.segments[0].url).pathname.match(/\.([a-z0-9]{1,4})$/i)?.[1].toLowerCase() || '';
  } catch {
    // Default below.
  }
  if (RAW_AUDIO_EXT.has(ext)) return { ext, mime: ext === 'mp3' ? 'audio/mpeg' : 'audio/aac' };
  if (ext === 'mp4') return { ext: 'mp4', mime: 'video/mp4' };
  return { ext: 'ts', mime: 'video/mp2t' };
}

async function downloadTrack(playlist, audio, label) {
  const segments = playlist.segments;
  if (playlist.drm || segments.some((s) => s.key && s.key.method !== 'AES-128')) throw new Error(t('errDrm'));
  if (!segments.length) throw new Error(t('errEmpty'));
  if (!playlist.endList) warn(t('dlLiveWarning'));

  // Init sections of fragmented MP4 come first: a broken one makes the whole file useless.
  const inits = new Map();
  for (const segment of segments) {
    const key = mapKey(segment.map);
    if (key && !inits.has(key)) {
      const buffer = await fetchWithRetry(segment.map.url, segment.map.range, 'buffer');
      inits.set(key, { buffer, blob: new Blob([buffer]) });
    }
  }

  // MP4 conversion: undefined = decided by the first segment, null = keep the original container.
  let remuxer = settings.convertMp4 ? undefined : null;
  let processed = 0;
  const keepOriginal = (reason) => {
    remuxer = null;
    warn(`${t('warnNoConvert')} ${reason}`);
  };
  if (remuxer === undefined && inits.size > 1) keepOriginal('multiple init sections');
  else if (remuxer === undefined && inits.size) {
    try {
      remuxer = createRemuxer(null, [...inits.values()][0].buffer);
    } catch (e) {
      keepOriginal(e.message);
    }
  }

  // Stores a downloaded segment: remuxed (TS data is not kept twice) or as it is.
  const store = (i, data) => {
    if (remuxer !== null) {
      try {
        if (remuxer === undefined) remuxer = createRemuxer(data, null);
        const blob = inits.size ? new Blob([data]) : null; // fMP4 samples are slices of the segment
        remuxer.process(i, data, blob);
        results[i] = blob || true;
        processed++;
        return;
      } catch (e) {
        if (processed > 0) throw e;
        keepOriginal(e.message);
      }
    }
    results[i] = new Blob([data]);
  };

  const results = new Array(segments.length);
  const stats = { done: 0, bytes: 0, started: performance.now(), lastError: null };
  const prefix = label ? `${label} — ` : '';
  setStatus(`${prefix}${t('dlDownloading')}`);
  setProgress(0);

  const report = () => {
    const elapsed = (performance.now() - stats.started) / 1000;
    const speed = elapsed > 0.5 ? stats.bytes / elapsed : 0;
    const remaining = segments.length - stats.done;
    const eta = speed && stats.done ? (remaining * (stats.bytes / stats.done)) / speed : 0;
    setProgress(stats.done / segments.length);
    ui.stats.textContent = [
      `${stats.done} / ${segments.length} ${t('statSegments')}`,
      formatBytes(stats.bytes),
      speed ? `${formatBytes(speed)}${t('perSecond')}` : '',
      eta ? `${formatDuration(eta)} ${t('statLeft')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };

  const run = async (indexes) => {
    const failed = [];
    let next = 0;
    const worker = async () => {
      while (next < indexes.length) {
        checkAborted();
        const i = indexes[next++];
        try {
          const data = await fetchSegment(segments[i]);
          store(i, data);
          stats.done++;
          stats.bytes += data.byteLength;
        } catch (e) {
          if (e instanceof Cancelled || controller.signal.aborted) throw new Cancelled();
          failed.push(i);
          stats.lastError = e;
        }
        report();
      }
    };
    const workers = Math.max(1, Math.min(Number(settings.concurrency) || 6, 16, indexes.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return failed.sort((a, b) => a - b);
  };

  let failed = await run(segments.map((_, i) => i));
  while (failed.length) {
    const choice = await askAboutFailed(failed.length, stats.lastError);
    if (choice === 'skip') break;
    setStatus(`${prefix}${t('dlDownloading')}`);
    failed = await run(failed);
  }

  if (remuxer) return { tracks: remuxer.tracks() };

  setStatus(t('dlSaving'));
  const parts = [];
  let currentMap = '';
  segments.forEach((segment, i) => {
    if (!results[i]) return;
    const key = mapKey(segment.map);
    if (key && key !== currentMap) parts.push(inits.get(key).blob);
    currentMap = key;
    parts.push(results[i]);
  });
  const type = outputType(playlist, audio);
  return { blob: new Blob(parts, { type: type.mime }), ext: type.ext };
}

function askAboutFailed(count, error) {
  ui.failed.hidden = false;
  ui.failedText.textContent = `${t('dlFailed')} ${count}${error ? ` (${error.message})` : ''}`;
  return new Promise((resolve, reject) => {
    const done = (value) => {
      ui.failed.hidden = true;
      ui.retry.onclick = ui.skip.onclick = null;
      controller.signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      ui.failed.hidden = true;
      reject(new Cancelled());
    };
    ui.retry.onclick = () => done('retry');
    ui.skip.onclick = () => done('skip');
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
}

// --- Saving ----------------------------------------------------------------------------------

function waitForDownload(id) {
  return new Promise((resolve) => {
    const listener = (delta) => {
      if (delta.id === id && delta.state && delta.state.current !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(delta.state.current);
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item && item.state !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(item.state);
      }
    });
  });
}

async function save(blob, fileName, ext) {
  checkAborted();
  // The blob URL must stay alive until the browser has finished writing the file.
  const url = URL.createObjectURL(blob);
  const options = { url, conflictAction: 'uniquify', saveAs: settings.saveAs };
  for (;;) {
    let id;
    try {
      id = await chrome.downloads.download({ ...options, filename: joinPath(settings.subfolder, fileName) });
    } catch (e) {
      if (!/filename/i.test(String(e?.message))) throw e;
      id = await chrome.downloads.download({ ...options, filename: joinPath(settings.subfolder, `video.${ext}`) });
    }
    const state = await waitForDownload(id);
    if (state === 'complete') break;
    // Save dialog dismissed or write failed: the data is still in memory, offer another attempt.
    setStatus(t('dlSaveInterrupted'), 'error');
    ui.saveAgain.hidden = false;
    await new Promise((resolve, reject) => {
      ui.saveAgain.onclick = () => resolve();
      controller.signal.addEventListener('abort', () => reject(new Cancelled()), { once: true });
    });
    ui.saveAgain.hidden = true;
    setStatus(t('dlSaving'));
  }
  URL.revokeObjectURL(url);
}
