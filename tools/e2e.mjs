// End-to-end check in a real Chromium browser (Vivaldi, Chromium, Edge) with a throwaway profile:
// serves a test page, lets the extension detect media, downloads everything and verifies names,
// HLS decryption and the injected Referer.
// usage: node tools/e2e.mjs <path to browser.exe>      (SHOTS=1 also saves popup screenshots)
import http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const browser = process.argv[2];
if (!browser) {
  console.error('usage: node tools/e2e.mjs <path to browser executable>');
  process.exit(2);
}
const extDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'qgrab-e2e-'));
console.log('work dir', work);
const PORT = 8765;
const DEBUG = 9333;
const profile = join(work, 'profile');
const downloads = join(work, 'downloads');
mkdirSync(join(profile, 'Default'), { recursive: true });
mkdirSync(downloads, { recursive: true });
writeFileSync(
  join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, savefile: { default_directory: downloads } }),
);

// --- test server ---
const key = randomBytes(16);
const plainSegments = [0, 1, 2].map((i) => Buffer.concat([Buffer.from([0x47]), randomBytes(188 * 50 - 1 + i)]));
const ivs = plainSegments.map((_, i) => Buffer.from(String(i).padStart(32, '0'), 'hex'));
const encSegments = plainSegments.map((p, i) => {
  const c = createCipheriv('aes-128-cbc', key, ivs[i]);
  return Buffer.concat([c.update(p), c.final()]);
});
const refererLog = [];

// Real streams for the MP4 conversion check (needs ffmpeg): fMP4 with a separate audio rendition, and MPEG-TS.
const real = join(work, 'real');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
if (hasFfmpeg) {
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12'];
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'];
  const hls = ['-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod'];
  mkdirSync(join(real, 'Sintel_Trailer'), { recursive: true });
  mkdirSync(join(real, 'Lecture_TS'), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...src, '-map', '0:v', '-map', '1:a', ...enc, ...hls, '-hls_segment_type', 'fmp4', '-master_pl_name', 'master.m3u8', '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud', '-hls_segment_filename', '%v/seg%d.m4s', '%v/index.m3u8'], { cwd: join(real, 'Sintel_Trailer') });
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...src, ...enc, ...hls, '-hls_segment_filename', 'seg%d.ts', 'index.m3u8'], { cwd: join(real, 'Lecture_TS') });
}
const MIME = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', m4s: 'video/iso.segment', mp4: 'video/mp4', m4a: 'audio/mp4' };
const big = randomBytes(700 * 1024);

