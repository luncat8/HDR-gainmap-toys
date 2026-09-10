#!/usr/bin/env python3
"""Double-clickable helper: produces a gain map AVIF from tools/avif_gainmap.py.

    py tools/run_avif_gainmap.py [base.png gainmap.png gainmap.json] [-o out.avif]

With no arguments it uses the sample files already in tools/ (1_base.png,
1_gainmap.png, 1_gainmap.json) and writes 1_gainmap.avif next to them.
Resolves its own absolute path so it works from any working directory.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "avif_gainmap.py")

SAMPLES = [
    os.path.join(HERE, "1_base.png"),
    os.path.join(HERE, "1_gainmap.png"),
    os.path.join(HERE, "1_gainmap.json"),
]

if not os.path.exists(SCRIPT):
    sys.exit(f"script not found: {SCRIPT}")

args = sys.argv[1:]
if not args:
    args = SAMPLES

# avifgainmaputil ships next to the script; point at it so the AVIF is actually
# produced instead of falling back to a PATH lookup.
gainmaputil = os.path.join(HERE, "avifgainmaputil.exe")
if os.path.exists(gainmaputil) and "--gainmaputil" not in args:
    args += ["--gainmaputil", gainmaputil]

rc = subprocess.call([sys.executable, SCRIPT, *args])
if rc != 0:
    try:
        input(f"\nexit {rc}  (press Enter to close)")
    except EOFError:
        pass
sys.exit(rc)