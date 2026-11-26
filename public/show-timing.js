import { film } from './buddy-frames.js';

export const quoteDuration = 10000;
export const fadeDuration = 200;
export const quoteRollDuration = 180;
export const waveDuration = film.waveFrames * film.frameMs;

export function quoteDeadline(screen) {
  return screen.kind === 'quote' ? (Number(screen.publishedAt) || 0) + quoteDuration : null;
}

export function waveActive(cue, now) {
  return Number.isFinite(cue?.startsAt) && now < cue.startsAt + waveDuration;
}

function playOrigin(cue, now) {
  if (Number.isFinite(cue?.startsAt) && now >= cue.startsAt + waveDuration)
    return cue.startsAt + waveDuration - film.resumeFrame * film.frameMs;
  return cue?.playOrigin || 0;
}

export function buddyPose(cue, now) {
  if (waveActive(cue, now) && now >= cue.startsAt)
    return { clip: 'wave', frame: Math.floor((now - cue.startsAt) / film.frameMs) };
  const elapsed = Math.floor((now - playOrigin(cue, now)) / film.frameMs);
  return { clip: 'play', frame: ((elapsed % film.playFrames) + film.playFrames) % film.playFrames };
}

export function planWave(previous, now) {
  const origin = playOrigin(previous, now);
  const lead = film.waveLead[buddyPose(previous, now).frame];
  const frameStart = origin + Math.floor((now - origin) / film.frameMs) * film.frameMs;
  return { playOrigin: origin, startsAt: Math.max(now, frameStart + lead * film.frameMs) };
}
