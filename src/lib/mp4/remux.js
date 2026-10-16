// Collects HLS segments (processed in any order) and turns them into MP4 tracks.

import { UnsupportedError } from './bytes.js';
import { avc1Entry } from './h264.js';
import { FRAME_SAMPLES, mp4aEntry } from './aac.js';
import { demuxAac, demuxTs, isAdts, isTs } from './ts.js';
import { parseFragment, parseInit } from './fmp4.js';

const TS_CLOCK = 90000;
const WRAP = 2 ** 33;

function unwrapper() {
  let last = null;
  return (v) => {
    if (last !== null) {
      while (v - last > WRAP / 2) v -= WRAP;
      while (last - v > WRAP / 2) v += WRAP;
    }
    last = v;
    return v;
  };
}

function median(values) {
  const sorted = values.slice(0, 2000).sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Frame durations from decode times; gaps and jumps (discontinuities) get the typical duration. */
function durationsFrom(dts) {
  const deltas = [];
  for (let i = 1; i < dts.length; i++) deltas.push(dts[i] - dts[i - 1]);
  const typical = median(deltas.filter((d) => d > 0)) || 3000;
  const out = deltas.map((d) => (d > 0 && d <= typical * 10 ? d : typical));
  out.push(typical);
  return out;
}

/** MPEG-TS segments (H.264 + AAC) or raw ADTS segments. */
class TsRemuxer {
  constructor(adts) {
    this.adts = adts;
    this.segments = [];
    this.params = {};
  }

  process(index, buffer) {
    const data = new Uint8Array(buffer);
    const r = this.adts ? demuxAac(data) : demuxTs(data, this.params);
    const segment = {};
    if (r.video?.sizes.length) {
      if (r.video.sps && r.video.pps && !this.params.sps) this.params = { sps: r.video.sps, pps: r.video.pps };
      const { dts, pts, keys, sizes } = r.video;
      segment.video = { dts, pts, keys, sizes, blob: new Blob([r.video.data]) };
    }
    if (r.audio?.sizes.length) {
      this.audioConfig ||= r.audio.config;
      segment.audio = { pts: r.audio.pts, sizes: r.audio.sizes, blob: new Blob([r.audio.data]) };
    }
    this.segments[index] = segment;
  }

  tracks() {
    const segments = this.segments.filter(Boolean);
    const tracks = [];

    const video = segments.filter((s) => s.video).map((s) => s.video);
    if (video.length) {
      if (!this.params.sps) throw new UnsupportedError('H.264 stream without SPS/PPS');
      const { entry, width, height } = avc1Entry(this.params.sps, this.params.pps);
      const unwrap = unwrapper();
      const dts = [];
      const ctos = [];
      const keys = [];
      const sizes = [];
      const chunks = [];
      for (const v of video) {
        const first = dts.length;
        v.dts.forEach((d, i) => {
          const time = unwrap(d);
          let cto = v.pts[i] - d;
          if (cto < -WRAP / 2) cto += WRAP;
          if (cto > WRAP / 2) cto -= WRAP;
          dts.push(time);
          ctos.push(Math.max(0, cto));
        });
        keys.push(...v.keys);
        sizes.push(...v.sizes);
        chunks.push({ blob: v.blob, samples: v.sizes.length, time: (dts[first] + ctos[first]) / TS_CLOCK });
      }
      tracks.push({
        kind: 'video',
        timescale: TS_CLOCK,
        entry,
        width,
        height,
        sizes,
        durations: durationsFrom(dts),
        ctos,
        keys,
        chunks,
        start: (dts[0] + ctos[0]) / TS_CLOCK,
      });
    }

    const audio = segments.filter((s) => s.audio).map((s) => s.audio);
    if (audio.length) {
      const { entry, sampleRate } = mp4aEntry(this.audioConfig);
      const unwrap = unwrapper();
      const sizes = [];
      const chunks = [];
      let position = 0; // in samples, used when segments carry no timestamps
      let start = null;
      for (const a of audio) {
        const time = a.pts != null ? unwrap(a.pts) / TS_CLOCK : null;
        start ??= time;
        sizes.push(...a.sizes);
        chunks.push({ blob: a.blob, samples: a.sizes.length, time: time ?? (start ?? 0) + position / sampleRate });
        position += a.sizes.length * FRAME_SAMPLES;
      }
      tracks.push({
        kind: 'audio',
        timescale: sampleRate,
        entry,
        sizes,
        durations: new Array(sizes.length).fill(FRAME_SAMPLES),
        ctos: null,
        keys: null,
        chunks,
        start: start ?? tracks[0]?.start ?? 0,
      });
    }
    return tracks;
  }
}

/** Fragmented MP4 segments; the sample entries of the init segment are copied as they are. */
class Fmp4Remuxer {
  constructor(initBuffer) {
    this.init = parseInit(new Uint8Array(initBuffer));
    this.segments = [];
  }

  process(index, buffer, blob) {
    const fragments = parseFragment(new Uint8Array(buffer), this.init);
    if (!fragments.size) throw new Error('Segment contains no fragments');
    this.segments[index] = { fragments, blob };
  }

  tracks() {
    const segments = this.segments.filter(Boolean);
    return this.init.tracks
      .map((track) => {
        const out = {
          kind: track.kind,
          timescale: track.timescale,
          entry: track.entry,
          width: track.width,
          height: track.height,
          sizes: [],
          durations: [],
          ctos: [],
          keys: [],
          chunks: [],
          start: 0,
        };
        let firstTime = null;
        let position = 0;
        for (const segment of segments) {
          const f = segment.fragments.get(track.id);
          if (!f) continue;
          const time = f.baseTime ?? position;
          if (firstTime === null) {
            firstTime = time;
            out.start = (time + Math.max(0, f.ctos[0] ?? 0)) / track.timescale;
          }
          out.sizes.push(...f.sizes);
          out.durations.push(...f.durations);
          out.ctos.push(...f.ctos);
          out.keys.push(...f.keys);
          let t = time;
          let sample = 0;
          for (const range of f.ranges) {
            out.chunks.push({ blob: segment.blob.slice(range.offset, range.offset + range.size), samples: range.count, time: t / track.timescale });
            for (let i = 0; i < range.count; i++) t += f.durations[sample++];
          }
          position = time + f.durations.reduce((a, b) => a + b, 0);
        }
        if (track.kind === 'audio') {
          out.keys = null;
          if (!out.ctos.some((c) => c !== 0)) out.ctos = null;
        }
        return out;
      })
      .filter((t) => t.sizes.length);
  }
}

/**
 * Picks a remuxer for a playlist from its first segment.
 * Throws UnsupportedError when the stream cannot be converted (the caller keeps the original container).
 */
export function createRemuxer(firstSegment, initBuffer) {
  if (initBuffer) return new Fmp4Remuxer(initBuffer);
  const data = new Uint8Array(firstSegment);
  if (isTs(data)) return new TsRemuxer(false);
  if (isAdts(data)) return new TsRemuxer(true);
  throw new UnsupportedError('unknown segment format');
}

export { UnsupportedError };
