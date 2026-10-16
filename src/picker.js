// "Point at the video" mode, injected into every frame by the popup. Each frame outlines its own
// <video> elements; a click sends the frame's requests to the service worker, which keeps the
// matching items on top of the list. Esc or the Cancel button stops the mode in all frames.
(() => {
  globalThis.__qgrabStopPicker?.();

  const t = (key) => chrome.i18n.getMessage(key) || key;
  const isTop = window === window.top;
  const host = document.createElement('qgrab-picker');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { all: initial; }
    .box { position: fixed; z-index: 2147483647; box-sizing: border-box; border: 3px solid #6366f1; border-radius: 6px;
      background: rgba(99, 102, 241, 0.18); cursor: pointer; display: grid; place-items: center; }
    .box:hover { background: rgba(99, 102, 241, 0.35); }
    .label, .banner, .toast { font: 600 14px/1.3 system-ui, 'Segoe UI', sans-serif; color: #fff; background: #4f46e5;
      border-radius: 8px; padding: 8px 14px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); }
    .banner { position: fixed; z-index: 2147483647; top: 12px; left: 50%; transform: translateX(-50%);
      display: flex; gap: 12px; align-items: center; }
    .banner button { font: inherit; color: #4f46e5; background: #fff; border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
    .toast { position: fixed; z-index: 2147483647; bottom: 24px; left: 50%; transform: translateX(-50%); }
  </style>`;

  const boxes = [];
  for (const video of document.querySelectorAll('video')) {
    const box = document.createElement('div');
    box.className = 'box';
    box.innerHTML = '<span class="label"></span>';
    box.firstChild.textContent = `⬇ ${t('pickThis')}`;
    box.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pick(video);
    });
    root.append(box);
    boxes.push({ video, box });
  }

  if (isTop) {
    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.innerHTML = '<span></span><button type="button"></button>';
    banner.firstChild.textContent = t('pickBanner');
    banner.lastChild.textContent = t('btnCancel');
    banner.lastChild.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stopPicker' }).catch(stop));
    root.append(banner);
  }

  if (!boxes.length && !isTop) return;
  document.documentElement.append(host);

  let frame = 0;
  const place = () => {
    for (const { video, box } of boxes) {
      const r = video.getBoundingClientRect();
      const visible = r.width > 20 && r.height > 20 && getComputedStyle(video).visibility !== 'hidden';
      box.style.display = visible ? 'grid' : 'none';
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }
    frame = requestAnimationFrame(place);
  };
  place();

  const onKey = (e) => {
    if (e.key === 'Escape') chrome.runtime.sendMessage({ type: 'stopPicker' }).catch(stop);
  };
  document.addEventListener('keydown', onKey, true);

  function stop() {
    cancelAnimationFrame(frame);
    document.removeEventListener('keydown', onKey, true);
    host.remove();
    if (globalThis.__qgrabStopPicker === stop) delete globalThis.__qgrabStopPicker;
  }
  globalThis.__qgrabStopPicker = stop;

  function toast(text) {
    const toastHost = document.createElement('qgrab-picker');
    const shadow = toastHost.attachShadow({ mode: 'closed' });
    shadow.append(root.querySelector('style').cloneNode(true));
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    shadow.append(el);
    document.documentElement.append(toastHost);
    setTimeout(() => toastHost.remove(), 3500);
  }

  async function pick(video) {
    const resources = globalThis.__qgrabResources ||
      performance.getEntriesByType('resource').map((e) => ({ url: e.name, time: performance.timeOrigin + e.startTime }));
    const src = /^https?:/i.test(video.currentSrc) ? video.currentSrc : '';
    stop();
    try {
      const { count } = await chrome.runtime.sendMessage({ type: 'picked', resources, src });
      toast(count ? t('pickDone') : t('pickNothing'));
    } catch {
      toast(t('pickNothing'));
    }
  }
})();
