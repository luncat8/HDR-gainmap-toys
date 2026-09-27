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
* **proper mix = convert the Ultra HDR JPEG.** `avifgainmaputil convert
  in.ultrahdr.jpg out.avif` (or `avifenc --qgain-map Q -q Q in.jpg out.avif`)
  reads the gain map already inside the JPEG and re-encodes it into an AVIF,
  so the AVIF keeps exactly the authored gain map. this is the terminal path
  `tools/avif_gainmap.py` uses; no base/alternate reconstruction needed.
* `avifgainmaputil <command>` has 7 commands: `help`, `combine`, `convert`,
  `tonemap`, `swapbase`, `extractgainmap`, `printmetadata` (libavif ≥ 1.3).
* `combine base_image alternate_image out.avif` **computes the gain map
  itself** from the two renditions — only use it when you have a true HDR
  alternate. full help:
  ```
  avifgainmaputil combine base_image alternate_image output_image.avif
    [--downscaling N] [--qgain-map 0-100] [--depth-gain-map {8,10,12}]
    [--yuv-gain-map {444,422,420,400}] [--cicp-base P/T/M]
    [--cicp-alternate P/T/M] [-s SPEED] [-q QCOLOR] [--qalpha Q]
    [-y {444,422,420,400}] [-d {0,8,10,12}] [--ignore-profile]
  ```
* combine inputs: 8-bit sRGB base PNG + 12/16-bit PQ/BT.2020 alternate PNG.
  libavif refuses images with ICC profiles → pass `--ignore-profile`. set the
  HDR CICP by hand or the result looks flat gray in HDR viewers:
  `--cicp-alternate 9/16/9`, base `1/13/1` (sRGB transfer is 13, not 1).
* the old "reconstruct a PQ alternate from the gain map + feed combine" path
  was dropped: it recomputed a gain map that could disagree with the authored
  one (and had headroom/resolution mismatch bugs).
* **libxml2-less builds**: `avifgainmaputil convert` / `avifenc` reading a
  *JPEG* gain map needs libxml2 at libavif build time; many Windows builds
  lack it and print "JPEG gainmap conversion unavailable because
  avifgainmaputil was not built with libxml2". reading/writing *AVIF* gain
  maps does NOT need libxml2. so the fallback that works everywhere: split
  the Ultra HDR JPEG in python (XMP + MPF, same parse as `ultrahdr.js`),
  `avifenc` base + gain map separately (plain JPEG reads need no libxml2),
  then repack both AV1 items into one AVIF with the container below.
  implemented in `tools/avif_gainmap.py` (auto-fallback on converter failure).
* **AVIF gain map container (libavif >= 1.3 / 'tmap' era, ISO 21496-1 +
  23008-12 amendment)**: items `1 av01 Color`, `2 tmap` (hidden=false),
  `3 av01 gain map` (infe flags=1 hidden). `tmap` item data = ToneMapImage:
  u8 version 0 + GainMapMetadata {u16 minimum_version 0, u16 writer_version 0,
  bits: is_multichannel(1) use_base_colour_space(1) reserved(6), u32x4
  base/alternate headroom n,d, then per channel (1 or 3): int32 min n, u32 d,
  int32 max n, u32 d, u32 gamma n,d, int32 base_offset n,d, int32
  alternate_offset n,d — all big endian}. `iref dimg tmap -> [color, gain]`,
  `grpl altr [tmap, color]` (group id must not collide with item ids),
  ftyp must carry the `tmap` brand, ipma: tmap gets base ispe + base pixi +
  a nclx colr with transfer 16 (PQ) and the base primaries/matrix. hdrgm
  mapping (mirror of libavif avifjpeg.c): CapacityMin/Max -> base/alternate
  headroom, OffsetSDR/HDR -> base/alternate offset, use_base_colour_space=1.
  verified against libavif main goldens + `avifgainmaputil printmetadata`.
  current libavif reads ONLY this format for AVIF (no legacy fallback).
