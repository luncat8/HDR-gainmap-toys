#!/usr/bin/env python3
"""Terminal fallback: browser-exported base + gain map -> gain map AVIF.

The browser writes Ultra HDR JPEG directly and needs nothing from here. This
script is for the AVIF branch: encode an SDR base plus an HDR alternate into a
gain map AVIF with libavif's avifgainmaputil, which computes the gain map from
the two images itself (it has no "take my precomputed gain map" mode).

    python3 tools/avif_gainmap.py base.png gainmap.png gainmap.json [-o out.avif]

    1. reads the exported gain map PNG (8 bit, recovery in [0,1])
    2. rebuilds the intended HDR rendition with the decoder formula
    3. writes it as a 16 bit PQ / BT.2020 PNG (what avifgainmaputil wants as
       the "alternate" image)
    4. runs: avifgainmaputil combine --ignore-profile \
             --cicp-base 1/1/1 --cicp-alternate 9/16/9 \
             base.png alternate_pq16.png out.avif

avifgainmaputil is not present in every environment (and was not available
where this was written), so step 4 is deliberately visible: use --dry-run to
print the command, or point --gainmaputil at a binary. libavif refuses images
with ICC profiles, hence --ignore-profile.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import zlib

import numpy as np
from PIL import Image

# ── gain map math (Ultra HDR v1.0 / ISO 21496-1) ───────────────────────────


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_pq(x: np.ndarray) -> np.ndarray:
    """SMPTE ST 2084 OETF, input in nits normalised to 10000."""
    m1 = 0.1593017578125
    m2 = 78.84375
    c1 = 0.8359375
    c2 = 18.8515625
    c3 = 18.6875
    y = np.clip(x, 0.0, 1.0) ** m1
    return ((c1 + c2 * y) / (1.0 + c3 * y)) ** m2


BT709_TO_BT2020 = np.array(
    [[0.6274040, 0.3292820, 0.0433136],
     [0.0690970, 0.9195400, 0.0113612],
     [0.0163916, 0.0880132, 0.8955950]],
    dtype=np.float32,
)


def hdr_from_gainmap(base_rgb: np.ndarray, gain: np.ndarray, meta: dict) -> np.ndarray:
    """Linear BT.709 HDR in nits, at full authored boost."""
    sdr = srgb_to_linear(base_rgb.astype(np.float32) / 255.0)
    recovery = gain.astype(np.float32) / 255.0
    log_boost = meta["gainMapMin"] + recovery * (meta["gainMapMax"] - meta["gainMapMin"])
    boost = np.exp2(log_boost)[..., None]
    sdr_white = float(meta.get("sdrWhiteNits", 203.0))
    hdr = (sdr + meta["offsetSDR"]) * boost - meta["offsetHDR"]
    return np.clip(hdr * sdr_white, 0.0, float(meta.get("peakNits", 1000.0)))


def pq16_png(hdr_nits: np.ndarray) -> np.ndarray:
    """HDR (BT.709 nits) -> 16 bit PQ encoded BT.2020."""
    bt2020 = hdr_nits @ BT709_TO_BT2020.T
    pq = linear_to_pq(bt2020 / 10000.0)
    return np.round(np.clip(pq, 0.0, 1.0) * 65535.0).astype(np.uint16)


# ── 16 bit PNG writer (Pillow will not save 16 bit RGB) ────────────────────


def write_png16(path: str, rgb: np.ndarray) -> None:
    h, w, _ = rgb.shape
    raw = bytearray()
    for row in rgb:
        raw.append(0)  # filter type 0
        raw += row.astype(">u2").tobytes()
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 16, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


# ── main ───────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description="gain map PNG pair -> gain map AVIF")
    ap.add_argument("base", type=str, help="SDR base PNG (8 bit sRGB)")
    ap.add_argument("gainmap", type=str, help="gain map PNG (8 bit gray)")
    ap.add_argument("meta", type=str, help="gainmap.json exported from the browser")
    ap.add_argument("-o", "--out", type=str, default=None)
    ap.add_argument("-q", "--quality", type=int, default=90)
    ap.add_argument("--qgain-map", type=int, default=85)
    ap.add_argument("--gainmaputil", type=str, default=shutil.which("avifgainmaputil") or "")
    ap.add_argument("--dry-run", action="store_true", help="print the command and stop")
    args = ap.parse_args()

    meta = json.load(open(args.meta))
    base = np.array(Image.open(args.base).convert("RGB"), dtype=np.uint8)
    gain = np.array(Image.open(args.gainmap).convert("L"), dtype=np.uint8)
    # the gain map is stored at a fraction of the base resolution: upsample it
    # bilinearly, the way a decoder does
    gw, gh = int(meta.get("baseWidth", base.shape[1])), int(meta.get("baseHeight", base.shape[0]))
    if gain.shape[1] != gw or gain.shape[0] != gh:
        gain = np.array(Image.fromarray(gain).resize((gw, gh), Image.BILINEAR), dtype=np.uint8)

    hdr = hdr_from_gainmap(base, gain, meta)
    target = args.out or args.base.replace("_base.png", "") + "_gainmap.avif"
    alt = os.path.splitext(target)[0] + "_alternate_pq16.png"
    write_png16(alt, pq16_png(hdr))

    stops = meta["gainMapMax"] - meta["gainMapMin"]
    print(f"alternate {alt}  peak {hdr.max():.0f} nits, "
          f"boost up to {2 ** stops:.2f}x ({stops:.2f} stops)")

    cmd = [
        args.gainmaputil or "avifgainmaputil", "combine",
        "--ignore-profile",
        "--cicp-base", "1/1/1",
        "--cicp-alternate", "9/16/9",
        "-q", str(args.quality),
        "--qgain-map", str(args.qgain_map),
        args.base, alt, target,
    ]
    if args.dry_run:
        print(" ".join(cmd))
        return 0
    if not args.gainmaputil:
        print("avifgainmaputil not found: install libavif or pass --gainmaputil PATH",
              file=sys.stderr)
        print(" ".join(cmd))
        return 2
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main())
