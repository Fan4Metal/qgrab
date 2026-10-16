import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dirNameFromUrl,
  isGenericName,
  joinPath,
  cleanSelection,
  makeFileName,
  nameCandidates,
  nameFromUrl,
  parseContentDisposition,
  sanitizeName,
  suggestName,
} from '../src/lib/filename.js';

test('Content-Disposition: plain, quoted, RFC 5987, mojibake', () => {
  assert.equal(parseContentDisposition('attachment; filename="My Clip.mp4"'), 'My Clip.mp4');
  assert.equal(parseContentDisposition('attachment; filename=clip.mp4'), 'clip.mp4');
  assert.equal(
    parseContentDisposition(`attachment; filename="fallback.mp4"; filename*=UTF-8''%D0%A4%D0%B8%D0%BB%D1%8C%D0%BC.mp4`),
    'Фильм.mp4',
  );
  const utf8AsLatin1 = String.fromCharCode(...new TextEncoder().encode('Видео.mp4'));
  assert.equal(parseContentDisposition(`attachment; filename="${utf8AsLatin1}"`), 'Видео.mp4');
  assert.equal(parseContentDisposition('attachment; filename="a%20b.mp4"'), 'a b.mp4');
  assert.equal(parseContentDisposition('attachment; filename="../../etc/x.mp4"'), 'x.mp4');
  assert.equal(parseContentDisposition('inline'), '');
  assert.equal(parseContentDisposition(''), '');
});

test('name from URL: path, signed-URL disposition, query parameters', () => {
  assert.equal(nameFromUrl('https://cdn.example/v/My%20Trip%202024.mp4?token=abc'), 'My Trip 2024.mp4');
  assert.equal(
    nameFromUrl(
      'https://bucket.s3.amazonaws.com/abc?response-content-disposition=attachment%3B%20filename%3D%22Lecture%201.mp4%22',
    ),
    'Lecture 1.mp4',
  );
  assert.equal(nameFromUrl('https://x.example/get?id=5&filename=Concert.webm'), 'Concert.webm');
  assert.equal(nameFromUrl('https://x.example/stream/index.m3u8'), 'index.m3u8');
  assert.equal(nameFromUrl('https://x.example/play?download=1'), 'play');
});

test('generic names', () => {
  for (const name of ['index', 'master.m3u8', 'playlist', 'chunklist_w123_b800000', '1080p', '720p_2000k', 'video', '123456', 'd41d8cd98f00b204e9800998ecf8427e', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'aZ3kL9qX2Rt5Mn8B']) {
    assert.equal(isGenericName(name), true, name);
  }
  for (const name of ['My Trip 2024', 'Big_Buck_Bunny', 'lecture5_part2', 'video_of_my_cat', 'MyVideoFile2023Final', 'Фильм']) {
    assert.equal(isGenericName(name), false, name);
  }
});

test('meaningful parent directory for manifests', () => {
  assert.equal(dirNameFromUrl('https://cdn.example/movies/Big_Buck_Bunny/hls/1080p/index.m3u8'), 'Big_Buck_Bunny');
  assert.equal(dirNameFromUrl('https://cdn.example/hls/d41d8cd98f00b204e9800998ecf8427e/index.m3u8'), '');
});

test('sanitizing for Windows and chrome.downloads', () => {
  assert.equal(sanitizeName('Video: Part 1 | Final'), 'Video - Part 1 - Final');
  assert.equal(sanitizeName('a/b\\c'), 'a-b-c');
  assert.equal(sanitizeName('What? "Really" <yes>*'), "What 'Really' yes");
  assert.equal(sanitizeName('  ..hidden.  '), 'hidden');
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeName('a\u0000b‮c'), 'abc');
  assert.equal(Array.from(sanitizeName('я'.repeat(400))).length, 150);
  assert.equal(makeFileName('', 'MP4'), 'video.mp4');
  assert.equal(joinPath('Videos/../Clips', 'a.mp4'), 'Videos/Clips/a.mp4');
  assert.equal(joinPath('', 'a.mp4'), 'a.mp4');
});

test('suggested names', () => {
  const file = { kind: 'file', url: 'https://cdn.example/v/My%20Trip.mp4', originalName: 'My Trip.mp4', ext: 'mp4' };
  assert.deepEqual(suggestName(file, 'smart', 'Holiday video - Site'), { base: 'My Trip', ext: 'mp4' });
  assert.deepEqual(suggestName(file, 'title', 'Holiday video - Site'), { base: 'Holiday video - Site', ext: 'mp4' });
  assert.deepEqual(suggestName(file, 'titleOriginal', 'Holiday'), { base: 'Holiday - My Trip', ext: 'mp4' });

  const hashed = { kind: 'file', url: 'https://cdn.example/d41d8cd98f00b204e9800998ecf8427e', originalName: 'd41d8cd98f00b204e9800998ecf8427e', ext: 'webm' };
  assert.deepEqual(suggestName(hashed, 'smart', '(3) Cool clip'), { base: 'Cool clip', ext: 'webm' });
  assert.deepEqual(suggestName(hashed, 'original', 'Cool clip'), { base: 'd41d8cd98f00b204e9800998ecf8427e', ext: 'webm' });

  const hls = { kind: 'hls', url: 'https://cdn.example/movies/Big_Buck_Bunny/master.m3u8', originalName: 'master.m3u8' };
  assert.deepEqual(suggestName(hls, 'smart', 'Watch online'), { base: 'Big_Buck_Bunny', ext: '' });
  const hlsHash = { kind: 'hls', url: 'https://cdn.example/hls/abc123def4567890abcd/index.m3u8', originalName: 'index.m3u8' };
  assert.deepEqual(suggestName(hlsHash, 'smart', 'Episode 1: Pilot'), { base: 'Episode 1 - Pilot', ext: '' });
});

test('name variants for quick switching', () => {
  const file = {
    kind: 'file',
    url: 'https://cdn.example/v/d41d8cd98f00b204e9800998ecf8427e.mp4',
    headerName: 'Лекция 5.mp4',
  };
  assert.deepEqual(nameCandidates(file, 'Курс: введение'), [
    { source: 'server', base: 'Лекция 5' },
    { source: 'link', base: 'd41d8cd98f00b204e9800998ecf8427e' },
    { source: 'title', base: 'Курс - введение' },
    { source: 'titleOriginal', base: 'Курс - введение - Лекция 5' },
  ]);

  const hls = { kind: 'hls', url: 'https://cdn.example/movies/Big_Buck_Bunny/master.m3u8', headerName: '' };
  assert.deepEqual(nameCandidates(hls, 'Big_Buck_Bunny'), [
    { source: 'link', base: 'master' },
    { source: 'folder', base: 'Big_Buck_Bunny' },
  ]);
});

test('selected text as a file name', () => {
  assert.equal(cleanSelection('  «Выпуск №7:\n   Итоги года»  \n'), 'Выпуск №7 - Итоги года');
  assert.equal(cleanSelection('"Quoted title"'), 'Quoted title');
  assert.equal(cleanSelection('a/b\tc?'), 'a-b c');
  assert.equal(cleanSelection(''), '');
  const long = cleanSelection('слово '.repeat(60));
  assert.ok(Array.from(long).length <= 120 && long.endsWith('слово'), long);

  const item = { kind: 'file', url: 'https://x.example/clip.mp4', headerName: '' };
  assert.deepEqual(nameCandidates(item, 'Page', 'Выпуск 7')[0], { source: 'selection', base: 'Выпуск 7' });
});
