import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMedia, parseAttributes, parsePlaylist } from '../src/lib/hls.js';

test('attribute lists with quoted commas', () => {
  assert.deepEqual(parseAttributes('BANDWIDTH=800000,CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=640x360'), {
    BANDWIDTH: '800000',
    CODECS: 'avc1.4d401e,mp4a.40.2',
    RESOLUTION: '640x360',
  });
});

test('master playlist: variants sorted, audio groups, referenced URIs', () => {
  const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="aud"
1080/index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframes.m3u8"
`;
  const pl = parsePlaylist(text, 'https://cdn.example/v/master.m3u8');
  assert.equal(pl.type, 'master');
  assert.equal(pl.variants.length, 2);
  assert.equal(pl.variants[0].url, 'https://cdn.example/v/1080/index.m3u8');
  assert.equal(pl.variants[0].bandwidth, 4000000);
  assert.equal(pl.variants[0].height, 1080);
  assert.equal(pl.variants[0].audioUrl, 'https://cdn.example/v/audio/en.m3u8');
  assert.ok(pl.uris.includes('https://cdn.example/v/subs/en.m3u8'));
  assert.ok(pl.uris.includes('https://cdn.example/v/iframes.m3u8'));
});

test('media playlist: keys, IVs, map, byte ranges, gaps', () => {
  const text = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001
#EXTINF:10.0,
#EXT-X-BYTERANGE:1000@720
media.mp4
#EXTINF:9.5,
#EXT-X-BYTERANGE:2000
media.mp4
#EXT-X-KEY:METHOD=NONE
#EXT-X-GAP
#EXTINF:5,
missing.mp4
#EXT-X-ENDLIST
`;
  const pl = parsePlaylist(text, 'https://cdn.example/v/1080/index.m3u8');
  assert.equal(pl.type, 'media');
  assert.equal(pl.segments.length, 2);
  assert.equal(pl.duration, 24.5);
  assert.equal(pl.endList, true);
  assert.deepEqual(pl.segments[0].range, { length: 1000, offset: 720 });
  assert.deepEqual(pl.segments[1].range, { length: 2000, offset: 1720 });
  assert.equal(pl.segments[0].seq, 7);
  assert.equal(pl.segments[0].key.url, 'https://cdn.example/v/1080/key.bin');
  assert.equal(pl.segments[0].map.url, 'https://cdn.example/v/1080/init.mp4');
  assert.deepEqual(describeMedia(pl), { duration: 24.5, live: false, fmp4: true, segments: 2, encryption: 'AES-128' });
});

test('DRM key formats are flagged', () => {
  const text = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4,
a.ts
`;
  const pl = parsePlaylist(text, 'https://x.example/a.m3u8');
  assert.equal(pl.drm, true);
  assert.equal(describeMedia(pl).encryption, 'DRM');
  assert.equal(describeMedia(pl).live, true);
});

test('rejects non-playlists', () => {
  assert.throws(() => parsePlaylist('<html>', 'https://x.example/a.m3u8'));
});
