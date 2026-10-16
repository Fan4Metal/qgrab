import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirOf, mainVideo, matchItems } from '../src/lib/focus.js';
import { isIgnoredUrl } from '../src/lib/media.js';

test('directories never fall back to the site root', () => {
  assert.equal(dirOf('https://cdn.example/v/1080/seg-1.ts?token=1'), 'https://cdn.example/v/1080/');
  assert.equal(dirOf('https://cdn.example/seg-1.ts'), '');
});

const items = [
  { key: 'file', url: 'https://cdn.example/files/movie.mp4' },
  {
    key: 'hls-main',
    url: 'https://cdn.example/hls/main/master.m3u8',
    hls: { related: ['https://cdn.example/hls/main/720/index.m3u8'], prefixes: ['https://cdn.example/hls/main/720/'] },
  },
  {
    key: 'hls-ad',
    url: 'https://ads.example/ad/master.m3u8',
    hls: { related: [], prefixes: ['https://ads.example/ad/v/'] },
  },
  { key: 'dash', url: 'https://cdn.example/dash/manifest.mpd', dash: { prefixes: ['https://cdn.example/dash/'] } },
];

test('items are matched by their URLs, sub-playlists and segment directories', () => {
  const resources = [
    { url: 'https://cdn.example/hls/main/master.m3u8', time: 100 },
    { url: 'https://cdn.example/hls/main/720/seg-41.ts?sig=abc', time: 500 },
    { url: 'https://cdn.example/other/thing.json', time: 600 },
  ];
  assert.deepEqual([...matchItems(items, resources)], [['hls-main', 500]]);
  assert.deepEqual([...matchItems(items, [], 'https://cdn.example/files/movie.mp4?x=1').keys()], ['file']);
  assert.deepEqual([...matchItems(items, [{ url: 'https://cdn.example/dash/chunk-1-00004.m4s', time: 1 }]).keys()], ['dash']);
});

test('the main video is the largest one being watched', () => {
  const frames = [
    { id: 'top', videos: [{ area: 300 * 170, playing: true, currentTime: 3 }, { area: 1280 * 720, playing: false, currentTime: 0 }] },
    { id: 'player', videos: [{ area: 960 * 540, playing: false, currentTime: 120 }] },
  ];
  assert.equal(mainVideo(frames).frame.id, 'player');
  frames[1].videos[0].area = 100;
  assert.equal(mainVideo(frames).frame.id, 'top');
  assert.equal(mainVideo([{ videos: [{ area: 1000, playing: false, currentTime: 0 }] }]), null);
});

test('video ad servers are ignored', () => {
  assert.equal(isIgnoredUrl('https://s0.2mdn.net/videoplayback/abc/file.mp4'), true);
  assert.equal(isIgnoredUrl('https://ads.adfox.ru/123/getCode?p=1'), true);
  assert.equal(isIgnoredUrl('https://cdn.example/video.mp4'), false);
});
