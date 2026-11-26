import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openSync } from 'fontkit';
import { fitLedText, quoteText } from '../public/led-fit.js';
import { config } from './config.js';

const path = join(config.fontDir || join(homedir(), 'Library', 'Fonts'), 'TencentSans-W7.otf');
const font = existsSync(path) ? openSync(path) : null;
const widths = new Map();

function measure(line, size) {
  if (!widths.has(line)) {
    if (widths.size >= 1024) widths.clear();
    // When W7 is installed only on the control computer its canvas makes the final check.
    const em = font ? font.layout(line, { kern: false }).advanceWidth / font.unitsPerEm :
      [...line].reduce((sum, char) => sum + (/^[a-z0-9 ]$/i.test(char) ? 0.65 : 1), 0);
    widths.set(line, em);
  }
  return widths.get(line) * size;
}

export function candidateLayout(text, compact = false) {
  return typeof text === 'string' && quoteText(text).length <= 320 ? fitLedText(text, measure, compact) : null;
}
export const fitsCandidate = text => Boolean(candidateLayout(text));
