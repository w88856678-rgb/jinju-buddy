import { film } from './buddy-frames.js';
import { idleFrame, quotePose, waveActive } from './show-timing.js';
import { serverNow } from './ui.js';

export function createBuddyMotion(host, movie, enabled, reducedMotion) {
  function actor(className) {
    const canvas = document.createElement('canvas');
    canvas.className = className;
    canvas.width = canvas.height = film.cell;
    canvas.setAttribute('aria-hidden', 'true');
    host.append(canvas);
    return canvas.getContext('2d');
  }
  const idle = actor('idle-pose'), thought = actor('quote-pose');
  const frame = movie.parentElement;
  const pages = new Map();
  const playPages = Math.ceil(film.playFrames / film.perPage);
  let screen = { kind: 'idle' }, raf, lastIdle, lastThought;
  let movieCue, playPending = false, retryAfter = 0, awaitingWave;
  host.dataset.motion = 'still';

  function wake() {
    if (!raf && !document.hidden && screen.kind !== 'qr' && enabled) raf = requestAnimationFrame(paint);
  }
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
  function finishWave(displayed) {
    awaitingWave?.(displayed);
    awaitingWave = undefined;
  }
  function stopMovie() {
    if (movieCue !== undefined || !movie.paused) movie.pause();
    if (!frame.hasAttribute('data-greeting') && movieCue === undefined) return;
    movieCue = undefined;
    retryAfter = 0;
    frame.removeAttribute('data-greeting');
    frame.removeAttribute('data-movie-visible');
  }
  function syncMovie(startsAt, elapsed) {
    if (movie.readyState < HTMLMediaElement.HAVE_METADATA) return false;
    const fresh = movieCue !== startsAt;
    if (fresh) {
      movieCue = startsAt;
      retryAfter = 0;
    }
    // Correct on entry, reconnect or a real stall. Normal playback stays at 1×.
    if (!movie.seeking && Math.abs(movie.currentTime - elapsed) > (fresh ? .08 : .25))
      movie.currentTime = elapsed;
    if (!movie.ended && movie.paused && !playPending && performance.now() >= retryAfter) {
      playPending = true;
      movie.play().catch(() => { retryAfter = performance.now() + 700; })
        .finally(() => { playPending = false; });
    }
    const visible = !movie.seeking && !movie.paused &&
      movie.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && Math.abs(movie.currentTime - elapsed) < .25;
    if (visible) {
      frame.setAttribute('data-movie-visible', '');
      host.dataset.motion = 'wave';
      finishWave(true);
    }
    return frame.hasAttribute('data-movie-visible');
  }
  function paint() {
    raf = undefined;
    if (document.hidden || screen.kind === 'qr') return;
    const now = serverNow(), cue = screen.buddyCue;
    const waving = screen.kind === 'idle' && waveActive(cue, now);
    if (waving) {
      frame.setAttribute('data-greeting', '');
      if (now >= cue.startsAt && syncMovie(cue.startsAt, (now - cue.startsAt) / 1000)) {
        wake();
        return;
      }
    } else {
      stopMovie();
      if (awaitingWave) finishWave(false);
    }
    if (reducedMotion.matches || !idle || !thought) {
      host.removeAttribute('data-ready');
      host.removeAttribute('data-performing');
      host.dataset.motion = 'still';
      lastIdle = lastThought = undefined;
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
    if (entry.ready && lastIdle !== index) {
      const slot = index % film.perPage, cell = film.cell;
      idle.clearRect(0, 0, cell, cell);
      idle.drawImage(entry.image, slot % film.columns * cell, Math.floor(slot / film.columns) * cell,
        cell, cell, 0, 0, cell, cell);
      lastIdle = index;
      host.setAttribute('data-ready', '');
    }
    const pose = quotePose(screen, now);
    const performing = !!pose && performanceSheet.ready;
    if (performing && lastThought !== pose.frame) {
      const image = performanceSheet.image;
      const w = image.naturalWidth / 10, h = image.naturalHeight / 10;
      thought.clearRect(0, 0, film.cell, film.cell);
      thought.drawImage(image, pose.frame % 10 * w, Math.floor(pose.frame / 10) * h, w, h, 10, 28, 204, 184);
      lastThought = pose.frame;
    }
    if (!performing) lastThought = undefined;
    host.toggleAttribute('data-performing', performing);
    host.dataset.motion = performing ? pose.clip : host.hasAttribute('data-ready') ? 'play' : 'still';
    wake();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      movie.pause();
      frame.removeAttribute('data-movie-visible');
    } else wake();
  });
  reducedMotion.addEventListener('change', wake);
  window.addEventListener('buddy-clock', wake);
  return {
    show(next) {
      finishWave(false);
      screen = next;
      const waving = enabled && screen.kind === 'idle' && waveActive(screen.buddyCue, serverNow());
      if (!waving) stopMovie();
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
