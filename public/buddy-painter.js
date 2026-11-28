import { film } from './buddy-frames.js';

// Rectangles are in the original 2x stage coordinates. The detail tiles have
// twice these dimensions and keep exactly the same pose registration.
const poses = {
  play: { width: film.cell, height: film.cell, columns: film.columns, page: film.perPage, count: film.playFrames },
  hello: { width: film.greeting.cell, height: film.greeting.cell, columns: film.greeting.columns,
    page: film.greeting.perPage, count: film.waveFrames },
  film: { width: 204, height: 184, columns: 10, page: 100, count: 100, left: 10, top: 28, surface: film.cell },
  summary: { width: 224, height: 200, columns: 10, page: 125, count: 125 },
};
const detailColumns = 6, detailPage = 24;

export function createBuddyPainter(scene) {
  const tiles = new Map(), painted = new WeakMap();
  let density = 2, cssWidth = 0, touches = 0;
  const changed = () => scene.dispatchEvent(new Event('buddy-resolution'));

  function load(group, page, pin = false) {
    const key = group + '-hd-' + page;
    let entry = tiles.get(key);
    if (entry && !(entry.retry && performance.now() >= entry.retry)) {
      entry.used = ++touches;
      return entry.ready ? entry.image : null;
    }
    const image = new Image();
    entry = { image, used: ++touches, pin: pin || entry?.pin };
    tiles.set(key, entry);
    // Keep only the first cue pages and a short moving window decoded.
    if (tiles.size > 7) {
      let oldest;
      for (const item of tiles) if (!item[1].pin && (!oldest || item[1].used < oldest[1].used)) oldest = item;
      if (oldest) tiles.delete(oldest[0]);
    }
    image.decoding = 'async';
    image.src = '/static/assets/buddy-' + key + '.webp' + (group === 'hello' ? '?v=' + film.greeting.version : '');
    image.decode().then(() => {
      entry.ready = true;
      if (tiles.get(key) === entry) changed();
    }).catch(() => { entry.retry = performance.now() + 5000; });
    return null;
  }
  function warm(group, index) {
    if (density > 2) load(group, Math.floor(index / detailPage));
  }
  function resize(width) {
    cssWidth = width;
    const next = Math.min(8, Math.max(2, width * (window.devicePixelRatio || 1) / 512));
    if (next === density) return;
    const enteringHD = density === 2 && next > 2;
    density = next;
    if (enteringHD) {
      load('hello', 0, true);
      load('film', 1, true);
      load('summary', 0, true);
    }
    if (density === 2) tiles.clear();
    changed();
  }
  window.addEventListener('resize', () => resize(cssWidth));

  function draw(context, group, index, fallback) {
    const spec = poses[group];
    const page = Math.floor(index / detailPage);
    const hd = density > 2 && load(group, page);
    if (density > 2 && index % detailPage >= detailPage / 2 && (page + 1) * detailPage < spec.count)
      load(group, page + 1);
    const image = hd || fallback;
    if (!image) return false;
    const last = painted.get(context);
    if (last?.image === image && last.index === index && last.density === density) return true;
    const canvas = context.canvas;
    const baseWidth = spec.surface || spec.width, baseHeight = spec.surface || spec.height;
    const width = Math.round(baseWidth * density / 2), height = Math.round(baseHeight * density / 2);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.setTransform(width / baseWidth, 0, 0, height / baseHeight, 0, 0);
    context.imageSmoothingQuality = 'high';
    context.clearRect(0, 0, baseWidth, baseHeight);
    const slot = index % (hd ? detailPage : spec.page), columns = hd ? detailColumns : spec.columns;
    const sw = spec.width * (hd ? 2 : 1), sh = spec.height * (hd ? 2 : 1);
    context.drawImage(image, slot % columns * sw, Math.floor(slot / columns) * sh, sw, sh,
      spec.left || 0, spec.top || 0, spec.width, spec.height);
    if (canvas.dataset.sourceScale !== (hd ? '4' : '2')) canvas.dataset.sourceScale = hd ? '4' : '2';
    painted.set(context, { image, index, density });
    return true;
  }
  function clear(context) {
    context.resetTransform();
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    painted.delete(context);
  }
  return { draw, clear, resize, warm };
}