* doubles -> n/d fractions: continued fractions as in libavif
  `avifDoubleToUnsignedFractionImpl` (max numerator UINT32_MAX for headrooms,
  INT32_MAX for signed fields); ported in `tools/avif_gainmap.py`.
* sandbox: no avifenc; `pip install pillow pillow-avif-plugin` gives real
  AV1 encode/decode for tests, but its bundled libavif predates 'tmap' and
  rejects the merged file — build current libavif from source instead
  (dav1d with `-Denable_asm=false` needs no nasm; aom from the
  `arthenica/libaom` GitHub mirror with `-DAOM_TARGET_CPU=generic`,
  googlesource is blocked).

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
  `node tests/node/wgsl.check.mjs` does this for every shader literal in the repo
  (it expands the `${...}` interpolations from a small table and skips itself if
  wgsl_reflect is not installed; `WGSL_REFLECT=/path/to/wgsl_reflect.module.js`
  points it at a copy outside the repo).
* app wiring: `tests/node/app.smoke.js` stubs document + WebGPU and drives a
  real save → parse → verify cycle. `tests/node/plugin.smoke.js` does the same for
  the drop-in plugin (fake DOM with a tiny innerHTML parser, patched
  `HTMLCanvasElement.prototype.getContext`, a stub swapchain readback) and asserts
  the status line, so a broken capture path fails in CI instead of in a browser.
* `exiftool` (independent MPF/XMP parser) runs from a tarball without root:
  `perl exiftool -G1 -n file.jpg`. tarball from the GitHub release mirror
  (`github.com/exiftool/exiftool/archive/refs/tags/…`) — exiftool.org is blocked.
* python: no root, so `python3 -m venv /tmp/venv` + pip inside it.
* `/tmp` is wiped between turns; keep only repo files, re-install tools per turn.
* github raw files: `curl -H "Accept: application/vnd.github.raw"
  https://api.github.com/repos/<repo>/git/blobs/<sha>` (raw host is blocked).

## drop-in hdr capture plugin (0.2)

