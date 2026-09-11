#!/usr/bin/env python3
"""Double-clickable helper: Ultra HDR JPEG -> gain map AVIF.

    py tools/run_avif_gainmap.py [photo_ultrahdr.jpg] [-o out.avif] [--dry-run]

With no arguments it looks for *_ultrahdr.jpg files in the current directory,
then in tools/. Resolves its own absolute path so it works from any directory.
"""

import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "avif_gainmap.py")

if not os.path.exists(SCRIPT):
    sys.exit(f"script not found: {SCRIPT}")

args = sys.argv[1:]
if not args or (len(args) == 1 and not args[0].endswith(".jpg") and not args[0].endswith(".jpeg")):
    candidates = glob.glob("*_ultrahdr.jpg") + glob.glob(os.path.join(HERE, "*_ultrahdr.jpg"))
    if not candidates:
        print("no *_ultrahdr.jpg found; drop one as an argument")
        sys.exit(1)
    args = [candidates[0]] + args if args else [candidates[0]]

# the libavif tools ship next to the script; prefer them over a PATH lookup.
# avifenc is the fallback encoder when avifgainmaputil lacks libxml2.
gainmaputil = os.path.join(HERE, "avifgainmaputil.exe")
if os.path.exists(gainmaputil) and "--gainmaputil" not in args:
    args += ["--gainmaputil", gainmaputil]
avifenc = os.path.join(HERE, "avifenc.exe")
if os.path.exists(avifenc) and "--avifenc-bin" not in args:
    args += ["--avifenc-bin", avifenc]

rc = subprocess.call([sys.executable, SCRIPT, *args])
if rc != 0:
    try:
        input(f"\nexit {rc}  (press Enter to close)")
    except EOFError:
        pass
sys.exit(rc)
