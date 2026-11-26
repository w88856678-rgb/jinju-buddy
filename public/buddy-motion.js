import { film } from './buddy-frames.js';
import { buddyPose, waveActive } from './show-timing.js';
import { serverNow } from './ui.js';

export function createBuddyMotion(host, enabled, reducedMotion) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = film.cell;
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  host.append(canvas);
  const pages = new Map();
  const playPages = Math.ceil(film.playFrames / film.perPage);
  let kind = 'idle', cue, raf, shown, awaitingWave;
  host.dataset.motion = 'still';

  function load(key) {
    let entry = pages.get(key);
    if (entry && (!entry.retryAt || performance.now() < entry.retryAt)) return entry;
    const image = new Image();
    entry = { image, ready: false };
    pages.set(key, entry);
    image.src = '/static/assets/buddy-' + key + '.webp';
    image.decode().then(() => {
      entry.ready = true;
      if (pages.get(key) === entry) wake();
    }).catch(() => { entry.retryAt = performance.now() + 5000; });
    return entry;
  }
  function wake() {
    if (!raf && !document.hidden && kind !== 'qr' && enabled && ctx) raf = requestAnimationFrame(paint);
  }
  function finishWave(displayed) {
    awaitingWave?.(displayed);
    awaitingWave = undefined;
  }
  function paint() {
    raf = undefined;
    if (kind === 'qr' || document.hidden || !ctx) return;
    const now = serverNow();
    const pose = buddyPose(cue, now);
    const active = waveActive(cue, now);
    if (awaitingWave && !active) finishWave(false);
    if (reducedMotion.matches && !active) {
      host.removeAttribute('data-ready');
      host.dataset.motion = 'still';
      shown = undefined;
      return;
    }
    if (reducedMotion.matches) pose.frame = pose.clip === 'wave' ? 34 : 0;
    const page = Math.floor(pose.frame / film.perPage);
    const key = pose.clip + '-' + page;
    const entry = load(key);
    // Keep only the live page, its successor, and the on-demand greeting resident.
    const playPage = pose.clip === 'play' ? page : Math.floor(film.resumeFrame / film.perPage);
    const next = 'play-' + (playPage + 1) % playPages;
    load('wave-0');
    load('play-' + playPage);
    load(next);
    for (const name of pages.keys()) {
      if (name !== 'wave-0' && name !== 'play-' + playPage && name !== next) pages.delete(name);
    }
    const frameKey = pose.clip + ':' + pose.frame;
    if (entry.ready && shown !== frameKey) {
      const slot = pose.frame % film.perPage, cell = film.cell;
      ctx.clearRect(0, 0, cell, cell);
      ctx.drawImage(entry.image, slot % film.columns * cell, Math.floor(slot / film.columns) * cell,
        cell, cell, 0, 0, cell, cell);
      host.setAttribute('data-ready', '');
      host.dataset.motion = pose.clip;
      shown = frameKey;
    }
    if (pose.clip === 'wave' && entry.ready) finishWave(true);
    wake();
  }
  document.addEventListener('visibilitychange', wake);
  reducedMotion.addEventListener('change', wake);

  return {
    show(screen) {
      finishWave(false);
      kind = screen.kind;
      cue = screen.buddyCue;
      if (kind === 'qr') {
        cancelAnimationFrame(raf);
        raf = undefined;
        shown = undefined;
        host.dataset.motion = 'still';
        return;
      }
      wake();
      if (kind === 'idle' && waveActive(cue, serverNow()) && enabled && ctx)
        return new Promise(resolve => { awaitingWave = resolve; });
    },
  };
}
