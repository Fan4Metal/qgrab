// Minimal HLS (m3u8) parser for master and media playlists. Pure functions.

export function parseAttributes(text) {
  const attrs = {};
  const re = /([A-Z0-9-]+)\s*=\s*("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(text))) {
    let value = m[2].trim();
    if (value.startsWith('"')) value = value.slice(1, -1);
    attrs[m[1].toUpperCase()] = value;
  }
  return attrs;
}

function tagValue(line) {
  const i = line.indexOf(':');
  return i < 0 ? '' : line.slice(i + 1);
}

function parseByteRange(text, defaultOffset) {
  const [length, offset] = String(text).split('@');
  return { length: Number(length), offset: offset != null ? Number(offset) : defaultOffset };
}

/**
 * @returns master: {type: 'master', variants: [{url, bandwidth, width, height, codecs, audioUrl?, audioName?}], uris}
 *          media:  {type: 'media', segments: [{url, duration, seq, key, map, range}], duration, endList, drm}
 */
export function parsePlaylist(text, baseUrl) {
  const lines = String(text)
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
  const resolve = (uri) => new URL(uri, baseUrl).href;
  return lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))
    ? parseMaster(lines, resolve)
    : parseMedia(lines, resolve);
}

function parseMaster(lines, resolve) {
  const audioGroups = new Map();
  const variants = [];
  // Every playlist referenced by the master: the player loads them too, they must not show up as separate items.
  const uris = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(tagValue(line));
      if (!a.URI) continue;
      const url = resolve(a.URI);
      uris.add(url);
      if (a.TYPE === 'AUDIO') {
        const group = audioGroups.get(a['GROUP-ID']) || [];
        group.push({ url, name: a.NAME || a.LANGUAGE || '', isDefault: a.DEFAULT === 'YES' });
        audioGroups.set(a['GROUP-ID'], group);
      }
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      const a = parseAttributes(tagValue(line));
      if (a.URI) uris.add(resolve(a.URI));
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(tagValue(line));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j >= lines.length) break;
      i = j;
      const url = resolve(lines[j]);
      uris.add(url);
      const [width, height] = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url,
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
        width: width || 0,
        height: height || 0,
        codecs: a.CODECS || '',
        audioGroup: a.AUDIO || '',
      });
    }
  }

  for (const v of variants) {
    const group = audioGroups.get(v.audioGroup);
    if (group?.length) {
      const rendition = group.find((r) => r.isDefault) || group[0];
      v.audioUrl = rendition.url;
      v.audioName = rendition.name;
    }
    delete v.audioGroup;
  }
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const seen = new Set();
  const unique = variants.filter((v) => !seen.has(v.url) && seen.add(v.url));
  return { type: 'master', variants: unique, uris: [...uris] };
}

function parseMedia(lines, resolve) {
  const segments = [];
  let mediaSequence = 0;
  let key = null;
  let map = null;
  let pendingDuration = 0;
  let pendingRange = null;
  let gap = false;
  let endList = false;
  let drm = false;
  let total = 0;
  const rangeEnds = new Map();

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(tagValue(line)) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(tagValue(line));
      const method = (a.METHOD || 'NONE').toUpperCase();
      const format = (a.KEYFORMAT || 'identity').toLowerCase();
      if (method === 'NONE') key = null;
      else if (format !== 'identity') drm = true;
      else key = { method, url: a.URI ? resolve(a.URI) : '', iv: a.IV || '' };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(tagValue(line));
      map = a.URI ? { url: resolve(a.URI), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null } : null;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(tagValue(line)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = tagValue(line);
    } else if (line === '#EXT-X-GAP') {
      gap = true;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (!line.startsWith('#')) {
      const url = resolve(line);
      let range = null;
      if (pendingRange) {
        range = parseByteRange(pendingRange, rangeEnds.get(url) ?? 0);
        rangeEnds.set(url, range.offset + range.length);
      }
      if (!gap) {
        segments.push({ url, duration: pendingDuration, seq: mediaSequence + segments.length, key, map, range });
      }
      total += pendingDuration;
      pendingDuration = 0;
      pendingRange = null;
      gap = false;
    }
  }
  return { type: 'media', segments, duration: total, endList, drm };
}

/** Short summary stored with a detected item. */
export function describeMedia(playlist) {
  const segments = playlist.segments;
  const method = segments.find((s) => s.key)?.key.method || null;
  return {
    duration: playlist.duration,
    live: !playlist.endList,
    fmp4: segments.some((s) => s.map),
    segments: segments.length,
    encryption: playlist.drm ? 'DRM' : method,
  };
}
