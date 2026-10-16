// Media type detection. Pure functions: shared by the service worker, pages and tests.

export const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'f4v', 'ogv', '3gp', 'wmv', 'mpg', 'mpeg', 'ts',
]);
export const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'wma', 'weba']);

// Pieces of adaptive streams: useless on their own, never listed.
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa']);
const SEGMENT_MIME = new Set(['video/mp2t', 'audio/mp2t', 'video/iso.segment', 'audio/iso.segment']);

export const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/ogg': 'ogv',
  'video/3gpp': '3gp',
  'video/x-ms-wmv': 'wmv',
  'video/mpeg': 'mpg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

const GENERIC_MIME = /^(application\/(octet-stream|force-download|x-download|download|binary)|binary\/octet-stream)?$/;

// Hosts whose media requests are split audio/video chunks that cannot be saved as files.
const IGNORED_HOSTS = /(^|\.)googlevideo\.com$/i;

export function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

export function mediaExtOf(name) {
  const ext = extOf(name);
  return VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext) ? ext : '';
}

export function normalizeMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

/**
 * Decides what a response is.
 * @returns {{kind: 'file'|'hls'|'dash'|'segment', ext?: string} | null}
 */
export function classify({ url, mime, fileName }) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const type = normalizeMime(mime);
  const ext = extOf(path);

  if (type.includes('mpegurl') || ext === 'm3u8' || extOf(fileName) === 'm3u8') return { kind: 'hls', ext: '' };
  if (type === 'application/dash+xml' || ext === 'mpd') return { kind: 'dash', ext: '' };
  if (SEGMENT_MIME.has(type) || SEGMENT_EXT.has(ext)) return { kind: 'segment' };

  const fileExt = mediaExtOf(fileName) || mediaExtOf(path);
  if (type.startsWith('video/') || type.startsWith('audio/')) {
    return { kind: 'file', ext: fileExt || MIME_EXT[type] || (type.startsWith('audio/') ? 'mp3' : 'mp4') };
  }
  if (fileExt && GENERIC_MIME.test(type)) return { kind: 'file', ext: fileExt };
  return null;
}

export function isIgnoredUrl(url) {
  try {
    return IGNORED_HOSTS.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

/**
 * URL "shape" with numbers masked: chunks of one MSE stream share it
 * (`/v/seg-12.mp4`, `/v/seg-13.mp4`). Empty when the URL has no numbers.
 */
export function patternKey(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const last = parts.pop();
    const ext = extOf(last);
    const stem = ext ? last.slice(0, -ext.length - 1) : last;
    if (!/\d/.test(stem) && !/\d/.test(u.search)) return '';
    const query = [...new Set(u.searchParams.keys())].sort().join('&');
    return `${u.host}${parts.join('/')}/${stem.replace(/\d+/g, '#')}.${ext}?${query}`;
  } catch {
    return '';
  }
}
