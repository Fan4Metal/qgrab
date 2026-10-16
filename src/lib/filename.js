// File name extraction and sanitizing. Pure functions: shared by the service worker, pages and tests.

import { mediaExtOf } from './media.js';

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// Names that say nothing about the content: stream manifests, CDN placeholders, qualities.
const GENERIC = new RegExp(
  '^(index|master|playlist|manifest|chunklist|media|video|videos|movie|movies|stream|streams|file|files|' +
    'download|downloads|videoplayback|source|src|output|out|default|main|hls|dash|vod|live|mp4|m3u8|' +
    'play|player|get|view|embed|watch|content|contents|prog_index|mono|stereo|audio|seg|segment|init|' +
    'cdn|upload|uploads|public|static|assets|data|hd|sd|fhd|uhd|high|low|medium|mid|best|original|primary)$',
  'i',
);
const GENERIC_PREFIXED =
  /^(chunklist|playlist|index|master|manifest|media|seg|segment|init|stream|video|audio|hls)[_\-.]?[a-z]*\d[\w\-.]*$/i;

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function basename(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

// Header values reach extensions as Latin-1; UTF-8 names arrive as mojibake ("Ð¤Ð¸Ð»ÑŒÐ¼").
function fixMojibake(s) {
  if (!/[\u0080-\u00ff]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

function decodeExtValue(charset, value) {
  if (!charset || /^utf-?8$/i.test(charset)) return decodeURIComponent(value);
  // ISO-8859-1 and friends: every %XX is one character.
  return value.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** File name from a Content-Disposition value (RFC 6266 / RFC 5987), or ''. */
export function parseContentDisposition(value) {
  if (!value) return '';
  const ext = /filename\*\s*=\s*"?([^']*)'[^']*'([^;"\s]+)/i.exec(value);
  if (ext) {
    try {
      const name = basename(decodeExtValue(ext[1], ext[2]));
      if (name) return name;
    } catch {
      // Malformed encoding: fall back to the plain parameter.
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/i.exec(value);
  if (!plain) return '';
  let name = plain[1] != null ? plain[1].replace(/\\(.)/g, '$1') : plain[2].trim();
  name = fixMojibake(name);
  if (/%[0-9a-f]{2}/i.test(name)) name = safeDecode(name);
  return basename(name);
}

const FLAG_VALUE = /^(1|0|true|false|yes|no|on|off|attachment|inline)$/i;

/** File name hidden in a URL: signed-URL disposition, explicit parameters, or the last path segment. */
export function nameFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const q = u.searchParams;
  for (const key of ['response-content-disposition', 'rscd', 'content-disposition']) {
    const name = parseContentDisposition(q.get(key));
    if (name) return name;
  }
  for (const key of ['filename', 'file_name', 'fileName', 'fname', 'fn', 'download_filename', 'dl']) {
    const v = q.get(key);
    if (v && !FLAG_VALUE.test(v) && basename(v)) return basename(v);
  }
  const last = safeDecode(u.pathname.split('/').filter(Boolean).pop() || '');
  if (mediaExtOf(last)) return last;
  for (const key of ['file', 'name', 'title', 'video']) {
    const v = q.get(key);
    if (v && /\p{L}/u.test(v) && !FLAG_VALUE.test(v) && basename(v)) return basename(v);
  }
  return last;
}

/** Closest meaningful parent directory: `/movies/Big_Buck_Bunny/hls/index.m3u8` → `Big_Buck_Bunny`. */
export function dirNameFromUrl(url) {
  let segments;
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean).map(safeDecode);
  } catch {
    return '';
  }
  segments.pop();
  for (let i = segments.length - 1; i >= Math.max(0, segments.length - 3); i--) {
    if (!isGenericName(segments[i])) return segments[i];
  }
  return '';
}

/** True for names that carry no information: `index`, `chunklist_b800000`, `1080p`, hashes, UUIDs. */
export function isGenericName(name) {
  const s = String(name || '').trim().replace(/\.[a-z0-9]{1,5}$/i, '');
  if (s.length < 2) return true;
  if (GENERIC.test(s) || GENERIC_PREFIXED.test(s)) return true;
  if (/^[\d\s_\-.]+$/.test(s)) return true;
  if (/^v\d+$/i.test(s)) return true;
  if (/^\d{3,4}p\d*([_\-.]\w+)?$/i.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{12,}$/i.test(s)) return true;
  if (/^[A-Za-z0-9]{16,}$/.test(s) && s.replace(/\D/g, '').length / s.length >= 0.25) return true;
  return false;
}

export function cleanTitle(title) {
  return String(title || '')
    .replace(/^\(\d+\+?\)\s*/, '') // "(3) Inbox" notification counters
    .replace(/^[▶►•●]\s*/u, '')
    .trim();
}

/** Makes one path component valid on Windows, macOS and Linux and acceptable to chrome.downloads. */
export function sanitizeName(input, max = 150) {
  let s = String(input ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s*[:|]\s*/g, ' - ')
    .replace(/[\\/]/g, '-')
    .replace(/"/g, "'")
    .replace(/[*?<>]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/( - )+/g, ' - ')
    .trim()
    .replace(/^[\s.\-]+|[\s.]+$/g, '');
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, max).join('').replace(/[\s.\-]+$/, '');
  if (RESERVED.test(s.split('.')[0])) s = `_${s}`;
  return s;
}

export function makeFileName(base, ext) {
  const b = sanitizeName(base) || 'video';
  const e = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return e ? `${b}.${e}` : b;
}

/** Relative path inside the Downloads folder; `..` and empty parts are dropped. */
export function joinPath(folder, file) {
  const parts = String(folder || '')
    .split(/[\\/]+/)
    .map((p) => sanitizeName(p, 80))
    .filter(Boolean);
  return [...parts, file].join('/');
}

export function splitName(name) {
  const s = String(name || '').trim();
  const m = /^(.+)\.([a-z0-9]{1,5})$/i.exec(s);
  if (m && (mediaExtOf(s) || /^(m3u8|mpd)$/i.test(m[2]))) return { base: m[1], ext: m[2].toLowerCase() };
  return { base: s, ext: '' };
}

/**
 * Suggested name for a detected item.
 * naming: 'smart' | 'original' | 'title' | 'titleOriginal'
 * @returns {{base: string, ext: string}} ext is empty for streams (the downloader picks it).
 */
export function suggestName(item, naming = 'smart', pageTitle = '') {
  const orig = splitName(item.originalName);
  const title = cleanTitle(pageTitle || item.pageTitle);
  const stream = item.kind !== 'file';
  const origOk = Boolean(orig.base) && !isGenericName(orig.base);
  const dir = stream && !origOk ? dirNameFromUrl(item.url) : '';
  const best = origOk ? orig.base : dir;

  let base;
  switch (naming) {
    case 'original':
      base = orig.base || dir || title;
      break;
    case 'title':
      base = title || best || orig.base;
      break;
    case 'titleOriginal':
      if (title && best) base = title.includes(best) ? title : `${title} - ${best}`;
      else base = title || best || orig.base;
      break;
    default:
      base = best || title || orig.base;
  }
  const ext = stream ? '' : mediaExtOf(item.originalName) || item.ext || 'mp4';
  return { base: sanitizeName(base) || 'video', ext };
}
