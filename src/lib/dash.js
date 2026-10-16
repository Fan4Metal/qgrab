// MPEG-DASH manifests: representations and their segments, as playlists the downloader understands.

import { child, children, parseXml } from './xml.js';
import { readType, readU32, readU64, UnsupportedError } from './mp4/bytes.js';

/** ISO 8601 duration (PT1H2M3.5S) in seconds. */
export function parseDuration(value) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value || '');
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
}

function parseRange(value) {
  const m = /^(\d+)-(\d+)$/.exec(value || '');
  return m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : null;
}

function baseOf(el, base) {
  const url = child(el, 'BaseURL')?.text.trim();
  return url ? new URL(url, base).href : base;
}

/** Segment information inherits from Period → AdaptationSet → Representation. */
function inherited(levels, name) {
  const found = levels.map((el) => child(el, name)).filter(Boolean);
  if (!found.length) return null;
  const attrs = Object.assign({}, ...found.map((el) => el.attrs));
  const deepest = found[found.length - 1];
  const timeline = [...found].reverse().map((el) => child(el, 'SegmentTimeline')).find(Boolean) || null;
  const initialization = [...found].reverse().map((el) => child(el, 'Initialization')).find(Boolean) || null;
  return { attrs, timeline, initialization, element: deepest };
}

export function fillTemplate(template, vars) {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth|SubNumber)(?:%0(\d+)d)?\$|\$\$/g, (m, name, width) => {
    if (m === '$$') return '$';
    const value = String(vars[name] ?? '');
    return width ? value.padStart(Number(width), '0') : value;
  });
}

/**
 * @returns {{live, duration, multiPeriod, video: Rep[], audio: Rep[]}}
 * Rep: {id, kind, mime, codecs, bandwidth, width, height, lang, drm, base, template, list, segmentBase, duration}
 */
export function parseMpd(text, url) {
  const mpd = child(parseXml(text), 'MPD');
  if (!mpd) throw new Error('Not a DASH manifest');
  const periods = children(mpd, 'Period');
  const period = periods[0];
  if (!period) throw new Error('DASH manifest without periods');
  const total = parseDuration(mpd.attrs.mediaPresentationDuration);
  const duration = parseDuration(period.attrs.duration) || total;
  const periodBase = baseOf(period, baseOf(mpd, url));

  const reps = [];
  for (const set of children(period, 'AdaptationSet')) {
    const setBase = baseOf(set, periodBase);
    for (const rep of children(set, 'Representation')) {
      const mime = rep.attrs.mimeType || set.attrs.mimeType || '';
      const codecs = rep.attrs.codecs || set.attrs.codecs || '';
      const kind = set.attrs.contentType || rep.attrs.contentType || mime.split('/')[0];
      if (kind !== 'video' && kind !== 'audio') continue;
      const levels = [period, set, rep];
      reps.push({
        id: rep.attrs.id || '',
        kind,
        mime,
        codecs,
        bandwidth: Number(rep.attrs.bandwidth) || 0,
        width: Number(rep.attrs.width || set.attrs.width) || 0,
        height: Number(rep.attrs.height || set.attrs.height) || 0,
        lang: set.attrs.lang || '',
        drm: children(set, 'ContentProtection').length + children(rep, 'ContentProtection').length > 0,
        base: baseOf(rep, setBase),
        template: inherited(levels, 'SegmentTemplate'),
        list: inherited(levels, 'SegmentList'),
        segmentBase: inherited(levels, 'SegmentBase'),
        duration,
      });
    }
  }
  const byQuality = (a, b) => b.height - a.height || b.bandwidth - a.bandwidth;
  return {
    live: mpd.attrs.type === 'dynamic',
    duration,
    multiPeriod: periods.length > 1,
    video: reps.filter((r) => r.kind === 'video').sort(byQuality),
    audio: reps.filter((r) => r.kind === 'audio').sort(byQuality),
  };
}

/** Representations that can be assembled into MP4: fragmented MP4 without DRM. */
export function usable(reps) {
  return reps.filter((r) => !r.drm && !/webm/i.test(r.mime));
}

