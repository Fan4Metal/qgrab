// Many CDNs refuse requests without the page's Referer. Extension requests have none, and
// fetch()/chrome.downloads cannot set it, so it is injected with session DNR rules.

const TAB_RULE_BASE = 1_000_000;

function hostRuleId(host) {
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 1 + (h % 900_000);
}

function cleanReferer(referer) {
  try {
    const u = new URL(referer);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

/** Referer for requests to the URL's host made outside of tabs: service worker fetch and chrome.downloads. */
export async function setHostReferer(url, referer) {
  const ref = cleanReferer(referer);
  if (!ref) return;
  const host = new URL(url).hostname;
  const id = hostRuleId(host);
  await chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Referer', operation: 'set', value: ref.href }],
          },
          condition: {
            requestDomains: [host],
            tabIds: [chrome.tabs.TAB_ID_NONE],
            resourceTypes: ['xmlhttprequest', 'media', 'other'],
          },
        },
      ],
    })
    .catch((e) => console.warn('Referer rule failed', e));
}

/** Referer and Origin for every fetch made by an extension page in the given tab (the stream downloader). */
export async function setTabReferer(tabId, referer) {
  const ref = cleanReferer(referer);
  if (!ref) return;
  const id = TAB_RULE_BASE + tabId;
  await chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Referer', operation: 'set', value: ref.href },
              { header: 'Origin', operation: 'set', value: ref.origin },
            ],
          },
          condition: { tabIds: [tabId], resourceTypes: ['xmlhttprequest'] },
        },
      ],
    })
    .catch((e) => console.warn('Referer rule failed', e));
}

export function clearTabReferer(tabId) {
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [TAB_RULE_BASE + tabId] }).catch(() => {});
}