const routes = {
  '/page.html': () => [
    200,
    { 'content-type': 'text/html; charset=utf-8' },
    `<!doctype html><title>Лекция 5: Введение</title>
<h1 id="headline">«Выпуск №7:
  Итоги года»</h1>
<video src="/media/d41d8cd98f00b204e9800998ecf8427e" muted></video>
<script>
fetch('/dl/get?id=7');
fetch('/files/My%20Trip%202024.mp4');
fetch('/hls/Big_Buck_Bunny/master.m3u8').then(r => r.text()).then(() => fetch('/hls/Big_Buck_Bunny/720/index.m3u8'));
fetch('/chunks/frag-1.mp4'); fetch('/chunks/frag-2.mp4'); fetch('/chunks/frag-3.mp4');
fetch('/tiny.mp4');
${hasFfmpeg ? "fetch('/real/Sintel_Trailer/master.m3u8'); fetch('/real/Lecture_TS/index.m3u8');" : ''}
</script>`,
  ],
  '/media/d41d8cd98f00b204e9800998ecf8427e': () => [200, { 'content-type': 'video/mp4' }, big],
  '/dl/get': () => [
    200,
    { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="fallback.mp4"; filename*=UTF-8''${encodeURIComponent('Тестовое видео.mp4')}` },
    big,
  ],
  '/files/My%20Trip%202024.mp4': () => [200, { 'content-type': 'video/mp4' }, big],
  '/chunks/frag-1.mp4': () => [200, { 'content-type': 'video/mp4' }, big],
  '/chunks/frag-2.mp4': () => [200, { 'content-type': 'video/mp4' }, big],
  '/chunks/frag-3.mp4': () => [200, { 'content-type': 'video/mp4' }, big],
  '/tiny.mp4': () => [200, { 'content-type': 'video/mp4' }, randomBytes(1000)],
  '/hls/Big_Buck_Bunny/master.m3u8': () => [
    200,
    { 'content-type': 'application/vnd.apple.mpegurl' },
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\n720/index.m3u8\n',
  ],
  '/hls/Big_Buck_Bunny/720/index.m3u8': () => [
    200,
    { 'content-type': 'application/vnd.apple.mpegurl' },
    '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n' +
      plainSegments.map((_, i) => `#EXT-X-KEY:METHOD=AES-128,URI="/key.bin",IV=0x${ivs[i].toString('hex')}\n#EXTINF:4.0,\nseg${i}.ts\n`).join('') +
      '#EXT-X-ENDLIST\n',
  ],
  '/hls/Big_Buck_Bunny/360/index.m3u8': () => [200, { 'content-type': 'application/vnd.apple.mpegurl' }, '#EXTM3U\n#EXTINF:4,\nx.ts\n#EXT-X-ENDLIST\n'],
  '/key.bin': (req) => (req.headers.referer?.includes('/page.html') ? [200, { 'content-type': 'application/octet-stream' }, key] : [403, {}, 'no referer']),
};
plainSegments.forEach((_, i) => {
  routes[`/hls/Big_Buck_Bunny/720/seg${i}.ts`] = () => [200, { 'content-type': 'video/mp2t' }, encSegments[i]];
});

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path.includes('seg') || path === '/key.bin') refererLog.push(`${path} <- ${req.headers.referer || '(none)'}`);
  if (path.startsWith('/real/') || path.startsWith('/downloads/')) {
    const file = join(path.startsWith('/real/') ? real : downloads, ...decodeURIComponent(path).split('/').slice(2));
    if (!existsSync(file)) return res.writeHead(404).end();
    const body = readFileSync(file);
    const type = MIME[file.split('.').pop()] || 'application/octet-stream';
    const range = /bytes=(d+)-(d*)/.exec(req.headers.range || '');
    if (!range) {
      res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'accept-ranges': 'bytes' });
      return res.end(body);
    }
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${body.length}`, 'accept-ranges': 'bytes' });
    return res.end(body.subarray(start, end + 1));
  }
  const route = routes[path];
  const [status, headers, body] = route ? route(req) : [404, {}, 'nf'];
  res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, r));

// --- browser ---
const proc = spawn(
  browser,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG}`,
    `--load-extension=${extDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
    } catch {
      await sleep(500);
    }
  }
  throw new Error('no CDP');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') console.log('PAGE EXCEPTION', JSON.stringify(m.params.exceptionDetails).slice(0, 600));
    if (m.method === 'Runtime.consoleAPICalled') console.log('PAGE CONSOLE', m.params.type, JSON.stringify(m.params.args.map(a => a.value ?? a.description)).slice(0, 400));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const ready = new Promise((r) => (ws.onopen = r));
  return {
    ready,
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const msgId = ++id;
        pending.set(msgId, resolve);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  return r.result?.result?.value;
}

let exitCode = 0;
try {
  let extId = null;
  for (let i = 0; i < 40 && !extId; i++) {
    const list = await targets();
    const sw = list.find((t) => t.url.includes('/src/background.js'));
    if (sw) extId = new URL(sw.url).host;
    else await sleep(500);
  }
  if (!extId) throw new Error('Extension service worker not found: --load-extension probably ignored');
  console.log('extension id', extId);
  await sleep(2500);

  const version = await (await fetch(`http://127.0.0.1:${DEBUG}/json/version`)).json();
  const browserWs = connect(version.webSocketDebuggerUrl);
  await browserWs.ready;
  await browserWs.send('Target.createTarget', { url: `http://localhost:${PORT}/page.html` });
  await sleep(4000);
  await browserWs.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
  await sleep(1500);

  const opt = (await targets()).find((t) => t.url.includes('/options/options.html'));
  const client = connect(opt.webSocketDebuggerUrl);
  await client.ready;

  const items = await evaluate(
    client,
    `(async () => {
      const { suggestName, makeFileName } = await import('/src/lib/filename.js');
      const [tab] = await chrome.tabs.query({ url: 'http://localhost:${PORT}/*' });
      const items = await chrome.runtime.sendMessage({ type: 'getItems', tabId: tab.id });
      return items.map((i) => { const s = suggestName(i, 'smart', i.pageTitle); return { tabId: tab.id, key: i.key, kind: i.kind, size: i.size, original: i.originalName, referer: i.referer, hls: i.hls && { variants: (i.hls.variants||[]).map(v => v.height), duration: i.hls.duration, enc: i.hls.encryption }, name: i.kind === 'file' ? makeFileName(s.base, s.ext) : s.base }; });
    })()`,
  );
  console.log('detected items:');
  for (const i of items) console.log(' ', i.kind.padEnd(4), JSON.stringify(i.name), '| original:', i.original, '| size:', i.size, i.hls ? `| hls ${JSON.stringify(i.hls)}` : '');

  // Screenshots of the popup rendered in a tab, with chrome.tabs.query pointed at the test page.
  if (process.env.SHOTS) {
    const pageTab = await evaluate(client, `chrome.tabs.query({ url: 'http://localhost:${PORT}/*' }).then(([t]) => ({ id: t.id, url: t.url, title: t.title }))`);
    const { targetId } = (await browserWs.send('Target.createTarget', { url: 'about:blank' })).result;
    await sleep(500);
    const pt = (await targets()).find((t) => t.id === targetId);
    const page = connect(pt.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 520, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `chrome.tabs.query = async () => [${JSON.stringify(pageTab)}];`,
    });
    // Text selected on the page becomes the file name.
    const pageTarget = (await targets()).find((tg) => tg.url.includes('/page.html'));
    const pageClient = connect(pageTarget.webSocketDebuggerUrl);
    await pageClient.ready;
    await evaluate(pageClient, "getSelection().selectAllChildren(document.getElementById('headline'))");
    pageClient.close();
    for (const scheme of ['light', 'dark']) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await page.send('Page.navigate', { url: `chrome-extension://${extId}/src/popup/popup.html` });
      await sleep(1500);
      console.log('DOM', await evaluate(page, 'document.getElementById("list").children.length + " items, empty hidden=" + document.getElementById("empty").hidden'));
      if (scheme === 'light') {
        const state = await evaluate(page, "({ names: [...document.querySelectorAll('.name')].map((i) => i.value), active: [...document.querySelectorAll('.chip.active')].map((c) => c.textContent) })");
        const ok = state.names.length > 0 && state.names.every((n) => n === 'Выпуск №7 - Итоги года') && state.active.every((a) => a === 'Выделение');
        if (!ok) exitCode = 1;
        console.log(ok ? 'OK  ' : 'FAIL', 'selection used as the name', JSON.stringify(state));
      }
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(work, `popup-${scheme}.png`), Buffer.from(shot.result.data, 'base64'));
    }
    page.close();
  }

  for (const i of items) {
    const r = await evaluate(
      client,
      `chrome.runtime.sendMessage({ type: 'download', tabId: ${i.tabId}, key: ${JSON.stringify(i.key)}, name: ${JSON.stringify(i.name)}, variant: 0 })`,
    );
    if (r?.error) console.log('download error', i.name, r.error);
  }
  await sleep(hasFfmpeg ? 12000 : 8000);

  const files = readdirSync(downloads);
  console.log('downloaded files:', files);
  const converted = hasFfmpeg ? ['Sintel_Trailer.mp4', 'Lecture_TS.mp4'] : [];
  const expected = ['Лекция 5 - Введение.mp4', 'Тестовое видео.mp4', 'My Trip 2024.mp4', 'Big_Buck_Bunny.ts', ...converted];
  for (const name of expected) {
    const ok = files.includes(name);
    if (!ok) exitCode = 1;
    console.log(ok ? 'OK  ' : 'FAIL', name);
  }
  const unexpected = items.filter((i) => /frag-|tiny/.test(i.key));
  console.log(unexpected.length ? 'FAIL chunks/tiny files listed' : 'OK   chunks and tiny files hidden');
  if (unexpected.length) exitCode = 1;
  if (files.includes('Big_Buck_Bunny.ts')) {
    const same = readFileSync(join(downloads, 'Big_Buck_Bunny.ts')).equals(Buffer.concat(plainSegments));
    console.log(same ? 'OK   HLS decrypted content matches' : 'FAIL HLS content differs');
    if (!same) exitCode = 1;
  }
  for (const name of converted.filter((n) => files.includes(n))) {
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', join(downloads, name)]));
    const codecs = info.streams.map((st) => st.codec_name).sort().join('+');
    const decodeErrors = spawnSync('ffmpeg', ['-v', 'error', '-i', join(downloads, name), '-f', 'null', '-']).stderr.toString().trim();
    // Playback in the browser itself.
    const pageTarget = (await targets()).find((tg) => tg.url.includes('/page.html'));
    await browserWs.send('Target.activateTarget', { targetId: pageTarget.id });
    const pageClient = connect(pageTarget.webSocketDebuggerUrl);
    await pageClient.ready;
    const playback = await evaluate(pageClient, `new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true;
      v.onerror = () => resolve({ error: v.error && v.error.message });
      v.onloadedmetadata = () => { v.currentTime = 6; };
      v.onseeked = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight, audio: v.mozHasAudio ?? (v.webkitAudioDecodedByteCount !== undefined) });
      v.src = '/downloads/' + encodeURIComponent(${JSON.stringify(name)});
      setTimeout(() => resolve({ error: 'timeout', readyState: v.readyState, networkState: v.networkState }), 10000);
    })`);
    pageClient.close();
    const ok = codecs === 'aac+h264' && Math.abs(Number(info.format.duration) - 12) < 0.3 && !decodeErrors && !playback.error && Math.abs(playback.duration - 12) < 0.3 && playback.width === 640;
    if (!ok) exitCode = 1;
    console.log(ok ? 'OK  ' : 'FAIL', name, '→', codecs, Number(info.format.duration).toFixed(2) + 's', 'browser:', JSON.stringify(playback), decodeErrors ? 'decode errors: ' + decodeErrors : '');
  }
  console.log('referer log:', refererLog);
  client.close();
  browserWs.close();
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  proc.kill();
  server.close();
  setTimeout(() => process.exit(exitCode), 500);
}