/** Default audio: the best MP4 audio in the first listed language. */
export function pickAudio(mpd) {
  const audio = usable(mpd.audio);
  if (!audio.length) return null;
  const lang = audio[0].lang;
  return audio.filter((r) => r.lang === lang).sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

/** Why the manifest cannot be downloaded, or ''. */
export function problemOf(mpd) {
  if (mpd.live) return 'live';
  if (![...mpd.video, ...mpd.audio].length) return 'empty';
  if (![...mpd.video, ...mpd.audio].some((r) => !r.drm)) return 'drm';
  if (!usable(mpd.video).length && !usable(mpd.audio).length) return 'webm';
  return '';
}

function parseSidx(data, boxOffset) {
  let p = 0;
  while (p + 8 <= data.length && readType(data, p + 4) !== 'sidx') p += readU32(data, p) || data.length;
  if (p + 8 > data.length) throw new UnsupportedError('no segment index (sidx)');
  const size = readU32(data, p);
  const version = data[p + 8];
  const timescale = readU32(data, p + 16);
  let q = p + 20;
  const firstOffset = version === 0 ? readU32(data, q + 4) : readU64(data, q + 8);
  q += version === 0 ? 8 : 16;
  const count = (data[q + 2] << 8) | data[q + 3];
  q += 4;
  let offset = boxOffset + p + size + firstOffset;
  const refs = [];
  for (let i = 0; i < count; i++, q += 12) {
    const word = readU32(data, q);
    if (word >>> 31) throw new UnsupportedError('hierarchical segment index');
    const length = word & 0x7fffffff;
    refs.push({ offset, length, duration: readU32(data, q + 4) / timescale });
    offset += length;
  }
  return refs;
}

/**
 * Segments of a representation in the shape of an HLS media playlist.
 * @param fetchRange (url, {offset, length}) → ArrayBuffer; used only for SegmentBase (sidx) representations
 */
export async function representationPlaylist(rep, fetchRange) {
  const segments = [];
  const push = (url, duration, range, map) => segments.push({ url, duration, seq: segments.length, key: null, map, range });

  if (rep.template) {
    const { attrs, timeline } = rep.template;
    const timescale = Number(attrs.timescale) || 1;
    const start = attrs.startNumber != null ? Number(attrs.startNumber) : 1;
    const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
    const map = attrs.initialization ? { url: new URL(fillTemplate(attrs.initialization, vars), rep.base).href, range: null } : null;
    if (!attrs.media) throw new UnsupportedError('SegmentTemplate without media');
    const add = (number, time, d) => push(new URL(fillTemplate(attrs.media, { ...vars, Number: number, Time: time }), rep.base).href, d / timescale, null, map);
    if (timeline) {
      let number = start;
      let time = 0;
      const items = children(timeline, 'S');
      items.forEach((s, i) => {
        if (s.attrs.t != null) time = Number(s.attrs.t);
        const d = Number(s.attrs.d);
        let repeat = Number(s.attrs.r || 0);
        if (repeat < 0) {
          const end = items[i + 1]?.attrs.t != null ? Number(items[i + 1].attrs.t) : rep.duration * timescale;
          repeat = Math.max(0, Math.ceil((end - time) / d) - 1);
        }
        for (let k = 0; k <= repeat; k++) {
          add(number++, time, d);
          time += d;
        }
      });
    } else {
      const d = Number(attrs.duration);
      if (!d || !rep.duration) throw new UnsupportedError('SegmentTemplate without timeline or duration');
      const count = Math.ceil((rep.duration * timescale) / d - 1e-6);
      for (let i = 0; i < count; i++) add(start + i, i * d, d);
    }
  } else if (rep.list) {
    const { attrs, initialization, element } = rep.list;
    const timescale = Number(attrs.timescale) || 1;
    const d = Number(attrs.duration) || 0;
    const map = initialization
      ? { url: new URL(initialization.attrs.sourceURL || '', rep.base).href, range: parseRange(initialization.attrs.range) }
      : null;
    for (const s of children(element, 'SegmentURL')) {
      push(new URL(s.attrs.media || '', rep.base).href, d / timescale, parseRange(s.attrs.mediaRange), map);
    }
  } else if (rep.segmentBase) {
    const index = parseRange(rep.segmentBase.attrs.indexRange);
    if (!index) throw new UnsupportedError('SegmentBase without indexRange');
    const init = parseRange(rep.segmentBase.initialization?.attrs.range) || { offset: 0, length: index.offset };
    const data = new Uint8Array(await fetchRange(rep.base, index));
    const map = { url: rep.base, range: init };
    for (const ref of parseSidx(data, index.offset)) push(rep.base, ref.duration, { offset: ref.offset, length: ref.length }, map);
  } else {
    throw new UnsupportedError('representation without segment information');
  }

  if (!segments.length) throw new UnsupportedError('representation without segments');
  return { type: 'media', segments, duration: segments.reduce((n, s) => n + s.duration, 0), endList: true, drm: rep.drm };
}
