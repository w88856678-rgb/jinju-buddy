import sharp from 'sharp';
import jsQR from 'jsqr';

export async function readQr(bytes, prepareImage = false) {
  const input = sharp(bytes, { limitInputPixels: 24e6, failOn: 'warning' });
  let metadata, pixels;
  try {
    metadata = await input.metadata();
    if (!['png', 'jpeg'].includes(metadata.format)) throw new Error();
    pixels = await input
      .clone()
      .rotate()
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: 'white' })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw Object.assign(new Error('图片无法读取，请选择有效的 PNG 或 JPG'), { status: 400 });
  }
  const { width, height } = pixels.info;
  const code = jsQR(new Uint8ClampedArray(pixels.data), width, height);
  if (!code)
    throw Object.assign(new Error('未识别到二维码，请换一张包含完整二维码的清晰图片。'), { status: 422 });
  if (!prepareImage) return { target: code.data };

  // A screenshot may contain an entire poster. Keep its actual code pixels and
  // provide a clean quiet zone so the projected symbol fills the square.
  const points = ['topLeftCorner', 'topRightCorner', 'bottomLeftCorner', 'bottomRightCorner'].map(
    (key) => code.location[key]
  );
  const left = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x))) - 1);
  const top = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))) - 1);
  const right = Math.min(width, Math.ceil(Math.max(...points.map((p) => p.x))) + 1);
  const bottom = Math.min(height, Math.ceil(Math.max(...points.map((p) => p.y))) + 1);
  const side = Math.max(right - left, bottom - top);
  const margin = Math.ceil((4 * side) / (17 + 4 * code.version));
  const size = side + 2 * margin;
  const symbol = await sharp(pixels.data, { raw: pixels.info })
    .extract({ left, top, width: right - left, height: bottom - top })
    .png()
    .toBuffer();
  const png = await sharp({ create: { width: size, height: size, channels: 3, background: 'white' } })
    .composite([{ input: symbol, gravity: 'centre' }])
    .png()
    .toBuffer();
  return { target: code.data, png };
}
