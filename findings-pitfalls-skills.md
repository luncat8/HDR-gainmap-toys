notes and pitfalls for LLM agents. verified in this repo unless marked otherwise.

## hdr canvas (webgpu)

```js
context.configure({ device, format: 'rgba16float', colorSpace: 'srgb',
                    toneMapping: { mode: 'extended' }, alphaMode: 'opaque' });
const hdr = context.getConfiguration().toneMapping.mode === 'extended';   // Chrome 131+
```

* `1.0` = SDR white. Above `1.0` is HDR, up to the display headroom.
* the shader must write the **transfer function itself**: `colorSpace:'srgb'` +
  `extended` is *extended sRGB* (gamma encoded, continued past 1.0), not scRGB.
  `linearToSrgb(c) = 1.055*c^(1/2.4) - 0.055` for `c > 0.0031308`, used for
  `c > 1` too. writing linear values here is the classic mistake and gives a
  washed-out image with no error message.
  (`colorSpace:'display-p3'` + extended = same encoding, P3 primaries.)
* headroom: `screen.highDynamicRangeHeadroom` (Chrome 133+), else
  `matchMedia('(dynamic-range: high)')`. it changes over time, so read it on use.
* WebGL equivalent: `gl.drawingBufferStorage(gl.RGBA16F, …)` +
  `drawingBufferColorSpace` + `drawingBufferToneMapping`.

## ultra hdr jpeg (iso 21496-1 / adobe gain map)

file = primary jpeg (sdr) + secondary jpeg (gain map, usually 1/4 size) + xmp + mpf.

```
SOI APP1:xmp(hdrgm + GContainer) APP2:mpf <rest of base jpeg> EOI
SOI APP1:xmp(hdrgm)              <gain map jpeg>             EOI
```

* **MPF offsets are relative to the TIFF header**, i.e. the byte after `MPF\0`
  (checked against a Pixel sample: entry 2599690 + tiff 84458 = 2684148 = real
  SOI). using file-absolute offsets is the most common corruption.
  first image carries offset 0 and means "the container itself" (file 0).
* MPF: little-endian TIFF, `II 2A00`, IFD at TIFF offset 8, 3 entries
  (`0xB000` version "0100", `0xB001` count 2, `0xB002` list of 2×16 bytes at
  TIFF offset 50). entry 0 attribute `0x00030000`, entry 1 `0x00000000`.
  total APP2 = `FF E2 00 58` + 86 bytes.
* XMP: `hdrgm:` in both images; `Container:Directory` (Primary + GainMap with
  `Item:Length`) only in the primary. full params in the primary is what Chrome
  reads; Google Photos uses the GContainer directory. put both in.
* metadata: `GainMapMin/Max` in log2 stops, `HDRCapacityMax = GainMapMax`,
  `HDRCapacityMin = max(GainMapMin, 0)`, offsets 0, no `Gamma` (=1), no
  `BaseRenditionIsHDR` (=False). 6 decimals, matches reference files.
* decode:
  ```
  log_boost = min*(1-r) + max*r,  r = (encoded/255)^(1/gamma)
  weight    = clamp((log2(display_boost) - capMin)/(capMax - capMin), 0, 1)
  hdr       = (sdr + offsetSdr) * 2^(log_boost*weight) - offsetHdr
  ```
  the weight is why a file looks flat on a low-headroom display: authoring at
  4× boost shows 4× only where the display has 4× to give.
* real sample to diff against: `MishaalRahmanGH/Ultra_HDR_Samples` (Originals).
  byte-level reference implementation: `hanfeisun/pyultrahdr` (~230 lines py).

## avif gain map

* impossible in the browser: no AV1 encoder and no container writer with an
  `altr` (alternate) item. `canvas.toBlob` has no `image/avif` either.
* `avifgainmaputil combine base alternate out.avif` **computes the gain map
  itself** from the two images — it cannot take a precomputed one. feed it a
  16-bit PNG alternate (PQ / BT.2020 here) and pass `--ignore-profile`:
  libavif fails with "Not implemented" on images that carry an ICC profile.
* Pillow cannot save 16-bit RGB PNG; `tools/avif_gainmap.py` has a 25-line
  zlib writer for that (`IHDR` depth 16, colortype 2, filter 0 rows).

## browser jpeg encoding

* `canvas.toBlob('image/jpeg')` is the only encoder available without a wasm
  codec. it may emit 1 or 3 components for a gray image — read the SOF
  `components` byte (`UHDR.jpegInfo`) and report it; both are legal as a gain
  map, 3 components just costs bytes.
* uploading pixels: prefer `getImageData` + `queue.writeTexture` (pad
  `bytesPerRow` to 256) when the texture is data (gain maps) or when the exact
  encoding matters — it bypasses all color-management questions.

## testing without a browser in this sandbox

* no Chrome available: `storage.googleapis.com` and `raw.githubusercontent.com`
  are blocked, so `puppeteer`/`playwright` downloads fail; `@kmamal/gpu` builds
  Dawn from source. don't retry these.
* WGSL syntax + uniform layout: `npm i wgsl_reflect`, then
  `new WgslReflect(code)` — catches typos and verifies struct offsets.
* app wiring: `tests/node/app.smoke.js` stubs document + WebGPU and drives a
  real save → parse → verify cycle.
* `exiftool` (independent MPF/XMP parser) runs from a tarball without root:
  `perl exiftool -G1 -n file.jpg`. tarball from the GitHub release mirror
  (`github.com/exiftool/exiftool/archive/refs/tags/…`) — exiftool.org is blocked.
* python: no root, so `python3 -m venv /tmp/venv` + pip inside it.
* `/tmp` is wiped between turns; keep only repo files, re-install tools per turn.
* github raw files: `curl -H "Accept: application/vnd.github.raw"
  https://api.github.com/repos/<repo>/git/blobs/<sha>` (raw host is blocked).
