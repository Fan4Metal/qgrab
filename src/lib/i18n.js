export const t = (key) => chrome.i18n.getMessage(key) || key;

export const locale = chrome.i18n.getUILanguage();

export function applyI18n(root = document) {
  document.documentElement.lang = locale;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}
