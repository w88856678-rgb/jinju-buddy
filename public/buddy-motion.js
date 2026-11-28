import { film } from './buddy-frames.js';
import { idleFrame, quotePose, waveActive } from './show-timing.js';
import { serverNow } from './ui.js';

export function createBuddyMotion(host, greetingCanvas, enabled, reducedMotion, painter) {
  function actor(className) {
    const canvas = document.createElement('canvas');
    canvas.className = className;
    canvas.width = canvas.height = film.cell;
    canvas.setAttribute('aria-hidden', 'true');
    host.append(canvas);
    return canvas.getContext('2d');
  }
  const idle = actor('idle-pose'), thought = actor('quote-pose');
  const frame = greetingCanvas.parentElement;
  const greeting = film.greeting, greetingSheets = new Map();
  const sheetCount = Math.ceil(greeting.x.length / greeting.perPage);
  const greet = greetingCanvas.getContext('2d');
  greetingCanvas.width = greetingCanvas.height = greeting.cell;
  greetingCanvas.style.width = greetingCanvas.style.height = greeting.cell / greeting.scale + 'px';
  greetingCanvas.style.top = greeting.top / greeting.scale + 'px';
  let warmed = false, warming = false, warmRetry, markReady;
  const greetingReady = new Promise(resolve => { markReady = resolve; });
  const pages = new Map();
  const playPages = Math.ceil(film.playFrames / film.perPage);
  let screen = { kind: 'idle' }, raf;
  let lastGreeting = -1, awaitingWave;
  host.dataset.motion = 'still';

  function wake() {
    if (!raf && !document.hidden && screen.kind !== 'qr' && enabled) raf = requestAnimationFrame(paint);
  }
  function load(key, cache = pages) {
    let entry = cache.get(key);
    if (entry && (!entry.retryAt || performance.now() < entry.retryAt)) return entry;
    const image = new Image();
    entry = { image, ready: false };
    cache.set(key, entry);
    image.src = '/static/assets/buddy-' + key + '.webp?v=' + (cache === greetingSheets ? greeting.version : 'flower-1');
    entry.decoded = image.decode().then(async () => {
      if (cache === greetingSheets && typeof createImageBitmap === 'function') {
        // Keep the decoded pixels resident across a long standby. The image
        // remains usable on browsers that cannot create a bitmap from WebP.
        try { entry.image = await createImageBitmap(image); } catch {}
      }
      entry.ready = true;
      if (cache.get(key) === entry) wake();
    }).catch(() => { entry.retryAt = performance.now() + 5000; });
    return entry;
  }
  function finishWave(displayed) {
    awaitingWave?.(displayed);
    awaitingWave = undefined;
  }
  // Decode off the playback path. Two small sheets at a time leave bandwidth
  // for the live scene and keep the whole greeting available for repeat clicks.
  async function warmGreeting() {
    if (!enabled || !greet || warmed || warming || document.hidden) return;
    clearTimeout(warmRetry);
    warming = true;
    async function decodeLane(start) {
      for (let i = start; i < sheetCount; i += 2) await load('hello-' + i, greetingSheets).decoded;
    }
    await Promise.all([decodeLane(0), decodeLane(1)]);
    warming = false;
    if ([...greetingSheets.values()].every(entry => entry.ready)) {
      warmed = true;
      markReady();
      wake();
    } else {
      warmRetry = setTimeout(warmGreeting, 5200);
    }
  }
  function drawGreeting(cue, now) {
    const elapsed = now - cue.startsAt;
    if (!warmed || elapsed < -140) return false;
    const index = Math.max(0, Math.floor(elapsed / film.frameMs));
    const page = Math.floor(index / greeting.perPage);
    painter.draw(greet, 'hello', index, greetingSheets.get('hello-' + page).image);
    if (lastGreeting !== index) {
      greetingCanvas.style.transform = 'translateX(' + greeting.x[index] / greeting.scale + 'px)';
      lastGreeting = index;
    }
    frame.toggleAttribute('data-greeting-visible', true);
    if (elapsed < 0) return false;
    // Decode the standby landing pose before the last step of the return walk.
    if (index >= greeting.x.length - 25) load('play-0');
    if (host.dataset.motion !== 'wave') host.dataset.motion = 'wave';
    finishWave(true);
    return true;
  }
  function paint() {
    raf = undefined;
    if (document.hidden || screen.kind === 'qr') return;
    const now = serverNow(), cue = screen.buddyCue;
    const waving = screen.kind === 'idle' && waveActive(cue, now);
    if (waving && drawGreeting(cue, now)) {
      wake();
      return;
    }
    if (!waving) {
      frame.toggleAttribute('data-greeting-visible', false);
      if (awaitingWave) finishWave(false);
    }
    if (reducedMotion.matches || !idle || !thought) {
      host.removeAttribute('data-ready');
      host.removeAttribute('data-performing');
      host.dataset.motion = 'still';
      if (waving) wake();
      return;
    }
    const index = idleFrame(cue, now);
    const page = Math.floor(index / film.perPage);
    const current = 'play-' + page, next = 'play-' + (page + 1) % playPages;
    const entry = load(current), performanceSheet = load('film-2x');
    load(next);
    for (const name of pages.keys())
      if (name !== current && name !== next && name !== 'film-2x') pages.delete(name);
    const pose = quotePose(screen, now);
    const performing = !!pose && painter.draw(thought, 'film', pose.frame, performanceSheet.ready && performanceSheet.image);
    if (painter.draw(idle, 'play', index, entry.ready && entry.image)) {
      host.setAttribute('data-ready', '');
    }
    host.toggleAttribute('data-performing', performing);
    host.dataset.motion = performing ? pose.clip : host.hasAttribute('data-ready') ? 'play' : 'still';
    wake();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      frame.removeAttribute('data-greeting-visible');
      if (host.dataset.motion === 'wave') host.dataset.motion = 'still';
    } else {
      warmGreeting();
      wake();
    }
  });
  requestAnimationFrame(warmGreeting);
  window.addEventListener('online', warmGreeting);
  reducedMotion.addEventListener('change', wake);
  window.addEventListener('buddy-clock', wake);
  return {
    greetingReady,
    playingGreeting: () => host.dataset.motion === 'wave' && frame.hasAttribute('data-greeting-visible'),
    show(next) {
      finishWave(false);
      screen = next;
      if (screen.kind === 'quote') painter.warm('film', 79);
      const waving = enabled && screen.kind === 'idle' && waveActive(screen.buddyCue, serverNow());
      if (!waving) frame.removeAttribute('data-greeting-visible');
      if (screen.kind === 'qr') {
        cancelAnimationFrame(raf);
        raf = undefined;
        host.removeAttribute('data-performing');
        host.dataset.motion = 'still';
        return;
      }
      wake();
      if (waving) return new Promise(resolve => { awaitingWave = resolve; });
    },
  };
}
