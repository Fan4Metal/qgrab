// HLS → MP4 remuxing checked against ffmpeg: real streams are generated, remuxed with the
// extension's code, then probed and fully decoded. Skipped when ffmpeg is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parsePlaylist } from '../src/lib/hls.js';
import { createRemuxer } from '../src/lib/mp4/remux.js';
import { buildMp4 } from '../src/lib/mp4/muxer.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const dir = hasFfmpeg ? mkdtempSync(join(tmpdir(), 'qgrab-remux-')) : '';
const SRC = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12'];
const VENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-bf', '2', '-pix_fmt', 'yuv420p'];
const AENC = ['-c:a', 'aac', '-b:a', '96k'];

function ffmpeg(args, cwd) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { cwd });
}

function load(url) {
  return readFileSync(fileURLToPath(url));
}

/** The downloader's pipeline without the network: playlist → segments → remuxer → MP4 file. */
async function remuxPlaylist(playlistPath) {
  const url = pathToFileURL(playlistPath).href;
  const playlist = parsePlaylist(load(url).toString(), url);
  const map = playlist.segments[0].map;
  const init = map ? load(map.url) : null;
  let remuxer = null;
  // Out-of-order processing, as with parallel downloads.
  const order = playlist.segments.map((_, i) => i).reverse();
  for (const i of order) {
    const buffer = load(playlist.segments[i].url);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
    remuxer ||= createRemuxer(arrayBuffer, init && init.buffer.slice(init.byteOffset, init.byteOffset + init.length));
    remuxer.process(i, arrayBuffer, new Blob([arrayBuffer]));
  }
  return remuxer.tracks();
}

async function writeMp4(tracks, name) {
  const { blob, ext } = buildMp4(tracks);
  const file = join(dir, `${name}.${ext}`);
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  return file;
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,start_time,duration,nb_frames:format=duration', '-of', 'json', file]);
  return JSON.parse(out);
}

function decodeErrors(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  return r.stderr.toString().trim();
}

test('MPEG-TS (H.264 + AAC, B-frames) → MP4', { skip: !hasFfmpeg && 'ffmpeg not found' }, async () => {
  mkdirSync(join(dir, 'ts'));
  ffmpeg([...SRC, ...VENC, ...AENC, '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'ts/seg%d.ts', 'ts/index.m3u8'], dir);
  const file = await writeMp4(await remuxPlaylist(join(dir, 'ts', 'index.m3u8')), 'ts');
  const info = probe(file);
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assert.equal(Number(video.nb_frames), 300);
  assert.equal(audio.codec_name, 'aac');
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.2, `duration ${info.format.duration}`);
  assert.ok(Math.abs(Number(video.start_time) - Number(audio.start_time)) < 0.1, 'audio/video aligned');
  assert.equal(decodeErrors(file), '');
});

test('MPEG-TS with the 33-bit timestamp wrapping mid-stream', { skip: !hasFfmpeg && 'ffmpeg not found' }, async () => {
  mkdirSync(join(dir, 'wrap'));
  // 2^33 / 90 kHz ≈ 95443.7 s: timestamps wrap around 4 s into the stream.
  ffmpeg([...SRC, ...VENC, ...AENC, '-output_ts_offset', '95440', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'wrap/seg%d.ts', 'wrap/index.m3u8'], dir);
  const file = await writeMp4(await remuxPlaylist(join(dir, 'wrap', 'index.m3u8')), 'wrap');
  const info = probe(file);
  assert.equal(Number(info.streams.find((s) => s.codec_type === 'video').nb_frames), 300);
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.2, `duration ${info.format.duration}`);
  assert.equal(decodeErrors(file), '');
});

test('fMP4 video + separate fMP4 audio rendition → one MP4', { skip: !hasFfmpeg && 'ffmpeg not found' }, async () => {
  mkdirSync(join(dir, 'fmp4'));
  ffmpeg(
    [...SRC, '-map', '0:v', '-map', '1:a', ...VENC, ...AENC, '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-master_pl_name', 'master.m3u8', '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud', '-hls_segment_filename', 'fmp4/%v/seg%d.m4s', 'fmp4/%v/index.m3u8'],
    dir,
  );
  const tracks = [...(await remuxPlaylist(join(dir, 'fmp4', '0', 'index.m3u8'))), ...(await remuxPlaylist(join(dir, 'fmp4', '1', 'index.m3u8')))];
  const file = await writeMp4(tracks, 'fmp4');
  const info = probe(file);
  assert.deepEqual(info.streams.map((s) => s.codec_name).sort(), ['aac', 'h264']);
  assert.equal(Number(info.streams.find((s) => s.codec_type === 'video').nb_frames), 300);
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.2, `duration ${info.format.duration}`);
  assert.equal(decodeErrors(file), '');
});

test('raw ADTS segments → M4A', { skip: !hasFfmpeg && 'ffmpeg not found' }, async () => {
  mkdirSync(join(dir, 'aac'));
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '12', ...AENC, '-f', 'segment', '-segment_time', '4', '-segment_format', 'adts', '-segment_list', 'aac/index.m3u8', 'aac/seg%d.aac'], dir);
  const file = await writeMp4(await remuxPlaylist(join(dir, 'aac', 'index.m3u8')), 'aac');
  assert.ok(file.endsWith('.m4a'));
  const info = probe(file);
  assert.equal(info.streams.length, 1);
  assert.equal(info.streams[0].codec_name, 'aac');
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.2, `duration ${info.format.duration}`);
  assert.equal(decodeErrors(file), '');
});