* goal: `<script src="hdr-gainmap-plugin.js">` works in any canvas app, no build.
* **WebGPU HDR canvas readback** is the hard part: `getCurrentTexture()` returns a texture that is presented after `queue.submit()`. You cannot `copyTextureToTexture` after submit — it is already invalid. Solution: monkey-patch `HTMLCanvasElement.prototype.getContext` → wrap `configure` (store device) and `getCurrentTexture` (store lastTexture), then patch `device.queue.submit` to inject a `copyTextureToBuffer` into the same submit batch as the app's render. The copy buffer is then `mapAsync`'d and decoded from float16. This is generic and works for galaxy demo (ping-pong FBOs + present pass).
* **swapchain `usage` must include `COPY_SRC`.** Default `configure({})` usage is `RENDER_ATTACHMENT` only, so the injected `copyTextureToBuffer` fails with `usage (TextureUsage::RenderAttachment) doesn't include TextureUsage::CopySrc` (on Windows the texture is named `D3DImageBacking_D3DSharedImage_WebGPUSwapBufferProvider_…`). Fix: in the wrapped `configure`, OR `COPY_SRC | TEXTURE_BINDING` into `config.usage` before calling the original. Belt and suspenders: examples also pass `usage:` explicitly. Canvases configured *before* the plugin script ran keep the old usage — reload with the script in `<head>`; the submit patch reports this case instead of poisoning the whole submit batch.
* **never probe canvas type with `getContext('2d')`.** On a canvas with no context yet it *creates* a 2d context and steals the canvas — the app's later `getContext('webgpu')` then returns null and the HDR demo is dead. Instead record the type inside the patched `getContext` (`canvas._hdrCtxType = type`) and classify from that + `webgpuMap` without touching the canvas.
* **`layout:'auto'` drops unused WGSL bindings.** A declared-but-never-sampled `var samp: sampler` is eliminated, so `createBindGroup` with `{binding:1}` fails with `binding index 1 not present in the bind group layout` and poisons the whole command buffer (`Invalid BindGroup → Invalid CommandBuffer → Queue.Submit` cascade). Fix: delete unused declarations from the demo shader (or build an explicit `BindGroupLayout`). Verified in `examples/hdr-canvas-demo.html`.
* detection: scan `document.querySelectorAll('canvas')` every 2s + `MutationObserver` (skipping the plugin's own nodes); per-canvas type: `webgpuMap` format (`rgba16float` = hdr) else recorded `_hdrCtxType`, never a live `getContext` call. Skip `drawImage` thumbnails for any `webgpu*` canvas.
* **swapchain transfer function (calibration root cause).** `rgba16float` + `colorSpace:'srgb'` + `toneMapping:'extended'` holds *extended-sRGB* (OETF-encoded, range past 1.0): the spec interprets stored values in the canvas color space and the display applies the EOTF, so the shader must encode (`linearToSrgb`, extended past 1) — wgpu docs' "ExtendedSrgb" row and ccameron-chromium/webgpu-hdr ("converted to the color space of the screen") agree. Writing linear instead shows crushed mids + nuclear highlights with no error; starfields hide it (blacks stay black), which is why the upstream galaxy demo's "direct linear HDR values" comment is wrong. All repo demos now encode; `examples/hdr-canvas-demo.html` has a calibration strip (raw 0.25/0.5/0.75/1.0/2.0 patches + CSS twins that must match).
* **HDR editor pipeline (plugin).** Readback bytes are decoded extended-sRGB → linear once (`srgbToLinearData`), then: `fs_tonemap` (exposure × peak-preserving compress `H/sqrt(H²+peak²)` + clamp + sRGB encode → `sdrTex`) → `fs_hdr_to_gain` (exposure-aware HDR vs decoded base → recovery normalized by CPU-scanned content range) → `fs_apply` (exact decoder formula with weight from the headroom slider) → present. Preview = "this file on an H× display", so the headroom slider visibly dims/boosts; capacity metadata mirrors the content range (like Pixel files), peak/sdrWhite sliders are SDR-mode-only. Exposure is baked in tonemap/gain, so present runs as a second submit with exposure 0 (one UBO can't hold both). CPU save (`encodeFromHDR`) uses the identical formula with block-averaged gain, so preview == file.
* **UI state must exist before the UI is built.** `ensureProcessorUI()` builds the
  controls and the curve editor on the *first* capture, and the curve editor draws
  immediately — with `state.curvePoints` still `null` it threw
  `Cannot read properties of null (reading 'length')` inside `tangents()`, so the
  first click on either capture button always failed (later clicks "worked" but the
  curve editor was never initialised). Seed the curve + LUT at module scope
  (`setCurve(rampPoints(threshold))`), never on first capture.
  `tests/node/plugin.smoke.js` drives `captureSDR` / `captureHDR` against a stub DOM
  + WebGPU and reproduces exactly that stack trace when the seed is removed.
* **transfer function: measure, never assume.** "Do these two greys match?" is a
  useless question (observers disagree about which side is darker). Ask instead
  *which of two candidates vanishes*: put the CSS grey as a surround and draw two
  canvas patches inside it — `A = 0.5` (right if the swapchain is gamma-encoded)
  and `B = 0.216` (right if it is linear). Exactly one merges with the surround.
  `examples/hdr-selftest.html` Test 1 does this for 0.25 / 0.5 / 0.75. Until it is
  settled on real hardware, both demos and the plugin take `?linear=1` to present
  linear light instead of extended sRGB (the plugin also has a checkbox-free
  uniform, `P.c.z`), so flipping the assumption is one URL away, not a rewrite.
* **"HDR stopped working" triage.** `examples/hdr-selftest.html` writes fixed values
  (0.25…4.0) straight into the swapchain, next to CSS grey twins: patches vs twins =
  transfer function check, 1.25…4.0 vs 1.0 = is-this-display-HDR check, and the 0→4
  ramp shows where the display clips. It also prints `getConfiguration()`, the usage
  bits, `screen.highDynamicRangeHeadroom` and `(dynamic-range: high)`. Toggles cover
  tone mapping mode, color space, format and the exact usage flags the plugin forces;
  `?plugin=1` loads the plugin before the context exists. So "plugin vs shader vs
  display" is answered by looking, not guessing. In the demos the same A/B is
  `?hdrNoCopy=1` (plugin skips its `COPY_SRC | TEXTURE_BINDING` OR-in; capture dies,
  presentation is untouched).
* **tone mapping must not eat the SDR range.** `mapped = peak*H/sqrt(H²+peak²)`
  (plain Reinhard against the headroom) scales *every* pixel, so the whole picture
  dims a few percent and highlights never reach `H`; combined with the OETF fix it
  reads as "HDR is gone". Use a knee that is the identity below 1.0 and rolls only
  the excess into the headroom: `1 + (H-1)·e/(e + (H-1))`, `e = peak-1` (slope 1 at
  the join, asymptote `H`). Both demos use it now.
* **HDR needs content above 1.0, not a brighter tone map.** Once the OETF is applied
  correctly, a scene tuned for "linear straight into the swapchain" has almost
  nothing over SDR white (the old bug inflated everything: writing linear `v` used to
  display as `v^2.4`, so 4.0 became ~27×). Put the HDR where it belongs — a small
  core per star, a few pixels wide, several × SDR white — and keep the halo/sky
  inside SDR. The demos also default their tone-map target to
  `screen.highDynamicRangeHeadroom` instead of a hardcoded 4×.
* editor UI: sliders flagged `sdrOnly` (shadow/highlight/threshold/peak/sdrWhite) and the curve hide in HDR mode; HDR/SDR-base/gain view switcher works in both modes; slider input is rAF-coalesced (`requestRender`) and gain-scale rebuilds debounced.
* SDR snapshot: `createImageBitmap(canvas)` → offscreen 2D canvas `getImageData` → `queue.writeTexture` with 256-padded `bytesPerRow`. Avoids color-management surprises (same as `gpu.js`).
* SDR→HDR authoring reuses 0.1 tone model: curve `Y_sdr → t`, `log2gain = shadowLift + t*(highlightGain-shadowLift)`, `hdr = sdr * exp2(log2gain)`, `recovery = t`. No division by sdr, so no log(0).
* HDR→HDR “save as is”: HDR linear (after sRGB→linear decode if canvas is extended-sRGB) → exposure → tonemap to SDR via peak-preserving compress `mappedPeak = (peak*H)/sqrt(H*H+peak*peak)` (same as galaxy demo), then `logBoost = log2(luma(HDR)/luma(SDR))`, find min/max, `recovery = (logBoost-min)/(max-min)`. Gain map scale 1/4 by default.
* half float: `halfToFloat` and `floatToHalf` (simple, no subnormals) — enough for readback; `bytesPerRow` must be 256-aligned for `copyTextureToBuffer`.
* builder: minimal `buildUltraHDR` from `ultrahdr.js` bundled — byte-identical output verified.
* UI: injected CSS, floating button `#hdr-capture-btn`, panel `#hdr-plugin-panel` with canvas list (thumbnails via `drawImage`), editor with preview canvas (own WebGPU device, `rgba16float` + extended), curve editor (monotone spline from `curve.js`), sliders, histogram (optional). `file://` friendly.
* example usage: `examples/sdr-canvas-demo.html` (2D canvas), `examples/hdr-canvas-demo.html` (WebGPU HDR gradient), `examples/galaxy-hdr-capture.html` (mini galaxy + plugin). Real galaxy demo: just add `<script src="../hdr-gainmap-plugin.js"></script>` before `</body>` — no other changes.
