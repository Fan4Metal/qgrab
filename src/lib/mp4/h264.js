// H.264: Annex B parsing, SPS dimensions, avc1 sample entry.

import { BitReader, Writer } from './bytes.js';

export const NAL = { IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9 };

/** NAL units of an Annex B byte stream (start codes removed, trailing zero bytes stripped). */
export function splitAnnexB(data) {
  const nals = [];
  const n = data.length;
  let start = -1;
  const push = (s, e) => {
    while (e > s && data[e - 1] === 0) e--;
    if (e > s) nals.push(data.subarray(s, e));
  };
  let i = 0;
  while (i + 2 < n) {
    if (data[i + 2] > 1) {
      i += 3;
    } else if (data[i + 2] === 1 && data[i + 1] === 0 && data[i] === 0) {
      if (start >= 0) push(start, i);
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0) push(start, n);
  return nals;
}

/** Removes emulation prevention bytes (00 00 03 → 00 00). */
export function unescapeRbsp(nal) {
  const out = new Uint8Array(nal.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r, size) {
  let last = 8;
  let next = 8;
  for (let i = 0; i < size; i++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Picture size from a sequence parameter set NAL unit. */
export function parseSps(nal) {
  const r = new BitReader(unescapeRbsp(nal));
  r.bits(8); // NAL header
  const profile = r.bits(8);
  r.bits(16); // constraint flags, level
  r.ue(); // seq_parameter_set_id
  let chroma = 1;
  if (HIGH_PROFILES.has(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.bit();
    r.ue(); // bit_depth_luma
    r.ue(); // bit_depth_chroma
    r.bit(); // qpprime_y_zero_transform_bypass
    if (r.bit()) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
  }
  r.ue(); // log2_max_frame_num
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue();
  } else if (pocType === 1) {
    r.bit();
    r.se();
    r.se();
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_allowed
  const widthMbs = r.ue() + 1;
  const heightUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit(); // direct_8x8_inference
  let crop = [0, 0, 0, 0];
  if (r.bit()) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  const subWidth = chroma === 1 || chroma === 2 ? 2 : 1;
  const subHeight = chroma === 1 ? 2 : 1;
  const cropX = chroma === 0 ? 1 : subWidth;
  const cropY = (chroma === 0 ? 1 : subHeight) * (2 - frameMbsOnly);
  return {
    width: widthMbs * 16 - (crop[0] + crop[1]) * cropX,
    height: (2 - frameMbsOnly) * heightUnits * 16 - (crop[2] + crop[3]) * cropY,
  };
}

export function avc1Entry(sps, pps) {
  const { width, height } = parseSps(sps);
  const entry = new Writer(256)
    .box('avc1', (w) => {
      w.zeros(6).u16(1); // reserved, data_reference_index
      w.zeros(16); // pre_defined, reserved
      w.u16(width).u16(height);
      w.u32(0x00480000).u32(0x00480000).u32(0); // 72 dpi, reserved
      w.u16(1).zeros(32).u16(0x18).u16(0xffff); // frame_count, compressorname, depth, pre_defined
      w.box('avcC', (c) => {
        c.u8(1).u8(sps[1]).u8(sps[2]).u8(sps[3]).u8(0xff);
        c.u8(0xe1).u16(sps.length).bytes(sps);
        c.u8(1).u16(pps.length).bytes(pps);
      });
    })
    .result();
  return { entry, width, height };
}
