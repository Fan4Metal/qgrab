// MPEG-TS demuxer for HLS segments: H.264 video and ADTS AAC audio.

import { concat, UnsupportedError } from './bytes.js';
import { NAL, splitAnnexB } from './h264.js';
import { parseAdts } from './aac.js';

const PACKET = 188;
const VIDEO = { 0x1b: 'h264', 0x24: 'HEVC', 0x02: 'MPEG-2 video', 0x10: 'MPEG-4 video', 0x01: 'MPEG-1 video' };
const AUDIO = { 0x0f: 'aac', 0x03: 'MP3', 0x04: 'MP3', 0x11: 'AAC-LATM', 0x81: 'AC-3', 0x87: 'E-AC-3' };

export function isTs(data) {
  return data.length >= PACKET && data[0] === 0x47 && (data.length < PACKET * 2 || data[PACKET] === 0x47);
}

function readTimestamp(d, i) {
  return (d[i] & 0x0e) * 536870912 + d[i + 1] * 4194304 + (d[i + 2] & 0xfe) * 16384 + d[i + 3] * 128 + (d[i + 4] >> 1);
}

function parsePes(data) {
  if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return null;
  const flags = data[7];
  let pts = null;
  let dts = null;
  if (flags & 0x80) {
    pts = readTimestamp(data, 9);
    dts = flags & 0x40 ? readTimestamp(data, 14) : pts;
  }
  return { pts, dts, payload: data.subarray(9 + data[8]) };
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param data one segment
 * @param params SPS/PPS already stored in the sample entry: identical in-band copies are dropped
 * @returns {{video?: {sps, pps, dts[], pts[], keys[], sizes[], data}, audio?: {config, pts, sizes[], data}}}
 */
export function demuxTs(data, params = {}) {
  let p = 0;
  while (p < data.length && !(data[p] === 0x47 && (p + PACKET >= data.length || data[p + PACKET] === 0x47))) p++;

  let pmtPid = -1;
  let videoPid = -1;
  let audioPid = -1;
  let unsupportedVideo = '';
  let unsupportedAudio = '';
  const pending = new Map();
  const packets = { video: [], audio: [] };

  const flush = (pid) => {
    const parts = pending.get(pid);
    pending.delete(pid);
    if (!parts?.length) return;
    const pes = parsePes(concat(parts));
    if (pes) (pid === videoPid ? packets.video : packets.audio).push(pes);
  };

  for (; p + PACKET <= data.length; p += PACKET) {
    if (data[p] !== 0x47) {
      // Lost sync: find the next packet start.
      let q = p + 1;
      while (q < data.length && data[q] !== 0x47) q++;
      p = q - PACKET;
      continue;
    }
    const pusi = data[p + 1] & 0x40;
    const pid = ((data[p + 1] & 0x1f) << 8) | data[p + 2];
    const afc = (data[p + 3] >> 4) & 3;
    if (afc === 0 || afc === 2) continue;
    let offset = p + 4;
    if (afc === 3) offset += data[offset] + 1;
    if (offset >= p + PACKET) continue;
    const payload = data.subarray(offset, p + PACKET);

    if (pid === 0 && pusi && pmtPid < 0) {
      const t = 1 + payload[0];
      const end = Math.min(payload.length, t + 3 + (((payload[t + 1] & 0x0f) << 8) | payload[t + 2]) - 4);
      for (let i = t + 8; i + 4 <= end; i += 4) {
        if ((payload[i] << 8) | payload[i + 1]) {
          pmtPid = ((payload[i + 2] & 0x1f) << 8) | payload[i + 3];
          break;
        }
      }
    } else if (pid === pmtPid && pusi && videoPid < 0 && audioPid < 0) {
      const t = 1 + payload[0];
      const end = Math.min(payload.length, t + 3 + (((payload[t + 1] & 0x0f) << 8) | payload[t + 2]) - 4);
      let i = t + 12 + (((payload[t + 10] & 0x0f) << 8) | payload[t + 11]);
      while (i + 5 <= end) {
        const type = payload[i];
        const esPid = ((payload[i + 1] & 0x1f) << 8) | payload[i + 2];
        if (type === 0x1b && videoPid < 0) videoPid = esPid;
        else if (type === 0x0f && audioPid < 0) audioPid = esPid;
        else if (VIDEO[type]) unsupportedVideo ||= VIDEO[type];
        else if (AUDIO[type]) unsupportedAudio ||= AUDIO[type];
        i += 5 + (((payload[i + 3] & 0x0f) << 8) | payload[i + 4]);
      }
      if (videoPid < 0 && unsupportedVideo) throw new UnsupportedError(unsupportedVideo);
      if (audioPid < 0 && unsupportedAudio) throw new UnsupportedError(unsupportedAudio);
    } else if (pid === videoPid || pid === audioPid) {
      if (pusi) {
        flush(pid);
        pending.set(pid, []);
      }
      pending.get(pid)?.push(payload);
    }
  }
  flush(videoPid);
  flush(audioPid);

  if (videoPid < 0 && audioPid < 0) throw new UnsupportedError('no H.264/AAC streams');
  return {
    video: packets.video.length ? buildVideo(packets.video, params) : null,
    audio: packets.audio.length ? buildAudio(packets.audio) : null,
  };
}

function buildVideo(pesList, params) {
  // One access unit per PES; a PES without timestamps continues the previous one.
  const units = [];
  for (const pes of pesList) {
    const nals = splitAnnexB(pes.payload);
    if (pes.pts == null && units.length) units[units.length - 1].nals.push(...nals);
    else if (pes.pts != null) units.push({ pts: pes.pts, dts: pes.dts, nals });
  }

  let sps = null;
  let pps = null;
  const out = { sps: null, pps: null, dts: [], pts: [], keys: [], sizes: [], data: null };
  const parts = [];
  let total = 0;
  for (const unit of units) {
    let size = 0;
    let key = false;
    const kept = [];
    for (const nal of unit.nals) {
      const type = nal[0] & 0x1f;
      if (type === NAL.AUD) continue;
      if (type === NAL.SPS) {
        sps ||= nal.slice();
        if (sameBytes(nal, params.sps || sps)) continue;
      } else if (type === NAL.PPS) {
        pps ||= nal.slice();
        if (sameBytes(nal, params.pps || pps)) continue;
      } else if (type === NAL.IDR) {
        key = true;
      }
      kept.push(nal);
      size += 4 + nal.length;
    }
    if (!size) continue;
    for (const nal of kept) {
      const len = new Uint8Array([nal.length >>> 24, (nal.length >>> 16) & 0xff, (nal.length >>> 8) & 0xff, nal.length & 0xff]);
      parts.push(len, nal);
    }
    total += size;
    out.dts.push(unit.dts);
    out.pts.push(unit.pts);
    out.keys.push(key);
    out.sizes.push(size);
  }
  out.sps = sps;
  out.pps = pps;
  out.data = concat(parts, total);
  return out;
}

function buildAudio(pesList) {
  // ADTS frames may straddle PES boundaries: parse the concatenated stream.
  const first = pesList.find((pes) => pes.pts != null);
  const { config, frames } = parseAdts(concat(pesList.map((pes) => pes.payload)));
  if (!config || !frames.length) return null;
  return { config, pts: first?.pts ?? null, sizes: frames.map((f) => f.length), data: concat(frames) };
}

/** Raw ADTS segment (`.aac`), optionally prefixed by ID3 tags carrying the MPEG-TS timestamp. */
export function demuxAac(data) {
  let i = 0;
  let pts = null;
  while (i + 10 <= data.length && data[i] === 0x49 && data[i + 1] === 0x44 && data[i + 2] === 0x33) {
    const size = ((data[i + 6] & 0x7f) << 21) | ((data[i + 7] & 0x7f) << 14) | ((data[i + 8] & 0x7f) << 7) | (data[i + 9] & 0x7f);
    const end = Math.min(data.length, i + 10 + size);
    for (let f = i + 10; f + 10 <= end; ) {
      const id = String.fromCharCode(data[f], data[f + 1], data[f + 2], data[f + 3]);
      const frameSize = (data[f + 4] << 24) | (data[f + 5] << 16) | (data[f + 6] << 8) | data[f + 7];
      if (!/^[A-Z0-9]{4}$/.test(id) || frameSize <= 0) break;
      const body = data.subarray(f + 10, f + 10 + frameSize);
      if (id === 'PRIV') {
        const zero = body.indexOf(0);
        const owner = String.fromCharCode(...body.subarray(0, zero));
        if (owner === 'com.apple.streaming.transportStreamTimestamp' && body.length >= zero + 9) {
          const ts = body.subarray(zero + 1);
          pts = (ts[3] & 1) * 2 ** 32 + (((ts[4] << 24) | (ts[5] << 16) | (ts[6] << 8) | ts[7]) >>> 0);
        }
      }
      f += 10 + frameSize;
    }
    i = end;
  }
  const { config, frames } = parseAdts(data.subarray(i));
  if (!config || !frames.length) throw new UnsupportedError('no AAC frames');
  return { video: null, audio: { config, pts, sizes: frames.map((f) => f.length), data: concat(frames) } };
}

export function isAdts(data) {
  return (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) || (data[0] === 0xff && (data[1] & 0xf6) === 0xf0);
}
