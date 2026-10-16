// Reports <video>/<audio> sources of the page. Network detection in the service worker does the
// main job; this catches media served from cache or loaded before the extension started.
(() => {
  const reported = new Set();

  function scan() {
    const items = [];
    for (const el of document.querySelectorAll('video, audio, video source, audio source')) {
      const type = el.tagName === 'SOURCE' ? el.type : '';
      for (const url of [el.currentSrc, el.src]) {
        if (!url || !/^https?:/i.test(url) || reported.has(url)) continue;
        reported.add(url);
        items.push({ url, mime: type || '' });
      }
    }
    if (!items.length) return;
    try {
      chrome.runtime.sendMessage({ type: 'contentMedia', items }).catch(() => {});
    } catch {
      // Extension was reloaded: this script is orphaned.
    }
  }

  // The last non-empty selection: clicking the player to start playback clears the current one.
  // The popup reads it through chrome.scripting, which runs in this same isolated world.
  document.addEventListener('selectionchange', () => {
    const text = String(getSelection() || '').trim();
    if (text) globalThis.__qgrabLastSelection = text;
  });

  // Media events do not bubble, but they can be captured on the document.
  for (const event of ['loadedmetadata', 'play']) document.addEventListener(event, scan, true);
  scan();
})();
