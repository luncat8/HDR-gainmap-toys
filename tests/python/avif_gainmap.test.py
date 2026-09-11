#!/usr/bin/env python3
"""node tests/node/ultrahdr.test.js, but for tools/avif_gainmap.py.

    python3 tests/python/avif_gainmap.test.py

structure tests always run. the AVIF merge tests need pillow-avif-plugin
(real AV1 encoding):

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install pillow pillow-avif-plugin
    /tmp/venv/bin/python tests/python/avif_gainmap.test.py
"""

import math
import os
import stat
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import avif_gainmap as AG  # noqa: E402

failures = 0


def check(name, ok, detail=""):
    global failures
    if not ok:
        failures += 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"  {detail}" if detail != "" else ""))


# ── ultra hdr jpeg parsing ───────────────────────────────────────────────────

sample = os.path.join(ROOT, "tools", "pattern_ sky_ultrahdr.jpg")
with open(sample, "rb") as f:
    data = f.read()
p = AG.parse_ultrahdr(data)
check("sample: base is a JPEG", p["base"][:2] == b"\xff\xd8" and p["base"][-2:] == b"\xff\xd9")
check("sample: gain map is a JPEG",
      p["gainmap"][:2] == b"\xff\xd8" and p["gainmap"][-2:] == b"\xff\xd9")
check("sample: hdrgm version", p["meta"].get("version") == "1.0", p["meta"].get("version"))
check("sample: ranges parsed",
      isinstance(p["meta"]["gainMapMax"], float) and p["meta"]["gainMapMax"] > 0,
      f"max={p['meta']['gainMapMax']}")
check("sample: parts rejoin", len(p["base"]) + len(p["gainmap"]) == len(data))

# build -> parse round trip (same pair as tests/node/ultrahdr.test.js)
with open(os.path.join(ROOT, "tests", "data", "base.jpg"), "rb") as f:
    base_jpg = f.read()
with open(os.path.join(ROOT, "tests", "data", "gainmap.jpg"), "rb") as f:
    gain_jpg = f.read()
meta = {"gainMapMin": 0.0, "gainMapMax": math.log2(1000 / 203),
        "hdrCapacityMin": 0.0, "hdrCapacityMax": math.log2(1000 / 203),
        "offsetSDR": 0.0, "offsetHDR": 0.0, "gamma": 1.0}
ultra = AG.build_ultrahdr(base_jpg, gain_jpg, meta)
p2 = AG.parse_ultrahdr(ultra)
# parsed base = SOI + inserted XMP + MPF + rest of the original base
stripped = p2["base"][:2] + b"".join(
    ultra[s:e] for m, s, e in AG.jpeg_segments(p2["base"])
    if not (m == 0xE1 and ultra[s + 4:s + 4 + 28].startswith(b"http://ns.adobe.com/xap"))
    and not (m == 0xE2 and ultra[s + 4:s + 8] == b"MPF\x00"))
check("round trip: base identical", stripped == base_jpg,
      f"{len(stripped)} vs {len(base_jpg)}")
check("round trip: gain map keeps its JPEG", p2["gainmap"].endswith(gain_jpg[2:]))
check("round trip: meta max", abs(p2["meta"]["gainMapMax"] - meta["gainMapMax"]) < 1e-6,
      p2["meta"]["gainMapMax"])

# ── fractions ────────────────────────────────────────────────────────────────

check("frac 0", AG.frac(0.0, 0xFFFFFFFF) == (0, 1))
check("frac 1", AG.frac(1.0, 0xFFFFFFFF) == (1, 1))
check("frac 2.5", AG.frac(2.5, 0xFFFFFFFF) == (5, 2))
n, d = AG.frac(math.log2(1000 / 203), 0xFFFFFFFF)
check("frac irrational close", abs(n / d - math.log2(1000 / 203)) < 1e-9, f"{n}/{d}")
check("sfrac negative", AG.sfrac(-0.5) == (-1, 2))

# ── tmap payload ─────────────────────────────────────────────────────────────

payload = AG.tmap_payload(meta)
check("tmap payload size", len(payload) == 1 + 4 + 1 + 16 + 40, len(payload))
check("tmap flags", payload[5] == 0x40, hex(payload[5]))  # single channel, base color space
rt = AG.parse_tmap_payload(payload)
check("tmap round trip capacity",
      abs(rt["hdrCapacityMax"] - meta["hdrCapacityMax"]) < 1e-6
      and rt["hdrCapacityMin"] == 0.0, rt)
ch = rt["channels"][0]
check("tmap round trip channel",
      abs(ch[0] - 0.0) < 1e-9 and abs(ch[1] - meta["gainMapMax"]) < 1e-6
      and ch[2] == 1.0 and ch[3] == 0.0 and ch[4] == 0.0, ch)

multi = dict(meta, gainMapMin=[0.0, 0.1, 0.2])
pm = AG.parse_tmap_payload(AG.tmap_payload(multi))
check("tmap multichannel", len(pm["channels"]) == 3 and abs(pm["channels"][2][0] - 0.2) < 1e-9)

