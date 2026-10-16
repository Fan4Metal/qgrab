// Fragmented MP4 (CMAF) parsing: init segment tracks and per-fragment sample tables.

import { readI32, readType, readU32, readU64, UnsupportedError } from './bytes.js';

export function readBoxes(data, start = 0, end = data.length) {
  const boxes = [];
  let p = start;
  while (p + 8 <= end) {
    let size = readU32(data, p);
    let header = 8;
    if (size === 1) {
      size = readU64(data, p + 8);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    boxes.push({ type: readType(data, p + 4), start: p, body: p + header, end: p + size });
    p += size;
  }
  return boxes;
}

function child(data, box, type) {
  return box && readBoxes(data, box.body, box.end).find((b) => b.type === type);
}

function path(data, box, ...types) {
  for (const type of types) box = child(data, box, type);
  return box;
}

const ENCRYPTED = new Set(['encv', 'enca', 'enct', 'encs']);

/** Tracks of an init segment: timescale, kind, raw sample entry, trex defaults. */
export function parseInit(data) {
  const moov = readBoxes(data).find((b) => b.type === 'moov');
  if (!moov) throw new UnsupportedError('no moov in init segment');
  const defaults = new Map();
  for (const trex of readBoxes(data, child(data, moov, 'mvex')?.body ?? 0, child(data, moov, 'mvex')?.end ?? 0)) {
    if (trex.type !== 'trex') continue;
    defaults.set(readU32(data, trex.body + 4), {
      duration: readU32(data, trex.body + 12),
      size: readU32(data, trex.body + 16),
      flags: readU32(data, trex.body + 20),
    });
  }

  const tracks = [];
  for (const trak of readBoxes(data, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(data, trak, 'tkhd');
    const mdhd = path(data, trak, 'mdia', 'mdhd');
    const hdlr = path(data, trak, 'mdia', 'hdlr');
    const stsd = path(data, trak, 'mdia', 'minf', 'stbl', 'stsd');
    if (!tkhd || !mdhd || !hdlr || !stsd) continue;
    const handler = readType(data, hdlr.body + 8);
    if (handler !== 'vide' && handler !== 'soun') continue;
    const entry = readBoxes(data, stsd.body + 8, stsd.end)[0];
    if (!entry) continue;
    if (ENCRYPTED.has(entry.type)) throw new UnsupportedError('encrypted (DRM) track');
    const id = readU32(data, tkhd.body + (data[tkhd.body] === 1 ? 20 : 12));
    tracks.push({
      id,
      kind: handler === 'vide' ? 'video' : 'audio',
      timescale: readU32(data, mdhd.body + (data[mdhd.body] === 1 ? 20 : 12)),
      entry: data.slice(entry.start, entry.end),
      width: readU32(data, tkhd.end - 8) >>> 16,
      height: readU32(data, tkhd.end - 4) >>> 16,
      defaults: defaults.get(id) || { duration: 0, size: 0, flags: 0 },
    });
  }
  if (!tracks.length) throw new UnsupportedError('no audio/video tracks in init segment');
  return { tracks };
}

/**
 * Samples of a media segment, per track id:
 * {baseTime, durations[], sizes[], ctos[], keys[], ranges: [{offset, size, count}]}
 */
export function parseFragment(data, init) {
  const result = new Map();
  for (const moof of readBoxes(data)) {
    if (moof.type !== 'moof') continue;
    for (const traf of readBoxes(data, moof.body, moof.end)) {
      if (traf.type !== 'traf') continue;
      const tfhd = child(data, traf, 'tfhd');
      if (!tfhd) continue;
      const flags = readU32(data, tfhd.body) & 0xffffff;
      const id = readU32(data, tfhd.body + 4);
      const track = init.tracks.find((t) => t.id === id);
      if (!track) continue;
      let p = tfhd.body + 8;
      let base = moof.start;
      if (flags & 0x1) {
        base = readU64(data, p);
        p += 8;
      }
      if (flags & 0x2) p += 4;
      const defDuration = flags & 0x8 ? readU32(data, (p += 4) - 4) : track.defaults.duration;
      const defSize = flags & 0x10 ? readU32(data, (p += 4) - 4) : track.defaults.size;
      const defFlags = flags & 0x20 ? readU32(data, (p += 4) - 4) : track.defaults.flags;

      let out = result.get(id);
      if (!out) {
        const tfdt = child(data, traf, 'tfdt');
        const baseTime = tfdt ? (data[tfdt.body] === 1 ? readU64(data, tfdt.body + 4) : readU32(data, tfdt.body + 4)) : null;
        out = { baseTime, durations: [], sizes: [], ctos: [], keys: [], ranges: [] };
        result.set(id, out);
      }

      let cursor = base;
      for (const trun of readBoxes(data, traf.body, traf.end)) {
        if (trun.type !== 'trun') continue;
        const version = data[trun.body];
        const tflags = readU32(data, trun.body) & 0xffffff;
        const count = readU32(data, trun.body + 4);
        let q = trun.body + 8;
        if (tflags & 0x1) {
          cursor = base + readI32(data, q);
          q += 4;
        }
        let firstFlags = null;
        if (tflags & 0x4) {
          firstFlags = readU32(data, q);
          q += 4;
        }
        let bytes = 0;
        for (let i = 0; i < count; i++) {
          const duration = tflags & 0x100 ? readU32(data, (q += 4) - 4) : defDuration;
          const size = tflags & 0x200 ? readU32(data, (q += 4) - 4) : defSize;
          let sampleFlags = tflags & 0x400 ? readU32(data, (q += 4) - 4) : defFlags;
          if (i === 0 && firstFlags !== null) sampleFlags = firstFlags;
          const cto = tflags & 0x800 ? (version ? readI32(data, (q += 4) - 4) : readU32(data, (q += 4) - 4)) : 0;
          out.durations.push(duration);
          out.sizes.push(size);
          out.ctos.push(cto);
          out.keys.push(!(sampleFlags & 0x10000));
          bytes += size;
        }
        if (count) out.ranges.push({ offset: cursor, size: bytes, count });
        cursor += bytes;
      }
    }
  }
  return result;
}
