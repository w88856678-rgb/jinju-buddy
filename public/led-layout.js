import { fitLedText } from './led-fit.js';

const family = '"Buddy Tencent", "腾讯体", "PingFang SC", sans-serif';
const measure = document.createElement('canvas').getContext('2d');
measure.fontKerning = 'none';
const layouts = new Map();
export const overflowHint = '超出 LED 两行，请精简或分两次发送。';
export const fontReady = document.fonts.load('700 36px "Buddy Tencent"', '现场金句，。')
  .catch(() => []).then(() => layouts.clear());

function measureLine(line, size) {
  measure.font = '700 ' + size + 'px ' + family;
  return measure.measureText(line).width;
}

export function layoutQuote(value, compact = false) {
  const text = (compact ? "small:" : "standard:") + value;
  if (!layouts.has(text)) {
    if (layouts.size >= 256) layouts.delete(layouts.keys().next().value);
    layouts.set(text, fitLedText(value, measureLine, compact));
  }
  return layouts.get(text);
}

export function stageLook(value) {
  return ['blue', 'overlay', 'overlay-light'].includes(value) ? value : 'dark';
}
