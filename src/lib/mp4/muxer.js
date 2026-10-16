// Writes a regular (non-fragmented) MP4 with the index (moov) at the start.
// Sample data is never copied: chunks are Blobs referenced by the final Blob.

import { Writer } from './bytes.js';

const MOVIE_TIMESCALE = 1000;
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

/**
 * @typedef {object} Track
 * @property {'video'|'audio'} kind
 * @property {number} timescale
 * @property {Uint8Array} entry   sample entry box (avc1, mp4a, hvc1, …)
 * @property {number} [width]
 * @property {number} [height]
 * @property {number[]} sizes
 * @property {number[]} durations
 * @property {number[]|null} ctos   composition offsets, null when all zero
 * @property {boolean[]|null} keys  sync samples, null when all are sync samples
 * @property {{blob: Blob, samples: number, time: number}[]} chunks  time in seconds, for interleaving
 * @property {number} start        presentation start in seconds, for A/V alignment
 */

function runs(values) {
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function writeMoov(tracks, offsets) {
  const minStart = Math.min(...tracks.map((t) => t.start));
  const layout = tracks.map((t) => {
    const mediaDuration = sum(t.durations);
    const mediaStart = Math.max(0, t.ctos?.[0] ?? 0);
    const emptyMs = Math.round((t.start - minStart) * MOVIE_TIMESCALE);
    const playMs = Math.round(((mediaDuration - mediaStart) / t.timescale) * MOVIE_TIMESCALE);
    return { mediaDuration, mediaStart, emptyMs, playMs, totalMs: emptyMs + playMs };
  });

  const w = new Writer(1 << 16);
  w.box('moov', (moov) => {
    moov.fullBox('mvhd', 1, 0, (b) => {
      b.u64(0).u64(0).u32(MOVIE_TIMESCALE).u64(Math.max(...layout.map((l) => l.totalMs)));
      b.u32(0x00010000).u16(0x0100).zeros(10);
      for (const m of MATRIX) b.u32(m);
      b.zeros(24).u32(tracks.length + 1);
    });

    tracks.forEach((t, index) => {
      const l = layout[index];
      const video = t.kind === 'video';
      moov.box('trak', (trak) => {
        trak.fullBox('tkhd', 1, 3, (b) => {
          b.u64(0).u64(0).u32(index + 1).u32(0).u64(l.totalMs);
          b.zeros(8).u16(0).u16(0).u16(video ? 0 : 0x0100).u16(0);
          for (const m of MATRIX) b.u32(m);
          b.u32((video ? t.width : 0) * 0x10000).u32((video ? t.height : 0) * 0x10000);
        });
        trak.box('edts', (edts) =>
          edts.fullBox('elst', 0, 0, (b) => {
            b.u32(l.emptyMs > 0 ? 2 : 1);
            if (l.emptyMs > 0) b.u32(l.emptyMs).i32(-1).u16(1).u16(0);
            b.u32(l.playMs).i32(l.mediaStart).u16(1).u16(0);
          }),
        );
        trak.box('mdia', (mdia) => {
          mdia.fullBox('mdhd', 1, 0, (b) => b.u64(0).u64(0).u32(t.timescale).u64(l.mediaDuration).u16(0x55c4).u16(0));
          mdia.fullBox('hdlr', 0, 0, (b) => {
            b.u32(0).str(video ? 'vide' : 'soun').zeros(12);
            b.str(video ? 'VideoHandler' : 'SoundHandler').u8(0);
          });
          mdia.box('minf', (minf) => {
            if (video) minf.fullBox('vmhd', 0, 1, (b) => b.zeros(8));
            else minf.fullBox('smhd', 0, 0, (b) => b.zeros(4));
            minf.box('dinf', (dinf) =>
              dinf.fullBox('dref', 0, 0, (b) => {
                b.u32(1);
                b.fullBox('url ', 0, 1, () => {});
              }),
            );
            minf.box('stbl', (stbl) => writeSampleTables(stbl, t, offsets[index]));
          });
        });
      });
    });
  });
  return w.result();
}

function writeSampleTables(stbl, t, offsets) {
  stbl.fullBox('stsd', 0, 0, (b) => b.u32(1).bytes(t.entry));

  const stts = runs(t.durations);
  stbl.fullBox('stts', 0, 0, (b) => {
    b.u32(stts.length);
    for (const [count, delta] of stts) b.u32(count).u32(delta);
  });

  if (t.ctos?.some((c) => c !== 0)) {
    const negative = t.ctos.some((c) => c < 0);
    const ctts = runs(t.ctos);
    stbl.fullBox('ctts', negative ? 1 : 0, 0, (b) => {
      b.u32(ctts.length);
      for (const [count, offset] of ctts) b.u32(count).i32(offset);
    });
  }

  if (t.keys && t.keys.some((k) => !k)) {
    const sync = [];
    t.keys.forEach((k, i) => k && sync.push(i + 1));
    stbl.fullBox('stss', 0, 0, (b) => {
      b.u32(sync.length);
      for (const n of sync) b.u32(n);
    });
  }

  const stsc = [];
  t.chunks.forEach((chunk, i) => {
    if (stsc[stsc.length - 1]?.[1] !== chunk.samples) stsc.push([i + 1, chunk.samples]);
  });
  stbl.fullBox('stsc', 0, 0, (b) => {
    b.u32(stsc.length);
    for (const [first, samples] of stsc) b.u32(first).u32(samples).u32(1);
  });

  stbl.fullBox('stsz', 0, 0, (b) => {
    b.u32(0).u32(t.sizes.length);
    for (const s of t.sizes) b.u32(s);
  });

  stbl.fullBox('co64', 0, 0, (b) => {
    b.u32(offsets.length);
    for (const o of offsets) b.u64(o);
  });
}

/** @param {Track[]} tracks */
export function buildMp4(tracks) {
  tracks = tracks.filter((t) => t.sizes.length);
  if (!tracks.length) throw new Error('Nothing to write');
  const hasVideo = tracks.some((t) => t.kind === 'video');

  const ftyp = new Writer(64)
    .box('ftyp', (b) => {
      b.str('isom').u32(0x200);
      for (const brand of ['isom', 'iso2', 'mp41', ...(hasVideo ? ['avc1'] : [])]) b.str(brand);
    })
    .result();

  // Chunks of all tracks interleaved by time, so players read the file sequentially.
  const order = tracks
    .flatMap((t, ti) => t.chunks.map((c, ci) => ({ ti, ci, time: c.time, blob: c.blob })))
    .sort((a, b) => a.time - b.time || a.ti - b.ti);
  const dataSize = sum(order.map((o) => o.blob.size));

  const offsets = tracks.map((t) => new Array(t.chunks.length).fill(0));
  const moovSize = writeMoov(tracks, offsets).length;
  let pos = ftyp.length + moovSize + 16;
  for (const o of order) {
    offsets[o.ti][o.ci] = pos;
    pos += o.blob.size;
  }
  const moov = writeMoov(tracks, offsets);
  const mdat = new Writer(16).u32(1).str('mdat').u64(16 + dataSize).result();

  return {
    blob: new Blob([ftyp, moov, mdat, ...order.map((o) => o.blob)], { type: hasVideo ? 'video/mp4' : 'audio/mp4' }),
    ext: hasVideo ? 'mp4' : 'm4a',
  };
}
