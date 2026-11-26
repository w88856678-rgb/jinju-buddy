import { film } from './buddy-frames.js';

export const quoteDuration = 10000;
export const fadeDuration = 200;
export const quoteRollDuration = 180;
export const waveDuration = film.waveFrames * film.frameMs;

// Use the filmed head dip, then the original upward sweep of the red flower.
export const thinkingFrames = [36, 38, 40, 42, 44, 46, 48, 79];
const retract = [97, 95, 93, 91, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80, 79];
const lift = Array.from({ length: 20 }, (_, i) => 80 + i);
const gesture = [...thinkingFrames, ...lift, ...Array(7).fill(99), ...retract];

export function quoteDeadline(screen) {
  return screen.kind === 'quote' ? (Number(screen.publishedAt) || 0) + quoteDuration : null;
}

export function quoteRollAt(screen) {
  return Math.max(screen.publishedAt, (screen.quoteRunAt ?? screen.publishedAt) + thinkingFrames.length * film.frameMs);
}

export function quotePose(screen, now) {
  if (screen?.kind !== 'quote' || now >= quoteDeadline(screen)) return null;
  const index = Math.max(0, Math.floor((now - (screen.quoteRunAt ?? screen.publishedAt)) / film.frameMs));
  if (index < gesture.length)
    return { clip: index < thinkingFrames.length ? 'thinking' : 'reveal', frame: gesture[index] };
  // Continue the original back-and-forth listening performance from its lowered pose.
  const phase = (index - gesture.length) % 158;
  return { clip: 'listening', frame: Math.abs(79 - phase) };
}

export function waveActive(cue, now) {
  return Number.isFinite(cue?.startsAt) && now < cue.startsAt + waveDuration;
}
function playOrigin(cue, now) {
  if (Number.isFinite(cue?.startsAt) && now >= cue.startsAt + waveDuration)
    return cue.startsAt + waveDuration;
  return cue?.playOrigin ?? 0;
}
export function idleFrame(cue, now) {
  const frame = Math.floor((now - playOrigin(cue, now)) / film.frameMs);
  return ((frame % film.playFrames) + film.playFrames) % film.playFrames;
}
export function planWave(previous, now) {
  // Both screens preload the original film and start it on the same server timestamp.
  return { playOrigin: playOrigin(previous, now), startsAt: now + 200 };
}
