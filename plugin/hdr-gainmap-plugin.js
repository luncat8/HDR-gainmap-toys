// hdr-gainmap-plugin.js — drop-in HDR capture for any canvas project
// Single file, classic script, file:// friendly, no build.
// Provides globalThis.HDRGainmapPlugin
// Works with SDR canvas (2D/WebGL/WebGPU) → author HDR gainmap
// and HDR canvas (WebGPU rgba16float extended) → save as is or adjust.
//
// Usage:
//   <script src="hdr-gainmap-plugin.js"></script>
//   // auto-inits, adds floating button
//   // or: HDRGainmapPlugin.init({ autoButton: true, perCanvasButton: true })
//
(function (root) {
	'use strict';

	// ── 1. Ultra HDR builder (minimal from src/ultrahdr.js) ────────────────
	var XAP = 'http://ns.adobe.com/xap/1.0/\u0000';
	var HDRGM_NS = 'http://ns.adobe.com/hdr-gain-map/1.0/';

	function u8(n) { return new Uint8Array(n); }
	function concat(parts) {
		var total = 0, i;
		for (i = 0; i < parts.length; i++) total += parts[i].length;
		var out = u8(total), at = 0;
		for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
		return out;
	}
	function ascii(s) {
		var out = u8(s.length);
		for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
		return out;
	}
	function utf8(s) { return new TextEncoder().encode(s); }
	function f6(x) { return (Math.round(x * 1e6) / 1e6).toFixed(6); }

	function buildXMP(meta, withContainer) {
		var a = '   hdrgm:Version="1.0"\n';
		a += '   hdrgm:GainMapMin="' + f6(meta.gainMapMin) + '"\n';
		a += '   hdrgm:GainMapMax="' + f6(meta.gainMapMax) + '"\n';
		a += '   hdrgm:HDRCapacityMin="' + f6(meta.hdrCapacityMin) + '"\n';
		a += '   hdrgm:HDRCapacityMax="' + f6(meta.hdrCapacityMax) + '"\n';
		a += '   hdrgm:OffsetHDR="' + f6(meta.offsetHDR) + '"\n';
		a += '   hdrgm:OffsetSDR="' + f6(meta.offsetSDR) + '"';
		var ns = '    xmlns:hdrgm="' + HDRGM_NS + '"\n';
		var body;
		if (withContainer) {
			ns += '    xmlns:Container="http://ns.google.com/photos/1.0/container/"\n';
			ns += '    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"\n';
			body = '  <rdf:Description rdf:about=""\n' + ns + a + '>\n';
			body += '   <Container:Directory>\n    <rdf:Seq>\n';
			body += '     <rdf:li rdf:parseType="Resource">\n';
			body += '      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary"/>\n';
			body += '     </rdf:li>\n     <rdf:li rdf:parseType="Resource">\n';
			body += '      <Container:Item Item:Mime="image/jpeg" Item:Semantic="GainMap" Item:Length="' + meta.gainMapLength + '"/>\n';
			body += '     </rdf:li>\n    </rdf:Seq>\n   </Container:Directory>\n';
			body += '  </rdf:Description>\n';
		} else {
			body = '  <rdf:Description rdf:about=""\n' + ns + a + '/>\n';
		}
		return '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
			'<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 5.5.0">\n' +
			' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' + body +
			' </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>';
	}
	function xmpApp1(meta, withContainer) {
		var payload = concat([ascii(XAP), utf8(buildXMP(meta, withContainer))]);
		var seg = u8(2 + 2 + payload.length);
		seg[0] = 0xff; seg[1] = 0xe1;
		seg[2] = ((payload.length + 2) >> 8) & 0xff; seg[3] = (payload.length + 2) & 0xff;
		seg.set(payload, 4);
		return seg;
	}
	function u32le(v) { return u8([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]); }
	function putEntry(data, p, tag, type, count, value) {
		data[p] = tag & 0xff; data[p + 1] = (tag >> 8) & 0xff;
		data[p + 2] = type & 0xff; data[p + 3] = (type >> 8) & 0xff;
		data.set(u32le(count), p + 4); data.set(value, p + 8);
		return p + 12;
	}
	function mpfApp2() {
		var data = u8(86);
		data.set(ascii('MPF\u0000'), 0);
		data.set(ascii('II'), 4); data[6] = 42; data[7] = 0; data[8] = 8; data[9] = 0; data[10] = 0; data[11] = 0;
		var p = 12; data[p] = 3; p += 2;
		p = putEntry(data, p, 0xb000, 7, 4, ascii('0100'));
		p = putEntry(data, p, 0xb001, 4, 1, u32le(2));
		p = putEntry(data, p, 0xb002, 7, 32, u32le(50));
		data.set(u32le(0), p); p += 4;
		data.set(u32le(0x00030000), p); data.set(u32le(0), p + 4); data.set(u32le(0), p + 8); data.set(u32le(0x00000000), p + 12); data.set(u32le(0), p + 16); data.set(u32le(0), p + 20);
		var seg = u8(2 + 2 + data.length);
		seg[0] = 0xff; seg[1] = 0xe2; seg[2] = ((data.length + 2) >> 8) & 0xff; seg[3] = (data.length + 2) & 0xff; seg.set(data, 4);
		return seg;
	}
	function patchMPF(b, mpfStart, primarySize, secondarySize, secondaryOffset) {
		var list = mpfStart + 8 + 50;
		b.set(u32le(primarySize), list + 4);
		b.set(u32le(secondarySize), list + 16 + 4);
		b.set(u32le(secondaryOffset), list + 16 + 8);
	}
	function buildUltraHDR(base, gainmap, meta) {
		if (base[0] !== 0xff || base[1] !== 0xd8) throw new Error('base not JPEG');
		if (gainmap[0] !== 0xff || gainmap[1] !== 0xd8) throw new Error('gain not JPEG');
		var m = { gainMapMin: meta.gainMapMin || 0, gainMapMax: meta.gainMapMax || 1, hdrCapacityMin: meta.hdrCapacityMin || 0, hdrCapacityMax: meta.hdrCapacityMax || 1, offsetSDR: 0, offsetHDR: 0, gamma: 1 };
		var xmpGain = xmpApp1(m, false);
		var gainOut = concat([gainmap.subarray(0, 2), xmpGain, gainmap.subarray(2)]);
		m = { gainMapMin: m.gainMapMin, gainMapMax: m.gainMapMax, hdrCapacityMin: m.hdrCapacityMin, hdrCapacityMax: m.hdrCapacityMax, offsetSDR: 0, offsetHDR: 0, gamma: 1, gainMapLength: gainOut.length };
		var xmpBase = xmpApp1(m, true);
		var mpf = mpfApp2();
		var head = concat([base.subarray(0, 2), xmpBase, mpf, base.subarray(2)]);
		var primarySize = head.length;
		var tiffOffset = 2 + xmpBase.length + 2 + 2 + 4;
		patchMPF(head, 2 + xmpBase.length, primarySize, gainOut.length, primarySize - tiffOffset);
		return { bytes: concat([head, gainOut]), meta: m, primarySize: primarySize, gainMapLength: gainOut.length };
	}

	// ── 2. color + half utils ──────────────────────────────────────────────
	function halfToFloat(h) {
		var s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
		if (e === 0) return s * f * 5.9604644775390625e-8;
		if (e === 31) return f ? NaN : s * Infinity;
		return s * (f + 1024) * Math.pow(2, e - 25);
	}
	function srgbToLinear(c) {
		if (c <= 0.04045) return c / 12.92;
		return Math.pow((c + 0.055) / 1.055, 2.4);
	}
	function linearToSrgb(c) {
		c = Math.max(0, c);
		if (c <= 0.0031308) return c * 12.92;
		return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
	}
	function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

	// ── 3. WebGPU HDR capture patch ────────────────────────────────────────
	var webgpuMap = new Map(); // canvas -> info
	var deviceMap = new Map(); // device -> Set(canvas)
	var origGetContext = null;

	function ensurePatch() {
		if (origGetContext) return;
		if (!HTMLCanvasElement || !HTMLCanvasElement.prototype.getContext) return;
		origGetContext = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function (type, opts) {
			var ctx = origGetContext.call(this, type, opts);
			if (type === 'webgpu' && ctx) {
				wrapContext(this, ctx);
			}
			return ctx;
		};
	}

	function wrapContext(canvas, ctx) {
		if (ctx._hdrPatched) return;
		ctx._hdrPatched = true;
		var origConfigure = ctx.configure.bind(ctx);
		ctx.configure = function (config) {
			var info = webgpuMap.get(canvas);
			if (!info) {
				info = { canvas: canvas, context: ctx, device: config.device, format: config.format, lastTexture: null, width: 0, height: 0, pending: null, colorSpace: config.colorSpace, toneMapping: config.toneMapping };
				webgpuMap.set(canvas, info);
			} else {
				info.device = config.device;
				info.format = config.format;
				info.context = ctx;
			}
			var set = deviceMap.get(config.device);
			if (!set) { set = new Set(); deviceMap.set(config.device, set); }
			set.add(canvas);
			patchDevice(config.device);
			return origConfigure(config);
		};
		var origGetCurrent = ctx.getCurrentTexture.bind(ctx);
		ctx.getCurrentTexture = function () {
			var tex = origGetCurrent();
			var info = webgpuMap.get(canvas);
			if (info) {
				info.lastTexture = tex;
				info.width = tex.width;
				info.height = tex.height;
			}
			return tex;
		};
	}

	function patchDevice(device) {
		if (!device || device._hdrQueuePatched) return;
		device._hdrQueuePatched = true;
		var origSubmit = device.queue.submit.bind(device.queue);
		device.queue.submit = function (commandBuffers) {
			var canvases = deviceMap.get(device);
			var pendingList = [];
			if (canvases) {
				canvases.forEach(function (c) {
					var info = webgpuMap.get(c);
					if (info && info.pending && info.lastTexture) pendingList.push(info);
				});
			}
			if (pendingList.length) {
				var copyEnc = device.createCommandEncoder();
				for (var i = 0; i < pendingList.length; i++) {
					var info = pendingList[i];
					var w = info.width, h = info.height;
					if (w <= 0 || h <= 0) continue;
					var bpp = 8;
					var row = w * bpp;
					var padded = Math.ceil(row / 256) * 256;
					var buf = device.createBuffer({ size: padded * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
					copyEnc.copyTextureToBuffer({ texture: info.lastTexture }, { buffer: buf, bytesPerRow: padded, rowsPerImage: h }, { width: w, height: h });
					info.pending.buffer = buf;
					info.pending.bytesPerRow = padded;
					info.pending.width = w;
					info.pending.height = h;
					info.pending._info = info;
				}
				var copyCB = copyEnc.finish();
				var all = [];
				for (var j = 0; j < commandBuffers.length; j++) all.push(commandBuffers[j]);
				all.push(copyCB);
				var res = origSubmit(all);
				// async resolve after submit
				for (var k = 0; k < pendingList.length; k++) {
					(function (info) {
						var p = info.pending;
						if (!p) return;
						info.pending = null;
						// map async
						p.buffer.mapAsync(GPUMapMode.READ).then(function () {
							var raw = new Uint8Array(p.buffer.getMappedRange().slice(0));
							p.buffer.unmap(); p.buffer.destroy();
							var out = decodeHalfBuffer(raw, p.width, p.height, p.bytesPerRow);
							if (p.resolve) p.resolve(out);
						}).catch(function (e) { if (p.reject) p.reject(e); });
					})(pendingList[k]);
				}
				return res;
			}
			return origSubmit(commandBuffers);
		};
	}

	function decodeHalfBuffer(raw, w, h, padded) {
		var bpp = 8;
		var rowBytes = w * bpp;
		var u16;
		var out = new Float32Array(w * h * 4);
		if (padded === rowBytes) {
			u16 = new Uint16Array(raw.buffer, raw.byteOffset, w * h * 4);
			for (var i = 0; i < out.length; i++) out[i] = halfToFloat(u16[i]);
		} else {
			u16 = new Uint16Array(w * h * 4);
			var idx = 0;
			for (var y = 0; y < h; y++) {
				var rowStart = y * padded;
				var rowU16 = new Uint16Array(raw.buffer, raw.byteOffset + rowStart, w * 4);
				for (var x = 0; x < w * 4; x++) u16[idx++] = rowU16[x];
			}
			for (var j = 0; j < out.length; j++) out[j] = halfToFloat(u16[j]);
		}
		return { data: out, width: w, height: h };
	}

	function requestHDRReadback(canvas) {
		return new Promise(function (resolve, reject) {
			var info = webgpuMap.get(canvas);
			if (!info || !info.device) { reject(new Error('canvas not WebGPU HDR')); return; }
			info.pending = { resolve: resolve, reject: reject, buffer: null };
			// will be resolved on next submit; if no frame, timeout
			setTimeout(function () {
				if (info.pending && info.pending.resolve === resolve) {
					info.pending = null;
					reject(new Error('HDR readback timeout — no frame submitted'));
				}
			}, 2000);
		});
	}

	// ── 4. Processor (SDR→HDR) ─────────────────────────────────────────────
	var LUT_SAMPLES = 64;
	var processor = null;

	function createProcessor() {
		if (processor) return Promise.resolve(processor);
		return (async function () {
			if (!navigator.gpu) throw new Error('WebGPU not available');
			var adapter = await navigator.gpu.requestAdapter();
			if (!adapter) throw new Error('no adapter');
			var device = await adapter.requestDevice();
			var module = device.createShaderModule({ code: wgslCode() });
			var layout = device.createBindGroupLayout({
				entries: [
					{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
					{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
					{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
					{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
				]
			});
			var pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
			function pipe(entry, fmt) {
				return device.createRenderPipeline({
					layout: pl,
					vertex: { module: module, entryPoint: 'vs' },
					fragment: { module: module, entryPoint: entry, targets: [{ format: fmt }] },
					primitive: { topology: 'triangle-list' }
				});
			}
			var gainPipe = pipe('fs_gain', 'rgba8unorm');
			var applyPipe = pipe('fs_apply', 'rgba16float');
			var presentPipe = pipe('fs_present', 'rgba16float');
			var histPipe = pipe('fs_hist', 'rgba16float');
			var hdrToGainPipe = pipe('fs_hdr_to_gain', 'rgba8unorm');
			var samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
			var uboSize = (12 + LUT_SAMPLES) * 4;
			var ubo = device.createBuffer({ size: uboSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
			var params = new Float32Array(12 + LUT_SAMPLES);
			processor = { device: device, module: module, layout: layout, gainPipe: gainPipe, applyPipe: applyPipe, presentPipe: presentPipe, histPipe: histPipe, hdrToGainPipe: hdrToGainPipe, sampler: samp, ubo: ubo, params: params, lut: new Float32Array(LUT_SAMPLES) };
			return processor;
		})();
	}

	function wgslCode() {
		return `
struct Params {
  a : vec4f,
  b : vec4f,
  c : vec4f,
  lut : array<vec4f, 16>,
};
@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var tex0 : texture_2d<f32>;
@group(0) @binding(3) var tex1 : texture_2d<f32>;
struct VSOut { @builtin(position) pos : vec4f, @location(0) uv : vec2f, };
@vertex fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out : VSOut; out.pos = vec4f(corners[i], 0.0, 1.0); out.uv = vec2f(corners[i].x*0.5+0.5, 0.5-corners[i].y*0.5); return out;
}
fn srgbToLinear(c : vec3f) -> vec3f { let lo = c/12.92; let hi = pow((c+0.055)/1.055, vec3f(2.4)); return select(hi, lo, c <= vec3f(0.04045)); }
fn linearToSrgb(c : vec3f) -> vec3f { let x = max(c, vec3f(0.0)); let lo = x*12.92; let hi = 1.055*pow(x, vec3f(1.0/2.4))-0.055; return select(hi, lo, x <= vec3f(0.0031308)); }
fn luma(c : vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn curve(y : f32) -> f32 {
  let t = clamp(y, 0.0, 1.0) * ${ (LUT_SAMPLES - 1).toFixed(1) };
  let i = i32(floor(t)); let i0 = clamp(i, 0, ${LUT_SAMPLES - 1}); let i1 = clamp(i+1, 0, ${LUT_SAMPLES - 1});
  let v0 = P.lut[i0/4][i0%4]; let v1 = P.lut[i1/4][i1%4]; return mix(v0, v1, t-floor(t));
}
fn weight() -> f32 {
  let span = P.a.w - P.a.z; if (span <= 0.0) { return select(0.0, 1.0, P.b.y >= P.a.w); } return clamp((P.b.y - P.a.z)/span, 0.0, 1.0);
}
@fragment fn fs_gain(in : VSOut) -> @location(0) vec4f {
  let scale = P.b.w; let taps = i32(min(scale, 4.0)); let foot = vec2f(scale/P.c.x, scale/P.c.y); var sum = 0.0;
  for (var j=0;j<taps;j=j+1){ for (var i=0;i<taps;i=i+1){ let o=(vec2f(f32(i),f32(j))+0.5)/f32(taps)-vec2f(0.5); let c=textureSampleLevel(tex0,samp,in.uv+o*foot,0.0); sum=sum+luma(srgbToLinear(c.rgb)); } }
  let r = curve(sum/f32(taps*taps)); return vec4f(r,r,r,1.0);
}
@fragment fn fs_apply(in : VSOut) -> @location(0) vec4f {
  let sdr = srgbToLinear(textureSampleLevel(tex0,samp,in.uv,0.0).rgb); let rec = textureSampleLevel(tex1,samp,in.uv,0.0).r; let logBoost = mix(P.a.x, P.a.y, rec); let g = exp2(logBoost*weight()); return vec4f(max(sdr*g, vec3f(0.0)), 1.0);
}
@fragment fn fs_present(in : VSOut) -> @location(0) vec4f {
  let c = textureSampleLevel(tex0,samp,in.uv,0.0); if (P.b.z > 2.5) { return vec4f(c.rgb, 1.0); } let scale = exp2(P.b.x); let rgb = select(c.rgb, vec3f(c.r), P.b.z > 1.5); return vec4f(linearToSrgb(rgb*scale), 1.0);
}
@fragment fn fs_hist(in : VSOut) -> @location(0) vec4f {
  let a = srgbToLinear(textureSampleLevel(tex0,samp,in.uv,0.0).rgb); let b = textureSampleLevel(tex1,samp,in.uv,0.0).rgb; return vec4f(log2(max(luma(a),1e-6)), log2(max(luma(b),1e-6)), 0.0, 1.0);
}
@fragment fn fs_hdr_to_gain(in : VSOut) -> @location(0) vec4f {
  let hdr = textureSampleLevel(tex0,samp,in.uv,0.0).rgb;
  let sdr = textureSampleLevel(tex1,samp,in.uv,0.0).rgb;
  let lh = max(luma(hdr), 1e-6); let ls = max(luma(sdr), 1e-6);
  let logBoost = log2(lh/ls);
  let norm = clamp((logBoost - P.a.x)/(P.a.y - P.a.x), 0.0, 1.0);
  return vec4f(norm, norm, norm, 1.0);
}
`;
	}

	// ── 5. Curve ───────────────────────────────────────────────────────────
	var PRESETS = {
		linear: [[0, 0], [1, 1]],
		highlights: [[0, 0], [0.55, 0.05], [0.85, 0.5], [1, 1]],
		shadows: [[0, 1], [0.25, 0.45], [0.6, 0.05], [1, 0]],
		scurve: [[0, 0], [0.25, 0.08], [0.5, 0.35], [0.75, 0.72], [1, 1]],
		flat: [[0, 0.5], [1, 0.5]]
	};
	function rampPoints(th) { th = Math.min(0.99, Math.max(0.01, th)); return [[0, 0], [th, 0], [1, 1]]; }
	function tangents(pts) {
		var n = pts.length, dx = [], slope = [], t = new Array(n), i;
		for (i = 0; i < n - 1; i++) { dx[i] = Math.max(1e-6, pts[i + 1][0] - pts[i][0]); slope[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
		t[0] = slope[0]; t[n - 1] = slope[n - 2];
		for (i = 1; i < n - 1; i++) {
			if (slope[i - 1] * slope[i] <= 0) { t[i] = 0; continue; }
			var w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
			t[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
		}
		return t;
	}
	function evalAt(pts, t, x) {
		if (x <= pts[0][0]) return pts[0][1];
		var last = pts.length - 1;
		if (x >= pts[last][0]) return pts[last][1];
		var i = 0; while (i < last - 1 && pts[i + 1][0] < x) i++;
		var h = pts[i + 1][0] - pts[i][0]; var s = (x - pts[i][0]) / h; var s2 = s * s, s3 = s2 * s;
		var h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
		return h00 * pts[i][1] + h10 * h * t[i] + h01 * pts[i + 1][1] + h11 * h * t[i + 1];
	}
	function sampleCurve(points, count) {
		var t = tangents(points); var out = new Float32Array(count);
		for (var i = 0; i < count; i++) { var x = i / (count - 1); out[i] = Math.min(1, Math.max(0, evalAt(points, t, x))); }
		return out;
	}

	// ── 6. UI + main logic ─────────────────────────────────────────────────
	var uiRoot = null, panel = null, listEl = null, editorEl = null;
	var canvases = [];
	var selected = null;
	var state = {
		sourceCanvas: null,
		sourceType: 'sdr',
		srcW: 0, srcH: 0,
		hdrData: null,
		params: { peakNits: 1000, sdrWhite: 203, shadowLift: 0, highlightGain: 2, threshold: 0.55, gainScale: 4, exposure: 0, headroom: 4, baseQuality: 92, gainQuality: 85 },
		curvePoints: null,
		lut: null,
		lutMin: 0, lutMax: 1,
		view: 'hdr'
	};
	var gpuProc = null, srcTex = null, gainTex = null, hdrTex = null, fileBaseTex = null, fileGainTex = null;
	var gainW = 0, gainH = 0, ubo = null, samp = null, gainPipe = null, applyPipe = null, presentPipe = null, histPipe = null, hdrToGainPipe = null;
	var bgGain = null, bgApply = null, bgPresent = null, bgGainView = null, bgHist = null, bgBase = null, bgLayout = null;
	var histTex = null, canvasEl = null, histEl = null, curveCanvas = null, statusEl = null;
	var curveEditor = null;

	function injectCSS() {
		if (document.getElementById('hdr-plugin-style')) return;
		var style = document.createElement('style');
		style.id = 'hdr-plugin-style';
		style.textContent = `
#hdr-capture-btn{position:fixed;right:18px;bottom:18px;z-index:99999;background:#0b0d12;color:#dfe6f0;border:1px solid #232936;border-radius:10px;padding:10px 14px;font:13px system-ui;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,0.5)}
#hdr-capture-btn:hover{border-color:#7fd4ff}
#hdr-plugin-panel{position:fixed;right:18px;bottom:62px;z-index:99999;width:380px;max-height:85vh;overflow:auto;background:#14171f;color:#dfe6f0;border:1px solid #232936;border-radius:12px;padding:12px;font:12px system-ui;box-shadow:0 20px 60px rgba(0,0,0,0.6)}
#hdr-plugin-panel.hidden{display:none}
#hdr-plugin-panel h3{margin:8px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:#8b95a6}
#hdr-plugin-panel .row{display:grid;grid-template-columns:96px 1fr 60px;gap:6px;align-items:center;padding:3px 0}
#hdr-plugin-panel .row .label{color:#8b95a6}
#hdr-plugin-panel .row .value{text-align:right;font-variant-numeric:tabular-nums}
#hdr-plugin-panel input[type=range]{width:100%;accent-color:#7fd4ff}
#hdr-plugin-panel button{background:#1b202b;color:#dfe6f0;border:1px solid #232936;border-radius:6px;padding:5px 10px;font:inherit;cursor:pointer;margin:2px}
#hdr-plugin-panel button:hover{border-color:#7fd4ff}
#hdr-plugin-panel canvas{width:100%;border:1px solid #232936;border-radius:6px;background:#0e1117}
#hdr-plugin-panel .canvas-list{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto}
#hdr-plugin-panel .canvas-item{display:flex;gap:8px;align-items:center;padding:6px;border:1px solid #232936;border-radius:6px;background:#0e1117;cursor:pointer}
#hdr-plugin-panel .canvas-item.selected{border-color:#7fd4ff}
#hdr-plugin-panel .canvas-item img{width:48px;height:32px;object-fit:cover;background:#000;border-radius:4px}
#hdr-plugin-panel .per-canvas-btn{position:absolute;z-index:99998;background:rgba(11,13,18,0.9);color:#dfe6f0;border:1px solid #7fd4ff;border-radius:6px;padding:4px 8px;font:11px system-ui;cursor:pointer;transform:translate(-50%,-100%);margin-top:-8px}
`;
		document.head.appendChild(style);
	}

	function createUI() {
		injectCSS();
		if (uiRoot) return;
		uiRoot = document.createElement('div');
		document.body.appendChild(uiRoot);
		var btn = document.createElement('button');
		btn.id = 'hdr-capture-btn';
		btn.textContent = 'HDR 📸';
		btn.title = 'HDR gainmap capture';
		uiRoot.appendChild(btn);
		panel = document.createElement('div');
		panel.id = 'hdr-plugin-panel';
		panel.className = 'hidden';
		panel.innerHTML = `
<h3>Detected canvases</h3>
<div class="canvas-list" id="hdr-canvas-list"></div>
<div id="hdr-editor" class="hidden">
<h3>Editor</h3>
<div id="hdr-preview-wrap" style="background:#000;border-radius:8px;overflow:hidden"><canvas id="hdr-preview" style="width:100%;display:block"></canvas></div>
<canvas id="hdr-histo" height="90"></canvas>
<canvas id="hdr-curve" width="300" height="160"></canvas>
<div id="hdr-controls"></div>
<div style="display:flex;gap:6px;margin-top:8px">
<button id="hdr-save">Save UltraHDR JPEG</button>
<button id="hdr-export">Export pair</button>
<button id="hdr-close-editor">Close</button>
</div>
<div id="hdr-status" style="color:#8b95a6;margin-top:6px;font-size:11px"></div>
</div>
`;
		uiRoot.appendChild(panel);
		listEl = panel.querySelector('#hdr-canvas-list');
		editorEl = panel.querySelector('#hdr-editor');
		canvasEl = panel.querySelector('#hdr-preview');
		histEl = panel.querySelector('#hdr-histo');
		curveCanvas = panel.querySelector('#hdr-curve');
		statusEl = panel.querySelector('#hdr-status');

		btn.addEventListener('click', function () { panel.classList.toggle('hidden'); refreshList(); });
		panel.querySelector('#hdr-close-editor').addEventListener('click', function () { editorEl.classList.add('hidden'); });
		panel.querySelector('#hdr-save').addEventListener('click', save);
		panel.querySelector('#hdr-export').addEventListener('click', exportPair);
	}

	function refreshList() {
		if (!listEl) return;
		listEl.innerHTML = '';
		var all = document.querySelectorAll('canvas');
		canvases = [];
		for (var i = 0; i < all.length; i++) {
			var c = all[i];
			if (c.width === 0 || c.height === 0) continue;
			var info = webgpuMap.get(c);
			var type = info ? (info.format === 'rgba16float' ? 'webgpu-hdr' : 'webgpu-sdr') : (c.getContext('2d') ? '2d' : 'unknown');
			// try to detect HDR via format
			canvases.push({ el: c, type: type, info: info });
			var item = document.createElement('div');
			item.className = 'canvas-item' + (selected && selected.el === c ? ' selected' : '');
			var thumb = document.createElement('canvas'); thumb.width = 48; thumb.height = 32;
			try { thumb.getContext('2d').drawImage(c, 0, 0, 48, 32); } catch (e) {}
			item.appendChild(thumb);
			var meta = document.createElement('div');
			meta.innerHTML = '<div style="font-weight:600">' + (c.id || 'canvas ' + i) + '</div><div style="color:#8b95a6">' + c.width + '×' + c.height + ' · ' + type + '</div>';
			item.appendChild(meta);
			var actions = document.createElement('div'); actions.style.marginLeft = 'auto'; actions.style.display = 'flex'; actions.style.flexDirection = 'column'; actions.style.gap = '4px';
			var b1 = document.createElement('button'); b1.textContent = 'SDR→HDR'; b1.title = 'Capture as SDR and author HDR';
			var b2 = document.createElement('button'); b2.textContent = 'HDR→Save'; b2.title = 'Capture HDR content and save';
			(function (canvas, tp) {
				b1.addEventListener('click', function (e) { e.stopPropagation(); captureSDR(canvas); });
				b2.addEventListener('click', function (e) { e.stopPropagation(); captureHDR(canvas); });
			})(c, type);
			actions.appendChild(b1); actions.appendChild(b2);
			item.appendChild(actions);
			item.addEventListener('click', (function (cc) { return function () { selected = { el: cc }; refreshList(); }; })(c));
			listEl.appendChild(item);
		}
		if (canvases.length === 0) listEl.textContent = 'No canvases found';
	}

	function setStatus(t) { if (statusEl) statusEl.textContent = t; }

	// ── capture SDR ────────────────────────────────────────────────────────
	async function captureSDR(canvas) {
		try {
			ensureProcessorUI();
			var bitmap;
			try { bitmap = await createImageBitmap(canvas); } catch (e) { bitmap = canvas; }
			state.sourceCanvas = canvas;
			state.sourceType = 'sdr';
			state.srcW = bitmap.width || canvas.width;
			state.srcH = bitmap.height || canvas.height;
			state.hdrData = null;
			state.curvePoints = rampPoints(state.params.threshold);
			refreshLUT();
			await initProcessorForSource(bitmap);
			editorEl.classList.remove('hidden');
			panel.classList.remove('hidden');
			render();
			setStatus('SDR captured ' + state.srcW + '×' + state.srcH);
		} catch (e) { setStatus('SDR capture failed: ' + e.message); console.error(e); }
	}

	// ── capture HDR ────────────────────────────────────────────────────────
	async function captureHDR(canvas) {
		try {
			ensureProcessorUI();
			setStatus('Capturing HDR frame… (next frame)');
			var data;
			if (webgpuMap.has(canvas)) {
				data = await requestHDRReadback(canvas);
			} else {
				// fallback: try to read as SDR and treat as HDR with exposure
				var bitmap = await createImageBitmap(canvas);
				state.sourceCanvas = canvas;
				state.sourceType = 'sdr';
				state.srcW = bitmap.width; state.srcH = bitmap.height;
				state.curvePoints = rampPoints(state.params.threshold);
				refreshLUT();
				await initProcessorForSource(bitmap);
				editorEl.classList.remove('hidden');
				panel.classList.remove('hidden');
				render();
				setStatus('Canvas not WebGPU HDR, treated as SDR');
				return;
			}
			// data: { data: Float32Array rgba, width, height }
			state.sourceCanvas = canvas;
			state.sourceType = 'hdr';
			state.srcW = data.width;
			state.srcH = data.height;
			state.hdrData = data;
			state.curvePoints = rampPoints(state.params.threshold);
			refreshLUT();
			await initProcessorForHDR(data);
			editorEl.classList.remove('hidden');
			panel.classList.remove('hidden');
			renderHDR();
			setStatus('HDR captured ' + data.width + '×' + data.height + ' — max ' + maxHDR(data.data).toFixed(2));
		} catch (e) { setStatus('HDR capture failed: ' + e.message); console.error(e); }
	}

	function maxHDR(arr) {
		var m = 0;
		for (var i = 0; i < arr.length; i += 4) { var v = Math.max(arr[i], arr[i + 1], arr[i + 2]); if (v > m) m = v; }
		return m;
	}

	// ── processor init ─────────────────────────────────────────────────────
	async function ensureProcessorUI() {
		if (!gpuProc) {
			gpuProc = await createProcessor();
			// init UI controls once
			buildControls();
			initCurveEditor();
		}
	}

	async function initProcessorForSource(source) {
		var proc = gpuProc;
		var device = proc.device;
		if (srcTex) srcTex.destroy();
		var gs = gainSize();
		gainW = gs[0]; gainH = gs[1];
		srcTex = device.createTexture({ size: [state.srcW, state.srcH], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
		gainTex = device.createTexture({ size: [gainW, gainH], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
		hdrTex = device.createTexture({ size: [state.srcW, state.srcH], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
		histTex = device.createTexture({ size: [192, 108], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
		// upload source
		await uploadSource(device, srcTex, source, state.srcW, state.srcH);
		// pipelines already created
		var layout = proc.layout;
		function bg(t0, t1) {
			return device.createBindGroup({ layout: layout, entries: [{ binding: 0, resource: { buffer: proc.ubo } }, { binding: 1, resource: proc.sampler }, { binding: 2, resource: t0.createView() }, { binding: 3, resource: t1.createView() }] });
		}
		bgGain = bg(srcTex, srcTex);
		bgApply = bg(srcTex, gainTex);
		bgPresent = bg(hdrTex, hdrTex);
		bgGainView = bg(gainTex, gainTex);
		bgBase = bg(srcTex, srcTex);
		bgHist = bg(srcTex, hdrTex);
		// configure preview canvas
		var ctx = canvasEl.getContext('webgpu');
		if (!ctx._hdrConfigured) {
			ctx.configure({ device: device, format: 'rgba16float', colorSpace: 'srgb', toneMapping: { mode: 'extended' }, alphaMode: 'opaque' });
			ctx._hdrConfigured = true;
		}
	}

	async function initProcessorForHDR(hdrData) {
		var proc = gpuProc;
		var device = proc.device;
		if (srcTex) srcTex.destroy();
		if (gainTex) gainTex.destroy();
		if (hdrTex) hdrTex.destroy();
		srcTex = device.createTexture({ size: [state.srcW, state.srcH], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
		gainTex = device.createTexture({ size: [state.srcW, state.srcH], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
		hdrTex = device.createTexture({ size: [state.srcW, state.srcH], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
		// upload HDR data as rgba16float via writeTexture with float32? need to convert to half? Simpler: upload as rgba8? Actually we have float32 data, we can write via buffer with rgba16float texture using writeTexture expects bytes. We'll convert to half first.
		var half = floatToHalfArray(hdrData.data);
		var padded = Math.ceil(state.srcW * 8 / 256) * 256;
		var bytes;
		if (padded === state.srcW * 8) bytes = new Uint8Array(half.buffer);
		else {
			bytes = new Uint8Array(padded * state.srcH);
			for (var y = 0; y < state.srcH; y++) {
				bytes.set(new Uint8Array(half.buffer, y * state.srcW * 8, state.srcW * 8), y * padded);
			}
		}
		device.queue.writeTexture({ texture: srcTex }, bytes, { bytesPerRow: padded, rowsPerImage: state.srcH }, { width: state.srcW, height: state.srcH });
		var layout = proc.layout;
		function bg(t0, t1) { return device.createBindGroup({ layout: layout, entries: [{ binding: 0, resource: { buffer: proc.ubo } }, { binding: 1, resource: proc.sampler }, { binding: 2, resource: t0.createView() }, { binding: 3, resource: t1.createView() }] }); }
		bgGain = bg(srcTex, srcTex);
		bgApply = bg(srcTex, gainTex);
		bgPresent = bg(hdrTex, hdrTex);
		bgGainView = bg(gainTex, gainTex);
		bgBase = bg(srcTex, srcTex);
		bgHist = bg(srcTex, hdrTex);
		var ctx = canvasEl.getContext('webgpu');
		if (!ctx._hdrConfigured) {
			ctx.configure({ device: device, format: 'rgba16float', colorSpace: 'srgb', toneMapping: { mode: 'extended' }, alphaMode: 'opaque' });
			ctx._hdrConfigured = true;
		}
	}

	function floatToHalfArray(f32) {
		var out = new Uint16Array(f32.length);
		for (var i = 0; i < f32.length; i++) out[i] = floatToHalf(f32[i]);
		return out;
	}
	function floatToHalf(v) {
		// simple conversion, from https://stackoverflow.com/a/6162687
		var f32 = new Float32Array(1); f32[0] = v;
		var u32 = new Uint32Array(f32.buffer)[0];
		var sign = (u32 >> 31) & 0x1;
		var exp = (u32 >> 23) & 0xff;
		var frac = u32 & 0x7fffff;
		var hExp, hFrac;
		if (exp === 0) { hExp = 0; hFrac = 0; }
		else if (exp === 0xff) { hExp = 31; hFrac = frac ? 0x200 : 0; }
		else {
			var newExp = exp - 127 + 15;
			if (newExp >= 31) { hExp = 31; hFrac = 0; }
			else if (newExp <= 0) { hExp = 0; hFrac = 0; }
			else { hExp = newExp; hFrac = frac >> 13; }
		}
		return (sign << 15) | (hExp << 10) | hFrac;
	}

	async function uploadSource(device, tex, source, w, h) {
		// source is ImageBitmap or canvas
		var c = document.createElement('canvas'); c.width = w; c.height = h;
		var ctx = c.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(source, 0, 0, w, h);
		var data = ctx.getImageData(0, 0, w, h).data;
		var row = w * 4;
		var padded = Math.ceil(row / 256) * 256;
		var bytes;
		if (padded === row) bytes = data;
		else {
			bytes = new Uint8Array(padded * h);
			for (var y = 0; y < h; y++) bytes.set(data.subarray(y * row, y * row + row), y * padded);
		}
		device.queue.writeTexture({ texture: tex }, bytes, { bytesPerRow: padded, rowsPerImage: h }, { width: w, height: h });
	}

	function gainSize() {
		var s = state.params.gainScale;
		return [Math.max(1, Math.ceil(state.srcW / s)), Math.max(1, Math.ceil(state.srcH / s))];
	}
	function capacityMax() { return Math.log2(state.params.peakNits / state.params.sdrWhite); }
	function minStops() { return state.params.shadowLift; }
	function maxStops() {
		var cap = capacityMax(); var lo = minStops() + 0.01;
		return Math.min(cap, Math.max(lo, state.params.highlightGain));
	}
	function rangeMin() { return minStops() + state.lutMin * (maxStops() - minStops()); }
	function rangeMax() { return minStops() + state.lutMax * (maxStops() - minStops()); }
	function capacityMin() { return Math.max(rangeMin(), 0); }

	function writeParams(p) {
		var proc = gpuProc;
		proc.params[0] = p.rangeMin; proc.params[1] = p.rangeMax; proc.params[2] = p.capacityMin; proc.params[3] = p.capacityMax;
		proc.params[4] = p.exposure; proc.params[5] = Math.log2(p.headroom); proc.params[6] = p.mode; proc.params[7] = p.gainScale;
		proc.params[8] = state.srcW; proc.params[9] = state.srcH; proc.params[10] = gainW; proc.params[11] = gainH;
		proc.params.set(state.lut, 12);
		proc.device.queue.writeBuffer(proc.ubo, 0, proc.params);
	}

	var MODES = { hdr: 0, sdr: 3, gain: 2 };

	function render() {
		if (!gpuProc || !srcTex) return;
		var proc = gpuProc;
		var device = proc.device;
		var headroom = state.params.headroom;
		writeParams({ rangeMin: rangeMin(), rangeMax: rangeMax(), capacityMin: capacityMin(), capacityMax: capacityMax(), exposure: state.params.exposure, headroom: headroom, mode: MODES[state.view] || 0, gainScale: state.params.gainScale });
		var enc = device.createCommandEncoder();
		var passGain = enc.beginRenderPass({ colorAttachments: [{ view: gainTex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
		passGain.setPipeline(proc.gainPipe); passGain.setBindGroup(0, bgGain); passGain.draw(3); passGain.end();
		var passApply = enc.beginRenderPass({ colorAttachments: [{ view: hdrTex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
		passApply.setPipeline(proc.applyPipe); passApply.setBindGroup(0, bgApply); passApply.draw(3); passApply.end();
		var presentGroup = state.view === 'gain' ? bgGainView : state.view === 'sdr' ? bgBase : bgPresent;
		var ctx = canvasEl.getContext('webgpu');
		var passPresent = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
		passPresent.setPipeline(proc.presentPipe); passPresent.setBindGroup(0, presentGroup); passPresent.draw(3); passPresent.end();
		device.queue.submit([enc.finish()]);
	}

	function renderHDR() {
		if (!gpuProc || !srcTex) return;
		// For HDR source, we need to generate SDR base + gain map from HDR
		// Simplified: tonemap HDR to SDR via present shader, then compute gain via CPU? For preview we just show HDR with exposure.
		var proc = gpuProc;
		var device = proc.device;
		writeParams({ rangeMin: 0, rangeMax: 1, capacityMin: 0, capacityMax: 1, exposure: state.params.exposure, headroom: state.params.headroom, mode: MODES[state.view] || 0, gainScale: state.params.gainScale });
		var enc = device.createCommandEncoder();
		// For HDR preview, just present srcTex directly with exposure
		var ctx = canvasEl.getContext('webgpu');
		var pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
		pass.setPipeline(proc.presentPipe); pass.setBindGroup(0, bgBase); pass.draw(3); pass.end();
		device.queue.submit([enc.finish()]);
	}

	// ── controls ───────────────────────────────────────────────────────────
	function buildControls() {
		var container = document.getElementById('hdr-controls');
		if (!container) return;
		container.innerHTML = '';
		var p = state.params;
		function slider(label, min, max, step, value, fmt, onInput) {
			var row = document.createElement('label'); row.className = 'row';
			var l = document.createElement('span'); l.className = 'label'; l.textContent = label;
			var input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
			var out = document.createElement('span'); out.className = 'value'; out.textContent = fmt ? fmt(parseFloat(value)) : value;
			input.addEventListener('input', function () { var v = parseFloat(input.value); out.textContent = fmt ? fmt(v) : v; onInput(v); });
			row.appendChild(l); row.appendChild(input); row.appendChild(out);
			container.appendChild(row);
			return { set: function (v) { input.value = v; out.textContent = fmt ? fmt(v) : v; } };
		}
		slider('shadow lift', -2, 1, 0.05, p.shadowLift, function (v) { return v.toFixed(2) + ' stops'; }, function (v) { p.shadowLift = v; if (state.sourceType === 'sdr') render(); });
		slider('highlight gain', 0, 4, 0.05, p.highlightGain, function (v) { return v.toFixed(2) + ' stops'; }, function (v) { p.highlightGain = v; if (state.sourceType === 'sdr') render(); });
		slider('threshold', 0.05, 1, 0.01, p.threshold, function (v) { return v.toFixed(2); }, function (v) { p.threshold = v; state.curvePoints = rampPoints(v); refreshLUT(); if (curveEditor) curveEditor.draw(); if (state.sourceType === 'sdr') render(); });
		slider('peak nits', 100, 4000, 10, p.peakNits, function (v) { return v.toFixed(0); }, function (v) { p.peakNits = v; if (state.sourceType === 'sdr') render(); });
		slider('SDR white', 80, 400, 1, p.sdrWhite, function (v) { return v.toFixed(0); }, function (v) { p.sdrWhite = v; if (state.sourceType === 'sdr') render(); });
		slider('gain scale', 1, 8, 1, p.gainScale, function (v) { return '1:' + v; }, function (v) { p.gainScale = v; if (state.sourceType === 'sdr') { gainSize(); initProcessorForSource(state.sourceCanvas).then(render); } });
		slider('exposure', -3, 3, 0.05, p.exposure, function (v) { return (v >= 0 ? '+' : '') + v.toFixed(2); }, function (v) { p.exposure = v; if (state.sourceType === 'sdr') render(); else renderHDR(); });
		slider('headroom', 1, 16, 0.25, p.headroom, function (v) { return v.toFixed(2) + '×'; }, function (v) { p.headroom = v; if (state.sourceType === 'sdr') render(); else renderHDR(); });
	}

	function refreshLUT() {
		state.lut = sampleCurve(state.curvePoints, LUT_SAMPLES);
		var mn = 1, mx = 0;
		for (var i = 0; i < state.lut.length; i++) { if (state.lut[i] < mn) mn = state.lut[i]; if (state.lut[i] > mx) mx = state.lut[i]; }
		state.lutMin = mn; state.lutMax = mx;
	}

	function initCurveEditor() {
		if (!curveCanvas) return;
		var ctx = curveCanvas.getContext('2d');
		var drag = -1;
		function toPx(p) { return [p[0] * curveCanvas.width, (1 - p[1]) * curveCanvas.height]; }
		function fromPx(px, py) { return [Math.min(1, Math.max(0, px / curveCanvas.width)), Math.min(1, Math.max(0, 1 - py / curveCanvas.height))]; }
		function draw() {
			var w = curveCanvas.width, h = curveCanvas.height;
			ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#12151b'; ctx.fillRect(0, 0, w, h);
			ctx.strokeStyle = '#242a35'; ctx.lineWidth = 1;
			for (var g = 1; g < 4; g++) { var x = Math.round(w * g / 4) + 0.5, y = Math.round(h * g / 4) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
			var lut = sampleCurve(state.curvePoints, 128);
			ctx.strokeStyle = '#7fd4ff'; ctx.lineWidth = 2; ctx.beginPath();
			for (var i = 0; i < lut.length; i++) { var px = i / (lut.length - 1) * w, py = (1 - lut[i]) * h; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.stroke();
			for (var k = 0; k < state.curvePoints.length; k++) { var p = toPx(state.curvePoints[k]); ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, Math.PI * 2); ctx.fillStyle = k === drag ? '#ffd479' : '#e8eef7'; ctx.fill(); }
		}
		function hit(px, py) { for (var k = 0; k < state.curvePoints.length; k++) { var p = toPx(state.curvePoints[k]); if (Math.hypot(p[0] - px, p[1] - py) < 12) return k; } return -1; }
		function local(e) { var r = curveCanvas.getBoundingClientRect(); return [(e.clientX - r.left) * curveCanvas.width / r.width, (e.clientY - r.top) * curveCanvas.height / r.height]; }
		curveCanvas.addEventListener('pointerdown', function (e) {
			var p = local(e); drag = hit(p[0], p[1]);
			if (drag < 0 && !e.shiftKey) { var np = fromPx(p[0], p[1]); state.curvePoints.push(np); state.curvePoints.sort(function (a, b) { return a[0] - b[0]; }); drag = state.curvePoints.indexOf(np); }
			if (drag >= 0 && e.shiftKey && state.curvePoints.length > 2) { state.curvePoints.splice(drag, 1); drag = -1; }
			draw(); refreshLUT(); render();
		});
		curveCanvas.addEventListener('pointermove', function (e) {
			if (drag < 0) return; var p = local(e); var pt = fromPx(p[0], p[1]); var min = drag > 0 ? state.curvePoints[drag - 1][0] + 0.01 : 0; var max = drag < state.curvePoints.length - 1 ? state.curvePoints[drag + 1][0] - 0.01 : 1; pt[0] = Math.min(max, Math.max(min, pt[0])); state.curvePoints[drag] = pt; draw(); refreshLUT(); render();
		});
		window.addEventListener('pointerup', function () { drag = -1; draw(); });
		draw();
		curveEditor = { draw: draw };
	}

	// ── encode / save ──────────────────────────────────────────────────────
	function toBlob(source, w, h, type, quality) {
		var c = document.createElement('canvas'); c.width = w; c.height = h;
		c.getContext('2d').drawImage(source, 0, 0, w, h);
		return new Promise(function (resolve) { c.toBlob(resolve, type, quality); });
	}
	function bytesOf(blob) { return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); }); }

	async function readTexture(device, tex, w, h, format) {
		var bpp = format === 'rgba8unorm' ? 4 : 8;
		var padded = Math.ceil(w * bpp / 256) * 256;
		var buffer = device.createBuffer({ size: padded * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		var enc = device.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: tex }, { buffer: buffer, bytesPerRow: padded, rowsPerImage: h }, { width: w, height: h });
		device.queue.submit([enc.finish()]);
		await buffer.mapAsync(GPUMapMode.READ);
		var raw = new Uint8Array(buffer.getMappedRange().slice(0)); buffer.unmap(); buffer.destroy();
		if (padded === w * bpp) return raw;
		var out = new Uint8Array(w * bpp * h);
		for (var y = 0; y < h; y++) out.set(raw.subarray(y * padded, y * padded + w * bpp), y * w * bpp);
		return out;
	}

	async function encodePair() {
		var p = state.params;
		if (state.sourceType === 'hdr' && state.hdrData) {
			return await encodeFromHDR();
		}
		// SDR path: read gainTex, create base jpeg from source canvas, gain jpeg from gainTex
		var baseBlob = await toBlob(state.sourceCanvas, state.srcW, state.srcH, 'image/jpeg', p.baseQuality / 100);
		var raw = await readTexture(gpuProc.device, gainTex, gainW, gainH, 'rgba8unorm');
		var gmCanvas = document.createElement('canvas'); gmCanvas.width = gainW; gmCanvas.height = gainH;
		var ctx = gmCanvas.getContext('2d'); var imgData = ctx.createImageData(gainW, gainH);
		for (var i = 0; i < gainW * gainH; i++) { var v = raw[i * 4]; imgData.data[i * 4] = v; imgData.data[i * 4 + 1] = v; imgData.data[i * 4 + 2] = v; imgData.data[i * 4 + 3] = 255; }
		ctx.putImageData(imgData, 0, 0);
		var gmBlob = await new Promise(function (res) { gmCanvas.toBlob(res, 'image/jpeg', p.gainQuality / 100); });
		return { base: await bytesOf(baseBlob), gain: await bytesOf(gmBlob), meta: { gainMapMin: rangeMin(), gainMapMax: rangeMax(), hdrCapacityMin: capacityMin(), hdrCapacityMax: capacityMax(), offsetSDR: 0, offsetHDR: 0, gamma: 1 } };
	}

	async function encodeFromHDR() {
		var p = state.params;
		var hdr = state.hdrData.data, w = state.hdrData.width, h = state.hdrData.height;
		// tonemap HDR to SDR for base
		var sdr = new Float32Array(w * h * 4);
		var minLog = Infinity, maxLog = -Infinity;
		var exposure = Math.pow(2, p.exposure);
		for (var i = 0; i < w * h; i++) {
			var idx = i * 4;
			var r = hdr[idx] * exposure, g = hdr[idx + 1] * exposure, b = hdr[idx + 2] * exposure;
			// preserve chroma, compress peak to 1.0
			var peak = Math.max(r, g, b);
			var H = p.headroom;
			var mappedPeak = (peak * H) / Math.sqrt(H * H + peak * peak);
			var scale = peak > 1e-6 ? mappedPeak / peak : 1;
			var rr = r * scale, gg = g * scale, bb = b * scale;
			// clamp to 1 for SDR
			rr = Math.min(1, rr); gg = Math.min(1, gg); bb = Math.min(1, bb);
			sdr[idx] = rr; sdr[idx + 1] = gg; sdr[idx + 2] = bb; sdr[idx + 3] = 1;
			var lh = Math.max(1e-6, luma(hdr[idx], hdr[idx + 1], hdr[idx + 2]) * exposure);
			var ls = Math.max(1e-6, luma(rr, gg, bb));
			var logBoost = Math.log2(lh / ls);
			if (logBoost < minLog) minLog = logBoost;
			if (logBoost > maxLog) maxLog = logBoost;
		}
		if (!isFinite(minLog)) { minLog = 0; maxLog = 1; }
		if (maxLog - minLog < 0.01) { maxLog = minLog + 0.01; }
		// create base canvas
		var baseCanvas = document.createElement('canvas'); baseCanvas.width = w; baseCanvas.height = h;
		var bctx = baseCanvas.getContext('2d'); var bimg = bctx.createImageData(w, h);
		for (var j = 0; j < w * h; j++) {
			var id = j * 4;
			bimg.data[id] = Math.round(linearToSrgb(sdr[id]) * 255);
			bimg.data[id + 1] = Math.round(linearToSrgb(sdr[id + 1]) * 255);
			bimg.data[id + 2] = Math.round(linearToSrgb(sdr[id + 2]) * 255);
			bimg.data[id + 3] = 255;
		}
		bctx.putImageData(bimg, 0, 0);
		var baseBlob = await new Promise(function (res) { baseCanvas.toBlob(res, 'image/jpeg', p.baseQuality / 100); });
		// gain map
		var gw = Math.max(1, Math.ceil(w / p.gainScale)), gh = Math.max(1, Math.ceil(h / p.gainScale));
		var gainCanvas = document.createElement('canvas'); gainCanvas.width = gw; gainCanvas.height = gh;
		var gctx = gainCanvas.getContext('2d'); var gimg = gctx.createImageData(gw, gh);
		for (var y = 0; y < gh; y++) {
			for (var x = 0; x < gw; x++) {
				var sx = Math.floor(x * w / gw), sy = Math.floor(y * h / gh);
				var sidx = (sy * w + sx) * 4;
				var lh2 = Math.max(1e-6, luma(hdr[sidx], hdr[sidx + 1], hdr[sidx + 2]) * exposure);
				var ls2 = Math.max(1e-6, luma(sdr[sidx], sdr[sidx + 1], sdr[sidx + 2]));
				var lb = Math.log2(lh2 / ls2);
				var norm = Math.min(1, Math.max(0, (lb - minLog) / (maxLog - minLog)));
				var v = Math.round(norm * 255);
				var gidx = (y * gw + x) * 4;
				gimg.data[gidx] = v; gimg.data[gidx + 1] = v; gimg.data[gidx + 2] = v; gimg.data[gidx + 3] = 255;
			}
		}
		gctx.putImageData(gimg, 0, 0);
		var gainBlob = await new Promise(function (res) { gainCanvas.toBlob(res, 'image/jpeg', p.gainQuality / 100); });
		return { base: await bytesOf(baseBlob), gain: await bytesOf(gainBlob), meta: { gainMapMin: minLog, gainMapMax: maxLog, hdrCapacityMin: Math.max(minLog, 0), hdrCapacityMax: capacityMax(), offsetSDR: 0, offsetHDR: 0, gamma: 1 } };
	}

	async function save() {
		if (!gpuProc) return;
		setStatus('encoding…');
		var pair = await encodePair();
		var built = buildUltraHDR(pair.base, pair.gain, pair.meta);
		var blob = new Blob([built.bytes], { type: 'image/jpeg' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a'); a.href = url; a.download = 'capture_ultrahdr.jpg'; document.body.appendChild(a); a.click(); a.remove();
		setStatus('saved capture_ultrahdr.jpg — ' + (built.bytes.length / 1024).toFixed(0) + ' KB, range ' + pair.meta.gainMapMin.toFixed(2) + '…' + pair.meta.gainMapMax.toFixed(2) + ' stops');
	}

	async function exportPair() {
		if (!gpuProc) return;
		setStatus('encoding…');
		var pair = await encodePair();
		function dl(bytes, name) { var b = new Blob([bytes], { type: 'image/jpeg' }); var u = URL.createObjectURL(b); var a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
		dl(pair.base, 'capture_base.jpg'); dl(pair.gain, 'capture_gainmap.jpg');
		var meta = Object.assign({}, pair.meta, { baseWidth: state.srcW, baseHeight: state.srcH, gainMapWidth: gainW, gainMapHeight: gainH });
		var jblob = new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' }); var ju = URL.createObjectURL(jblob); var ja = document.createElement('a'); ja.href = ju; ja.download = 'capture_gainmap.json'; document.body.appendChild(ja); ja.click(); ja.remove();
		setStatus('exported base+gain+json');
	}

	// ── public API ─────────────────────────────────────────────────────────
	function init(opts) {
		opts = opts || {};
		ensurePatch();
		createUI();
		if (opts.autoScan !== false) {
			setInterval(refreshList, 1000);
			var observer = new MutationObserver(function () { refreshList(); });
			observer.observe(document.body, { childList: true, subtree: true });
		}
		refreshList();
	}

	var api = { init: init, captureSDR: captureSDR, captureHDR: captureHDR, requestHDRReadback: requestHDRReadback, buildUltraHDR: buildUltraHDR, _webgpuMap: webgpuMap };

	root.HDRGainmapPlugin = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;

	// auto-init on DOM ready
	if (typeof document !== 'undefined') {
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); });
		else init();
	}
})(typeof globalThis !== 'undefined' ? globalThis : this);
