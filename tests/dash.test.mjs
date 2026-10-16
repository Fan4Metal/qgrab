import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fillTemplate, parseDuration, parseMpd, pickAudio, problemOf, representationPlaylist, usable } from '../src/lib/dash.js';
import { createRemuxer } from '../src/lib/mp4/remux.js';
import { buildMp4 } from '../src/lib/mp4/muxer.js';

test('durations and templates', () => {
  assert.equal(parseDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseDuration('PT0.5S'), 0.5);
  assert.equal(parseDuration('P1DT1S'), 86401);
  assert.equal(fillTemplate('v_$RepresentationID$/$Number%05d$_$Time$.m4s$$', { RepresentationID: 'a1', Number: 7, Time: 900 }), 'v_a1/00007_900.m4s$');
});

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <BaseURL>https://cdn.example/movie/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Time$.m4s" startNumber="1">
        <SegmentTimeline><S t="0" d="4000" r="-1"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="720" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f"/>
      <Representation id="1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentList timescale="1" duration="5">
          <Initialization sourceURL="audio.mp4" range="0-799"/>
          <SegmentURL media="audio.mp4" mediaRange="800-1799"/>
          <SegmentURL media="audio.mp4" mediaRange="1800-2799"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="drm" bandwidth="1" height="2160"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test('MPD: representations, timeline with r=-1, segment lists, DRM', async () => {
  const mpd = parseMpd(MPD, 'https://site.example/watch/manifest.mpd');
  assert.equal(problemOf(mpd), '');
  assert.deepEqual(usable(mpd.video).map((r) => r.id), ['1080', '720']);
  assert.equal(mpd.video[0].id, 'drm');
  assert.equal(pickAudio(mpd).id, 'a128');

  const video = await representationPlaylist(usable(mpd.video)[0]);
  assert.equal(video.segments.length, 3);
  assert.equal(video.segments[2].url, 'https://cdn.example/movie/1080/8000.m4s');
  assert.equal(video.segments[0].map.url, 'https://cdn.example/movie/1080/init.mp4');

  const audio = await representationPlaylist(pickAudio(mpd));
  assert.deepEqual(audio.segments.map((s) => s.range), [{ offset: 800, length: 1000 }, { offset: 1800, length: 1000 }]);
  assert.deepEqual(audio.segments[0].map.range, { offset: 0, length: 800 });

  assert.equal(problemOf(parseMpd(MPD.replace('type="static"', 'type="dynamic"'), 'https://x/')), 'live');
});

// --- Real manifests from ffmpeg ---

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const dir = hasFfmpeg ? mkdtempSync(join(tmpdir(), 'qgrab-dash-')) : '';
const SRC = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12'];
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'];

function read(url, range) {
  const data = readFileSync(fileURLToPath(url));
  const part = range ? data.subarray(range.offset, range.offset + range.length) : data;
  return part.buffer.slice(part.byteOffset, part.byteOffset + part.length);
}

/** The downloader's DASH path without the network. */
async function downloadMpd(file) {
  const url = pathToFileURL(file).href;
  const mpd = parseMpd(readFileSync(file, 'utf8'), url);
  assert.equal(problemOf(mpd), '');
  const tracks = [];
  for (const rep of [usable(mpd.video)[0], pickAudio(mpd)].filter(Boolean)) {
    const playlist = await representationPlaylist(rep, async (u, range) => read(u, range));
    const map = playlist.segments[0].map;
    const remuxer = createRemuxer(null, read(map.url, map.range));
    playlist.segments.forEach((s, i) => {
      const data = read(s.url, s.range);
      remuxer.process(i, data, new Blob([data]));
    });
    tracks.push(...remuxer.tracks());
  }
  const { blob } = buildMp4(tracks);
  const out = file.replace(/\.mpd$/, '.out.mp4');
  writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  return out;
}

function check(file) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,nb_frames:format=duration', '-of', 'json', file]));
  assert.deepEqual(info.streams.map((s) => s.codec_name).sort(), ['aac', 'h264']);
  assert.equal(Number(info.streams.find((s) => s.codec_name === 'h264').nb_frames), 300);
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.2, `duration ${info.format.duration}`);
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']).stderr.toString().trim(), '');
}

for (const [name, args] of [
  ['timeline', ['-use_template', '1', '-use_timeline', '1']],
  ['numbered', ['-use_template', '1', '-use_timeline', '0']],
  ['single-file', ['-single_file', '1']],
]) {
  test(`ffmpeg DASH (${name}) → MP4`, { skip: !hasFfmpeg && 'ffmpeg not found' }, async () => {
    const sub = join(dir, name);
    mkdirSync(sub);
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...SRC, '-map', '0:v', '-map', '1:a', ...ENC, '-f', 'dash', '-seg_duration', '4', ...args, 'manifest.mpd'], { cwd: sub });
    check(await downloadMpd(join(sub, 'manifest.mpd')));
  });
}

test('SegmentBase with sidx → MP4', { skip: !hasFfmpeg && 'ffmpeg not found' }, async () => {
  const sub = join(dir, 'segmentbase');
  mkdirSync(sub);
  // One fragmented MP4 per track with a global sidx, described by a hand-written SegmentBase manifest.
  const frag = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof+global_sidx', '-frag_duration', '4000000'];
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...SRC, '-map', '0:v', ...ENC, ...frag, 'video.mp4'], { cwd: sub });
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...SRC, '-map', '1:a', ...ENC, ...frag, 'audio.mp4'], { cwd: sub });
  const ranges = (file) => {
    const data = readFileSync(join(sub, file));
    let p = 0;
    let moovEnd = 0;
    while (p < data.length) {
      const size = data.readUInt32BE(p);
      const type = data.toString('latin1', p + 4, p + 8);
      if (type === 'moov') moovEnd = p + size;
      if (type === 'sidx') return { init: `0-${moovEnd - 1}`, index: `${p}-${p + size - 1}` };
      p += size;
    }
    throw new Error('no sidx');
  };
  const v = ranges('video.mp4');
  const a = ranges('audio.mp4');
  writeFileSync(
    join(sub, 'manifest.mpd'),
    `<MPD type="static" mediaPresentationDuration="PT12S"><Period>
<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1" width="640" height="360"><BaseURL>video.mp4</BaseURL>
<SegmentBase indexRange="${v.index}"><Initialization range="${v.init}"/></SegmentBase></Representation></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1"><BaseURL>audio.mp4</BaseURL>
<SegmentBase indexRange="${a.index}"><Initialization range="${a.init}"/></SegmentBase></Representation></AdaptationSet>
</Period></MPD>`,
  );
  check(await downloadMpd(join(sub, 'manifest.mpd')));
});
