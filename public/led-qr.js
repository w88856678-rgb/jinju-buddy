const side = 116;
const cache = new Map();

function canvas(width, height) {
  const node = document.createElement('canvas');
  node.width = width;
  node.height = height;
  return node;
}

// Map ideal module centres through the four corners found by the decoder.
// This also handles a tilted code inside an uploaded photograph or poster.
function project(location) {
  const { topLeftCorner: a, topRightCorner: b, bottomRightCorner: c, bottomLeftCorner: d } = location;
  const bx = b.x - c.x, by = b.y - c.y, dx = d.x - c.x, dy = d.y - c.y;
  const sx = a.x - b.x + c.x - d.x, sy = a.y - b.y + c.y - d.y;
  const det = bx * dy - dx * by;
  const g = (sx * dy - dx * sy) / det, h = (bx * sy - sx * by) / det;
  return (u, v) => {
    const w = 1 + g * u + h * v;
    return {
      x: ((b.x * (1 + g) - a.x) * u + (d.x * (1 + h) - a.x) * v + a.x) / w,
      y: ((b.y * (1 + g) - a.y) * u + (d.y * (1 + h) - a.y) * v + a.y) / w,
    };
  };
}

async function rasterize(url) {
  const image = new Image();
  image.src = url;
  await Promise.all([image.decode(), import('./jsqr.js')]);
  const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
  const source = canvas(Math.max(1, Math.round(image.naturalWidth * scale)), Math.max(1, Math.round(image.naturalHeight * scale)));
  const ctx = source.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, source.width, source.height);
  ctx.drawImage(image, 0, 0, source.width, source.height);
  const rgba = ctx.getImageData(0, 0, source.width, source.height).data;
  const code = globalThis.jsQR(rgba, source.width, source.height);
  if (!code) throw new Error('未识别到二维码，请换一张清晰的总结码。');
  const modules = 17 + 4 * code.version;
  const pitch = Math.floor(side / (modules + 8));
  if (!pitch) throw new Error('码点超出 LED 高度，请使用较短的总结链接。');
  const point = project(code.location);
  function luminance(column, row) {
    const { x, y } = point((column + 0.5) / modules, (row + 0.5) / modules);
    const px = Math.min(source.width - 1, Math.max(0, Math.floor(x)));
    const py = Math.min(source.height - 1, Math.max(0, Math.floor(y)));
    const i = 4 * (py * source.width + px);
    return rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722;
  }
  // Each finder supplies a dark centre and an adjacent white ring.
  const finders = [[0, 0], [modules - 7, 0], [0, modules - 7]];
  const tone = (offset) => finders.reduce((total, [x, y]) => total + luminance(x + offset, y + 3), 0) / 3;
  const dark = tone(3), light = tone(1), threshold = (light + dark) / 2;
  const tile = canvas(side, side);
  const ink = tile.getContext('2d', { willReadFrequently: true });
  const pad = Math.floor((side - pitch * modules) / 2);
  ink.fillStyle = '#fff';
  ink.fillRect(0, 0, side, side);
  ink.fillStyle = '#000';
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if ((luminance(col, row) < threshold) === (dark < light))
        ink.fillRect(pad + col * pitch, pad + row * pitch, pitch, pitch);
    }
  }
  const proof = globalThis.jsQR(ink.getImageData(0, 0, side, side).data, side, side);
  if (!proof || proof.binaryData.length !== code.binaryData.length ||
      !proof.binaryData.every((byte, i) => byte === code.binaryData[i]))
    throw new Error('116 像素预览未能读回原码，请更换清晰黑白码或缩短总结链接。');
  tile.setAttribute('role', 'img');
  tile.setAttribute('aria-label', '扫描二维码查看总结');
  return { tile, pitch, target: code.data };
}

export function ledQr(url) {
  if (!cache.has(url)) {
    if (cache.size >= 6) cache.delete(cache.keys().next().value);
    const result = rasterize(url).catch((error) => {
      if (cache.get(url) === result) cache.delete(url);
      throw error;
    });
    cache.set(url, result);
  }
  return cache.get(url);
}
