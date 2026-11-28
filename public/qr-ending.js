import { imageUrl, serverNow } from './ui.js';
import { ledQr } from './led-qr.js';

// In the approved 25 fps film Buddy starts the downstroke at 2 s
// and the flower reaches its lowest point on frame 54 (zero based).
const frameMs = 40, lastFrame = 124;
const revealStart = 2000, revealFull = 54 * frameMs;

export function createQrEnding(host, animate, reduce, painter) {
  const actor = host.querySelector('.led-qr-buddy');
  const summary = host.querySelector('.led-summary');
  const code = host.querySelector('.led-code');
  const context = actor.getContext('2d');
  let sheet, loading = false, active, raf;

  function paint() {
    raf = undefined;
    if (!active || document.hidden) return;
    // Joining mid-show, a late image, or a clock adjustment must never replay the landing.
    const elapsed = active.elapsed = Math.max(active.elapsed, serverNow() - active.started);
    const moving = animate && !reduce.matches;
    const frame = moving ? Math.min(lastFrame, Math.floor(elapsed / frameMs)) : lastFrame;
    if (context && painter.draw(context, 'summary', frame, sheet) && frame !== active.frame) {
      actor.dataset.frame = String(frame);
      active.frame = frame;
    }
    const progress = moving ? (elapsed - revealStart) / (revealFull - revealStart) : Number(elapsed >= revealFull);
    const opacity = active.ready ? Math.max(0, Math.min(1, progress)) : 0;
    if (opacity !== active.opacity) {
      summary.style.opacity = String(opacity);
      active.opacity = opacity;
    }
    if (opacity === 1 && active.resolve) {
      active.resolve(true);
      active.resolve = undefined;
    }
    if (elapsed < (moving ? lastFrame * frameMs : revealFull)) raf = requestAnimationFrame(paint);
  }

  function refresh() {
    cancelAnimationFrame(raf);
    paint();
  }
  async function preload() {
    if (!context || sheet || loading) return;
    loading = true;
    try {
      const image = new Image();
      image.src = '/static/assets/buddy-summary.webp';
      await image.decode();
      sheet = image;
      refresh();
    } catch {
      // The last pose is also available as a small independent poster.
    } finally {
      loading = false;
    }
  }
  function stop() {
    cancelAnimationFrame(raf);
    active?.resolve?.(false);
    active = undefined;
  }
  function show(screen) {
    stop();
    summary.style.opacity = '0';
    code.replaceChildren();
    delete actor.dataset.frame;
    if (context) painter.clear(context);
    return new Promise((resolve, reject) => {
      const run = active = { started: screen.publishedAt, elapsed: 0, frame: -1, opacity: 0, ready: false, resolve };
      preload();
      refresh();
      ledQr(imageUrl(screen.image)).then(({ tile }) => {
        if (active !== run) return;
        tile.dataset.image = screen.image;
        code.replaceChildren(tile);
        run.ready = true;
        refresh();
      }).catch(error => { if (active === run) reject(error); });
    });
  }
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('buddy-clock', refresh);
  host.closest('.scene').addEventListener('buddy-resolution', refresh);
  window.addEventListener('online', preload);
  reduce.addEventListener('change', refresh);
  preload();
  return { show, stop };
}
