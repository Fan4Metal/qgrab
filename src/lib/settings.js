export const DEFAULTS = {
  naming: 'smart', // 'smart' | 'original' | 'title' | 'titleOriginal'
  subfolder: '',
  saveAs: false,
  minSizeKB: 500,
  concurrency: 6,
  autoClose: true,
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

export function saveSettings(patch) {
  return chrome.storage.sync.set(patch);
}