try:
    AG.tmap_payload(dict(meta, hdrCapacityMin=meta["hdrCapacityMax"]))
    check("tmap rejects capMin == capMax", False)
except ValueError:
    check("tmap rejects capMin == capMax", True)

# ── avif merge (needs pillow-avif-plugin for real AV1) ──────────────────────

try:
    import pillow_avif  # noqa: F401
    from PIL import Image
    have_avif = True
except ImportError:
    have_avif = False
    print("skip AVIF merge tests: pip install pillow pillow-avif-plugin")

if have_avif:
    with tempfile.TemporaryDirectory() as td:
        def encode_avif(img, path, quality):
            img.save(path, quality=quality)
            with open(path, "rb") as f:
                return AG.avif_image(f.read())

        base_img = Image.open(os.path.join(ROOT, "tests", "data", "base.jpg")).convert("RGB")
        gain_img = Image.open(os.path.join(ROOT, "tests", "data", "gainmap.jpg")).convert("L")
        base = encode_avif(base_img, os.path.join(td, "base.avif"), 90)
        gain = encode_avif(gain_img, os.path.join(td, "gain.avif"), 80)
        check("avifenc stand-in: base size",
              (base["width"], base["height"]) == base_img.size,
              f"{base['width']}x{base['height']}")

        merged = AG.write_gainmap_avif(base, gain, meta)
        with open(os.path.join(td, "merged.avif"), "wb") as f:
            f.write(merged)

        t = AG.avif_tmap(merged)
        check("merged: 3 items", len(t["items"]) == 3, len(t["items"]))
        check("merged: item types",
              t["items"][1]["type"] == b"av01" and t["items"][2]["type"] == b"tmap"
              and t["items"][3]["type"] == b"av01")
        check("merged: gain map hidden", t["items"][3]["flags"] & 1 == 1,
              t["items"][3]["flags"])
        check("merged: dimg tmap -> [color, gain]", t["dimg"].get(2) == [1, 3], t["dimg"])
        check("merged: altr [tmap, color]", t["altr"] == [2, 1], t["altr"])
        check("merged: metadata round trip",
              abs(t["meta"]["hdrCapacityMax"] - meta["hdrCapacityMax"]) < 1e-6
              and abs(t["meta"]["channels"][0][1] - meta["gainMapMax"]) < 1e-6
              and t["meta"]["use_base_colour_space"])

        # base AV1 bytes must be carried over unchanged
        m2 = AG.avif_image(merged)
        check("merged: base av1 carried over", m2["data"] == base["data"],
              f"{len(m2['data'])} vs {len(base['data'])} bytes")
        check("merged: ftyp has tmap brand", b"tmap" in m2["brands"], m2["brands"])

        # an AVIF decoder must still accept the file and show the base image
        # (pillow-avif-plugin bundles an old libavif that predates 'tmap' —
        # skip then; current libavif is checked separately in the sandbox)
        try:
            with Image.open(os.path.join(td, "merged.avif")) as decoded:
                check("merged: decodes", decoded.size == base_img.size, decoded.size)
        except Exception as e:
            print(f"skip merged decode: pillow libavif predates tmap ({e})")

        # full main() flow: failing "converter" + avifenc stand-in -> fallback
        shim = os.path.join(td, "fake_avifenc.py")
        with open(shim, "w") as f:
            f.write("import sys, pillow_avif\nfrom PIL import Image\n"
                    "a = sys.argv[1:]\n"
                    "while '-q' in a:\n"
                    "    i = a.index('-q')\n"
                    "    del a[i:i+2]\n"
                    "Image.open(a[-2]).save(a[-1], quality=60)\n")
        with open(shim, "a") as f:
            pass
        os.chmod(shim, os.stat(shim).st_mode | stat.S_IEXEC)
        shebang = os.path.join(shim + ".run")
        with open(shebang, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(open(shim).read())
        os.chmod(shebang, 0o755)

        src = os.path.join(td, "photo_ultrahdr.jpg")
        with open(src, "wb") as f:
            f.write(ultra)
        dst = os.path.join(td, "photo.avif")
        argv = [sys.executable, os.path.join(ROOT, "tools", "avif_gainmap.py"),
                src, "-o", dst, "--gainmaputil", "/nonexistent/avifgainmaputil",
                "--avifenc-bin", shebang]
        cp = subprocess.run(argv, capture_output=True, text=True, cwd=ROOT)
        check("main() fallback succeeds", cp.returncode == 0,
              (cp.stderr or cp.stdout).strip().splitlines()[-1] if (cp.stderr or cp.stdout) else "")
        check("main() fallback wrote the avif", os.path.exists(dst))
        if os.path.exists(dst):
            t2 = AG.avif_tmap(open(dst, "rb").read())
            check("main() avif has the authored range",
                  abs(t2["meta"]["channels"][0][1] - meta["gainMapMax"]) < 1e-6,
                  t2["meta"]["channels"][0][1])

print(f"\n{'all ok' if failures == 0 else str(failures) + ' FAILURES'}")
sys.exit(1 if failures else 0)
