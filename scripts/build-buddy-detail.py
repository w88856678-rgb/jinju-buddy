"""Pack original-resolution poses for large displays. Run after build-buddy-frames.py.

Usage: python3 scripts/build-buddy-detail.py greeting.mp4 standby.mp4 summary.mp4
Requires FFmpeg, Pillow, NumPy and OpenCV for offline asset preparation.
"""
import argparse
import importlib.util
import json
import subprocess
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("buddy_art", Path(__file__).with_name("build-buddy-frames.py"))
art = importlib.util.module_from_spec(spec)
spec.loader.exec_module(art)
assets = art.ROOT / "assets"
columns, per_page = 6, 24


def decoded(source, count, size, crop=None):
    command = ["ffmpeg", "-v", "error", "-i", str(source)]
    if crop:
        command += ["-vf", crop]
    with subprocess.Popen(command + ["-pix_fmt", "rgb24", "-f", "rawvideo", "-"], stdout=subprocess.PIPE) as video:
        for index in range(count):
            data = video.stdout.read(size[0] * size[1] * 3)
            if len(data) != size[0] * size[1] * 3:
                raise ValueError(f"Missing frame {index} in {source}")
            yield Image.frombytes("RGB", size, data)
        if video.stdout.read(1) or video.wait():
            raise ValueError(f"Unexpected film length in {source}")


@lru_cache(maxsize=2)
def sheet(name):
    return Image.open(assets / name).convert("RGBA")


def tile(image, index, cols, width, height):
    left, top = index % cols * width, index // cols * height
    return image.crop((left, top, left + width, top + height))


def original_cutout(rgb_image, silhouette):
    # Guide the approved matte with the original RGB edges. Keep the source pixels
    # inside the silhouette, including the visor and the gaps around Buddy's arms.
    rgb = np.asarray(rgb_image)
    prior = cv2.resize(np.asarray(silhouette), rgb_image.size, interpolation=cv2.INTER_CUBIC).astype("float32") / 255
    guide = rgb.max(axis=2).astype("float32") / 255
    def mean(array):
        return cv2.blur(array, (7, 7))
    edge, matte = mean(guide), mean(prior)
    slope = (mean(guide * prior) - edge * matte) / (np.maximum(0, mean(guide * guide) - edge * edge) + .0008)
    coverage = np.clip(mean(slope) * guide + mean(matte - slope * edge), 0, 1)
    kernel = np.ones((3, 3), "uint8")
    inside = cv2.erode((prior >= .997).astype("uint8"), kernel).astype(bool)
    outside = cv2.dilate((prior > .01).astype("uint8"), kernel) == 0
    coverage = np.maximum(coverage, guide)
    coverage[inside], coverage[outside] = 1, 0
    alpha = np.rint(coverage * 255).astype("uint8")
    straight = np.clip(np.rint(rgb * (255 / np.maximum(alpha, 1).astype("float32"))[:, :, None]), 0, 255).astype("uint8")
    straight[alpha == 0] = 0
    return Image.fromarray(np.dstack((straight, alpha)))


def registered(source, name, positions):
    greeting = name == "hello"
    size, count, old_cols, old_page = (192, len(positions), 8, 40) if greeting else (216, 453, 10, 80)
    frames = decoded(source, count, (2048, 512) if greeting else (432, 432), None if greeting else "crop=432:432:0:16")
    for index, rgb in enumerate(frames):
        if greeting:
            left = positions[index] * 2
            rgb = rgb.crop((left, 64, left + 384, 448))
        old = sheet(f"buddy-{name}-{index // old_page}.webp")
        matte = tile(old, index % old_page, old_cols, size, size).getchannel("A")
        yield art.wear_flower(original_cutout(rgb, matte), name, index)


def pack(name, frames):
    # The 4x quote sheet has already been encoded. Split it without a second lossy pass.
    encoding = {"lossless": True, "method": 4} if name == "film" else {"quality": 94, "method": 4}
    for index, pose in enumerate(frames):
        slot = index % per_page
        width, height = pose.size
        if slot == 0:
            atlas = Image.new("RGBA", (columns * width, per_page // columns * height))
        atlas.paste(pose, (slot % columns * width, slot // columns * height))
        path = assets / f"buddy-{name}-hd-{index // per_page}.webp"
        if slot == per_page - 1:
            atlas.save(path, **encoding)
        if name == "play" and index == 0:
            pose.save(assets / "buddy-play-hd-poster.webp", quality=94)
    if slot != per_page - 1:
        atlas.crop((0, 0, atlas.width, (slot // columns + 1) * height)).save(path, **encoding)
    if name == "summary":
        pose.save(assets / "buddy-summary-hd-hold.webp", quality=94)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ("greeting", "standby", "summary"):
        parser.add_argument(argument, type=Path)
    args = parser.parse_args()
    meta = json.loads((art.ROOT / "buddy-frames.js").read_text().split("export const film = ")[1].strip().removesuffix(";"))
    cv2.setNumThreads(1)
    pack("film", (tile(sheet("buddy-film-4x.webp"), i, 10, 408, 368) for i in range(100)))
    pack("hello", registered(args.greeting, "hello", meta["greeting"]["x"]))
    pack("play", registered(args.standby, "play", None))
    pack("summary", (art.cutout(im) for im in decoded(args.summary, 125, (448, 400), "crop=448:400:16:64")))
