"""Build transparent frames for both 25 fps performances in the original stage coordinates.

Usage: python3 scripts/build-buddy-frames.py greeting.mp4 play.mp4
Requires ffmpeg and Pillow. Coordinates below are measured in native 512 x 128 LED pixels.
"""
import argparse
import json
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1] / "public"
CELL = 216
COLUMNS = 10
PAGE = 80
FPS = 25

def frames(path, first, count, offset):
    filters = f"trim=start_frame={first}:end_frame={first+count},scale=1024:256:flags=area,crop={CELL}:{CELL}:{offset*2}:8"
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", filters, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    with subprocess.Popen(cmd, stdout=subprocess.PIPE) as process:
        for _ in range(count):
            data = process.stdout.read(CELL * CELL * 3)
            if len(data) != CELL * CELL * 3:
                raise ValueError(f"Unexpected end of {path}")
            yield Image.frombytes("RGB", (CELL, CELL), data)
        if process.wait():
            raise RuntimeError(f"Could not decode {path}")

def cutout(im, plate_gaps=False):
    r, g, b = im.split()
    bright = ImageChops.lighter(ImageChops.lighter(r, g), b)
    threshold = 38 if plate_gaps else 18
    edges = bright.point(lambda p: 255 if p > threshold else 0)
    # Only remove black connected to the outer background. The dark visor is part of Buddy.
    ImageDraw.floodfill(edges, (0, 0), 128)
    if plate_gaps:
        # The black plate also shows through closed gaps between flower, arms and
        # body. Keep shaded visor pixels; only remove islands with a solid black core.
        core = bright.point(lambda v: 255 if v < 6 else 0).filter(ImageFilter.MinFilter(3))
        while True:
            seeds = ImageChops.darker(core, edges.point(lambda v: 255 if v == 0 else 0))
            box = seeds.getbbox()
            if not box:
                break
            x = next(i for i in range(box[0], box[2]) if seeds.getpixel((i, box[1])))
            ImageDraw.floodfill(edges, (x, box[1]), 64)
            component = edges.point(lambda v: 255 if v == 64 else 0)
            hist = bright.histogram(component)
            is_plate = sum(hist) >= 24 and sum(hist[:6]) >= sum(hist) * .4
            edges.paste(128 if is_plate else 255, mask=component)
        hard = edges.point(lambda v: 0 if v == 128 else 255)
        # Limit decontamination to the silhouette, including motion-blurred edges.
        core_alpha = hard.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(.55))
        rim = hard.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(.65))
        coverage = bright.point(lambda v: min(255, round(v * 255 / 100)))
        alpha = ImageChops.lighter(core_alpha, ImageChops.multiply(rim, coverage))
    else:
        alpha = edges.point(lambda v: 0 if v == 128 else 255).filter(ImageFilter.GaussianBlur(.85))
    return Image.merge("RGBa", (r, g, b, alpha)).convert("RGBA")

def pack(name, film):
    sheet = None
    for i, raw in enumerate(film):
        if i % PAGE == 0:
            sheet = Image.new("RGBA", (COLUMNS * CELL, (PAGE // COLUMNS) * CELL))
        frame = cutout(raw)
        slot = i % PAGE
        sheet.paste(frame, (slot % COLUMNS * CELL, slot // COLUMNS * CELL))
        if name == "play" and i == 0:
            frame.save(ROOT / "assets/buddy-play-poster.webp", quality=92)
        yield raw, frame
        if slot == PAGE - 1:
            sheet.save(ROOT / f"assets/buddy-{name}-{i//PAGE}.webp", quality=86, method=4)
    if slot != PAGE - 1:
        sheet = sheet.crop((0, 0, COLUMNS * CELL, (slot // COLUMNS + 1) * CELL))
        sheet.save(ROOT / f"assets/buddy-{name}-{i//PAGE}.webp", quality=86, method=4)

def pack_greeting(path, count):
    # The LED master is sampled at 2x, like the idle actor. Preserve the measured
    # horizontal position of each frame as Buddy crosses the 4:1 stage.
    scale, width, height = 2, 1024, 256
    cell, top, columns, per_page = 192, 32, 8, 40
    positions = []
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={width}:{height}:flags=area",
           "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    with subprocess.Popen(cmd, stdout=subprocess.PIPE) as process:
        for index in range(count):
            raw = process.stdout.read(width * height * 3)
            if len(raw) != width * height * 3:
                raise ValueError("Missing greeting frame " + str(index))
            im = Image.frombytes("RGB", (width, height), raw)
            red, green, blue = im.split()
            bright = ImageChops.lighter(ImageChops.lighter(red, green), blue)
            bounds = bright.point(lambda v: 255 if v >= 16 else 0).getbbox()
            left = max(0, bounds[0] - 4)
            if bounds[2] > left + cell - 3 or bounds[1] < top + 2 or bounds[3] > top + cell - 2:
                raise ValueError(f"Greeting pose outside its cell at frame {index}")
            positions.append(left)
            tile = cutout(im.crop((left, top, left + cell, top + cell)), plate_gaps=True)
            slot = index % per_page
            if slot == 0:
                rows = (min(per_page, count - index) + columns - 1) // columns
                page = Image.new("RGBA", (columns * cell, rows * cell))
            page.paste(tile, ((slot % columns) * cell, (slot // columns) * cell))
            if slot == per_page - 1 or index == count - 1:
                page.save(ROOT / f"assets/buddy-hello-{index // per_page}.webp", quality=89, method=4)
        if process.wait():
            raise RuntimeError("Could not decode greeting")
    return dict(scale=scale, cell=cell, top=top, columns=columns, perPage=per_page, x=positions)


def build(wave, play):
    info = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=nb_frames,r_frame_rate,width,height", "-of", "json", wave
    ]))["streams"][0]
    if info["r_frame_rate"] != "25/1" or info["width"] != info["height"] * 4:
        raise ValueError("Expected the original 4:1, 25 fps greeting")
    original = ROOT / "assets/buddy-greeting.mp4"
    if Path(wave).resolve() != original.resolve():
        shutil.copyfile(wave, original)
    greeting = pack_greeting(wave, int(info["nb_frames"]))
    count = sum(1 for _ in pack("play", frames(play, 0, 453, 0)))
    metadata = dict(frameMs=1000//FPS, cell=CELL, columns=COLUMNS, perPage=PAGE,
                    playFrames=count, waveFrames=len(greeting["x"]), greeting=greeting)
    (ROOT / "buddy-frames.js").write_text(
        "// Generated by scripts/build-buddy-frames.py from the two approved films.\n"
        + "export const film = " + json.dumps(metadata, separators=(", ", ": ")) + ";\n"
    )

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wave")
    parser.add_argument("play")
    args = parser.parse_args()
    build(args.wave, args.play)
