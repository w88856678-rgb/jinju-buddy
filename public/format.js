export const roles = ['待确认', '正方', '反方', '主持'];
export const maxQuote = 320;

export { quoteText } from './led-fit.js';

export function clock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}
export function speakerName(key) {
  if (!key) return '发言人待确认';
  const [group, number] = key.split(':').map(Number);
  return (group > 1 ? '收音 ' + group + ' · ' : '') + '发言人 ' + (number + 1);
}
