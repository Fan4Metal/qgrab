// AAC: ADTS frame parsing and the mp4a sample entry.

import { Writer } from './bytes.js';

export const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
export const FRAME_SAMPLES = 1024;

/**
 * Splits an ADTS stream into raw AAC frames.
 * @returns {{config: {objectType, rateIndex, channels} | null, frames: Uint8Array[]}}
 */
export function parseAdts(data) {
  const frames = [];
  let config = null;
  let i = 0;
  while (i + 7 <= data.length) {
    if (data[i] !== 0xff || (data[i + 1] & 0xf6) !== 0xf0) {
      i++;
      continue;
    }
    const headerLength = data[i + 1] & 1 ? 7 : 9;
    const rateIndex = (data[i + 2] >> 2) & 0x0f;
    const length = ((data[i + 3] & 3) << 11) | (data[i + 4] << 3) | (data[i + 5] >> 5);
    if (rateIndex >= SAMPLE_RATES.length || length < headerLength) {
      i++;
      continue;
    }
    if (i + length > data.length) break; // Truncated last frame.
    config ||= {
      objectType: ((data[i + 2] >> 6) & 3) + 1,
      rateIndex,
      channels: ((data[i + 2] & 1) << 2) | (data[i + 3] >> 6),
    };
    frames.push(data.subarray(i + headerLength, i + length));
    i += length;
  }
  return { config, frames };
}

function descriptor(w, tag, fill) {
  const inner = new Writer(64);
  fill(inner);
  const body = inner.result();
  w.u8(tag).u8(body.length).bytes(body);
}

export function mp4aEntry(config) {
  const rate = SAMPLE_RATES[config.rateIndex];
  const channels = config.channels || 2;
  const asc = [(config.objectType << 3) | (config.rateIndex >> 1), ((config.rateIndex & 1) << 7) | (channels << 3)];
  const entry = new Writer(128)
    .box('mp4a', (w) => {
      w.zeros(6).u16(1); // reserved, data_reference_index
      w.zeros(8); // reserved
      w.u16(channels).u16(16).u16(0).u16(0);
      w.u32(Math.min(rate, 0xffff) * 0x10000);
      w.fullBox('esds', 0, 0, (e) => {
        descriptor(e, 0x03, (es) => {
          es.u16(0).u8(0); // ES_ID, flags
          descriptor(es, 0x04, (dc) => {
            dc.u8(0x40).u8(0x15).u24(0).u32(0).u32(0); // AAC, audio stream, buffer, bitrates
            descriptor(dc, 0x05, (dsi) => dsi.bytes(asc));
          });
          descriptor(es, 0x06, (sl) => sl.u8(0x02));
        });
      });
    })
    .result();
  return { entry, sampleRate: rate };
}
