import { t, locale } from './i18n.js';

const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '';
  const units = t('units').split(',');
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 || n >= 100 ? Math.round(n) : number.format(n)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function formatBitrate(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? `${number.format(bps / 1e6)} ${t('mbps')}` : `${Math.round(bps / 1e3)} ${t('kbps')}`;
}
