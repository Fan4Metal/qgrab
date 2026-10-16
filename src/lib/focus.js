// Links a <video> on the page to detected items: the requests made by the player's frame
// (Resource Timing) are matched against each item's own URLs and segment directories.

export function stripUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return '';
  }
}

/** Directory of a URL (`https://cdn/v/1080/`), or '' for the site root, which would match everything. */
export function dirOf(url) {
  const s = stripUrl(url);
  const dir = s.slice(0, s.lastIndexOf('/') + 1);
  try {
    return new URL(dir).pathname === '/' ? '' : dir;
  } catch {
    return '';
  }
}

export function uniqueDirs(urls, limit = 8) {
  return [...new Set(urls.map(dirOf).filter(Boolean))].slice(0, limit);
}

function relatedOf(item) {
  const info = item.hls || item.dash || {};
  return {
    urls: new Set([item.url, ...(info.related || [])].map(stripUrl).filter(Boolean)),
    prefixes: (info.prefixes || []).filter(Boolean),
  };
}

/**
 * Items whose requests appear among the frame's resources.
 * @param resources [{url, time}] requests of the player's frame
 * @param src the video's own http(s) source, if any
 * @returns {Map<string, number>} item key → time of the latest matching request
 */
export function matchItems(items, resources, src = '') {
  const matches = new Map();
  const srcKey = stripUrl(src);
  const stripped = resources.map((r) => ({ url: stripUrl(r.url), time: r.time }));
  for (const item of items) {
    const { urls, prefixes } = relatedOf(item);
    let last = srcKey && urls.has(srcKey) ? Number.MAX_SAFE_INTEGER : 0;
    for (const r of stripped) {
      if (r.time > last && (urls.has(r.url) || prefixes.some((p) => r.url.startsWith(p)))) last = r.time;
    }
    if (last) matches.set(item.key, last);
  }
  return matches;
}

/** The video the user is watching: playing beats paused, larger beats smaller; untouched videos are ignored. */
export function mainVideo(frames) {
  let best = null;
  for (const frame of frames) {
    for (const video of frame.videos || []) {
      const weight = video.playing ? 2 : video.currentTime > 0 ? 1 : 0;
      const score = weight * video.area;
      if (score > 0 && (!best || score > best.score)) best = { score, frame, video };
    }
  }
  return best;
}
