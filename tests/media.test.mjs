import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, isIgnoredUrl, patternKey } from '../src/lib/media.js';

test('classification by MIME type, extension and Content-Disposition', () => {
  assert.deepEqual(classify({ url: 'https://x.example/a.mp4', mime: 'video/mp4' }), { kind: 'file', ext: 'mp4' });
  assert.deepEqual(classify({ url: 'https://x.example/stream?id=1', mime: 'video/webm; codecs=vp9' }), { kind: 'file', ext: 'webm' });
  assert.deepEqual(classify({ url: 'https://x.example/a.mkv', mime: 'application/octet-stream' }), { kind: 'file', ext: 'mkv' });
  assert.deepEqual(classify({ url: 'https://x.example/dl?id=1', mime: 'application/octet-stream', fileName: 'Film.avi' }), { kind: 'file', ext: 'avi' });
  assert.deepEqual(classify({ url: 'https://x.example/master.m3u8', mime: 'text/plain' }), { kind: 'hls', ext: '' });
  assert.deepEqual(classify({ url: 'https://x.example/live', mime: 'application/vnd.apple.mpegurl' }), { kind: 'hls', ext: '' });
  assert.deepEqual(classify({ url: 'https://x.example/a.mpd', mime: '' }), { kind: 'dash', ext: '' });
  assert.equal(classify({ url: 'https://x.example/seg-1.ts', mime: 'video/mp2t' }).kind, 'segment');
  assert.equal(classify({ url: 'https://x.example/chunk-1.m4s', mime: 'video/mp4' }).kind, 'segment');
  assert.equal(classify({ url: 'https://x.example/page.html', mime: 'text/html' }), null);
  assert.equal(classify({ url: 'https://x.example/a.mp4', mime: 'text/html' }), null);
});

test('chunk patterns and ignored hosts', () => {
  assert.equal(patternKey('https://x.example/v/seg-12.mp4?t=5'), patternKey('https://x.example/v/seg-13.mp4?t=6'));
  assert.equal(patternKey('https://x.example/v/movie.mp4'), '');
  assert.equal(isIgnoredUrl('https://rr1---sn-abc.googlevideo.com/videoplayback?x=1'), true);
  assert.equal(isIgnoredUrl('https://example.com/a.mp4'), false);
});
