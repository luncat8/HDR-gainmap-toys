// HDR gain map toy: SDR source -> authored HDR -> Ultra HDR JPEG -> check.
//
// Tone model (stops): the editable curve maps SDR luminance (0..1) to a
// normalised boost t (0..1). log2 gain = shadowLift + t * (highlightGain -
// shadowLift), so the gain map range is [shadowLift, highlightGain] stops.
// peakNits is separate: it only sets the HDR capacity metadata (and caps
// highlightGain), i.e. the display headroom the file is mastered for.
(function () {
	'use strict';

	var SAMPLES = SHADERS.LUT_SAMPLES;
	var MAX_WORK = 4096;   // working resolution cap: rgba16float + jpeg encode

	// histogram: low-res readback is binned on the CPU
	var HIST_W = 192, HIST_H = 108, HIST_BINS = 256;
	var HIST_MIN_STOP = -10, HIST_MAX_STOP = 6;

	var state = {
		sourceName: '',
		source: null,          // drawable (ImageBitmap or canvas)
		srcW: 0,
		srcH: 0,
		params: {
			peakNits: 1000,
			sdrWhite: 203,
			shadowLift: 0,     // stops, curve bottom = GainMapMin
			highlightGain: 0,  // stops, curve top = GainMapMax (<= capacity)
			threshold: 0.55,   // luminance where the highlight ramp starts
			gainScale: 4,
			exposure: 0,
			headroom: 4,
			baseQuality: 92,
			gainQuality: 85,
			histogram: true,
			histLog: true
		},
		view: 'hdr',
		curve: { points: null },
		lut: null,
		lutMin: 0,
		lutMax: 1,
		file: null
	};

	var gpu = null, device = null, context = null;
	var srcTex = null, gainTex = null, hdrTex = null, histTex = null;
	var fileBaseTex = null, fileGainTex = null, fileMeta = null;
	var gainW = 0, gainH = 0;
	var ubo = null, samp = null;
	var gainPipe = null, applyPipe = null, presentPipe = null, histPipe = null;
	var bgGain = null, bgApply = null, bgFileApply = null, bgPresent = null;
	var bgGainView = null, bgHist = null, bgBase = null;
	var params = new Float32Array(12 + SAMPLES);
	var histSrc = new Float32Array(HIST_BINS);
	var histRes = new Float32Array(HIST_BINS);
	var histGen = 0, histScheduled = false;
	var controls = {};
	var dom = {};
	var curveView = null;
	var lastCap = 0;

	// ── derived ──────────────────────────────────────────────────────────────

	function capacityMax() {
		return Math.log2(state.params.peakNits / state.params.sdrWhite);
	}

	function minStops() {
		return state.params.shadowLift;
	}

	// curve top, clamped into [shadowLift + epsilon, capacity]
	function maxStops() {
		var cap = capacityMax();
		var lo = minStops() + 0.01;
		return Math.min(cap, Math.max(lo, state.params.highlightGain));
	}

	function spanStops() {
		return maxStops() - minStops();
	}

	function rangeMin() {
		return minStops() + state.lutMin * spanStops();
	}

	function rangeMax() {
		return minStops() + state.lutMax * spanStops();
	}

	function capacityMin() {
		return Math.max(rangeMin(), 0);
	}

	function gainSize() {
		var s = state.params.gainScale;
		return [Math.max(1, Math.ceil(state.srcW / s)), Math.max(1, Math.ceil(state.srcH / s))];
	}

	// ── gpu resources ────────────────────────────────────────────────────────

	function makePipelines() {
		var module = device.createShaderModule({ code: SHADERS.code });
		var layout = device.createBindGroupLayout({
			entries: [
				{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
				{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
				{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
			]
		});
		var pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
		bgLayout = layout;
		function pipe(entry, format) {
			return device.createRenderPipeline({
				layout: pl,
				vertex: { module: module, entryPoint: 'vs' },
				fragment: { module: module, entryPoint: entry, targets: [{ format: format }] },
				primitive: { topology: 'triangle-list' }
			});
		}
		gainPipe = pipe('fs_gain', GPUX.RGBA8);
		applyPipe = pipe('fs_apply', GPUX.HDRTEX);
		presentPipe = pipe('fs_present', GPUX.HDRTEX);
		histPipe = pipe('fs_hist', GPUX.HDRTEX);
	}

	var bgLayout = null;

	function bindGroup(tex0, tex1) {
		return device.createBindGroup({
			layout: bgLayout,
			entries: [
				{ binding: 0, resource: { buffer: ubo } },
				{ binding: 1, resource: samp },
				{ binding: 2, resource: tex0.createView() },
				{ binding: 3, resource: tex1.createView() }
			]
		});
	}

	function allocForSource() {
		[srcTex, gainTex, hdrTex, histTex].forEach(function (t) { if (t) t.destroy(); });
		var gs = gainSize();
		gainW = gs[0];
		gainH = gs[1];
		srcTex = GPUX.imageTexture(device, state.srcW, state.srcH);
		gainTex = GPUX.renderTexture(device, gainW, gainH, GPUX.RGBA8);
		hdrTex = GPUX.renderTexture(device, state.srcW, state.srcH, GPUX.HDRTEX);
		histTex = GPUX.renderTexture(device, HIST_W, HIST_H, GPUX.HDRTEX);
		GPUX.uploadImage(device, srcTex, state.source, state.srcW, state.srcH);
		bgGain = bindGroup(srcTex, srcTex);
		bgApply = bindGroup(srcTex, gainTex);
		bgPresent = bindGroup(hdrTex, hdrTex);
		bgGainView = bindGroup(gainTex, gainTex);
		bgHist = bindGroup(srcTex, hdrTex);
		bgBase = bindGroup(srcTex, srcTex);
	}

	function allocForFile(w, h, gw, gh, base, gain) {
		[fileBaseTex, fileGainTex].forEach(function (t) { if (t) t.destroy(); });
		fileBaseTex = GPUX.imageTexture(device, w, h);
		fileGainTex = GPUX.imageTexture(device, gw, gh);
		GPUX.uploadImage(device, fileBaseTex, base, w, h);
		GPUX.uploadImage(device, fileGainTex, gain, gw, gh);
		bgFileApply = bindGroup(fileBaseTex, fileGainTex);
	}

	// One uniform write per frame: the passes use disjoint fields.
	function writeParams(p) {
		params[0] = p.rangeMin;
		params[1] = p.rangeMax;
		params[2] = p.capacityMin;
		params[3] = p.capacityMax;
		params[4] = p.exposure;
		params[5] = Math.log2(p.headroom);
		params[6] = p.mode;
		params[7] = p.gainScale;
		params[8] = state.srcW;
		params[9] = state.srcH;
		params[10] = gainW;
		params[11] = gainH;
		params.set(state.lut, 12);
		device.queue.writeBuffer(ubo, 0, params);
	}

	var MODES = { hdr: 0, sdr: 3, gain: 2 };

	function presentGroup() {
		if (state.view === 'gain') return bgGainView;
		if (state.view === 'sdr') return bgBase;
		return bgPresent;
	}

	function render() {
		if (!device || !srcTex) return;
		var useFile = state.view === 'file' && bgFileApply;
		// live authoring shows the full authored HDR (weight = 1, the canvas
		// tone maps); only the decoded-file view adapts to the display headroom.
		var headroom = useFile ? state.params.headroom : 1e6;
		var m = fileMeta || {};

		writeParams({
			rangeMin: useFile ? (m.gainMapMin !== undefined ? m.gainMapMin : 0) : rangeMin(),
			rangeMax: useFile ? (m.gainMapMax !== undefined ? m.gainMapMax : 1) : rangeMax(),
			capacityMin: useFile ? (m.hdrCapacityMin !== undefined ? m.hdrCapacityMin : 0) : capacityMin(),
			capacityMax: useFile ? (m.hdrCapacityMax !== undefined ? m.hdrCapacityMax : 1) : capacityMax(),
			exposure: state.view === 'gain' ? 0 : state.params.exposure,
			headroom: headroom,
			mode: MODES[state.view] === undefined ? 0 : MODES[state.view],
			gainScale: state.params.gainScale
		});

		var enc = device.createCommandEncoder();
		if (!useFile) {
			GPUX.draw(enc.beginRenderPass({
				colorAttachments: [{
					view: gainTex.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: 'clear',
					storeOp: 'store'
				}]
			}), gainPipe, bgGain);
			GPUX.draw(enc.beginRenderPass({
				colorAttachments: [{
					view: hdrTex.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: 'clear',
					storeOp: 'store'
				}]
			}), applyPipe, bgApply);
		} else {
			GPUX.draw(enc.beginRenderPass({
				colorAttachments: [{
					view: hdrTex.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: 'clear',
					storeOp: 'store'
				}]
			}), applyPipe, bgFileApply);
		}
		GPUX.draw(enc.beginRenderPass({
			colorAttachments: [{
				view: context.getCurrentTexture().createView(),
				clearValue: { r: 0, g: 0, b: 0, a: 1 },
				loadOp: 'clear',
				storeOp: 'store'
			}]
		}), presentPipe, presentGroup());
		device.queue.submit([enc.finish()]);
		scheduleHist();
	}

	// ── histogram ────────────────────────────────────────────────────────────

	function scheduleHist() {
		if (!state.params.histogram || !histTex || !bgHist) return;
		if (typeof requestAnimationFrame !== 'function') return;
		if (histScheduled) return;
		histScheduled = true;
		requestAnimationFrame(function () {
			histScheduled = false;
			updateHistogram();
		});
	}

	async function updateHistogram() {
		if (!histTex || !bgHist) return;
		var gen = ++histGen;
		var enc = device.createCommandEncoder();
		GPUX.draw(enc.beginRenderPass({
			colorAttachments: [{
				view: histTex.createView(),
				clearValue: { r: 0, g: 0, b: 0, a: 1 },
				loadOp: 'clear',
				storeOp: 'store'
			}]
		}), histPipe, bgHist);
		device.queue.submit([enc.finish()]);
		var raw = await GPUX.readTexture(device, histTex, HIST_W, HIST_H, GPUX.HDRTEX);
		if (gen !== histGen) return;
		binHistogram(GPUX.halfRowsToFloat(raw, HIST_W, HIST_H));
		drawHistogram();
	}

	function addBin(arr, v) {
		var t = (v - HIST_MIN_STOP) / (HIST_MAX_STOP - HIST_MIN_STOP);
		var b = t < 0 ? 0 : t >= 1 ? HIST_BINS - 1 : (t * HIST_BINS) | 0;
		arr[b]++;
	}

	function binHistogram(f) {
		histSrc.fill(0);
		histRes.fill(0);
		for (var i = 0; i < f.length; i += 4) {
			addBin(histSrc, f[i]);
			addBin(histRes, f[i + 1]);
		}
	}

	function histMax() {
		var m = 1;
		for (var i = 0; i < HIST_BINS; i++) {
			if (histSrc[i] > m) m = histSrc[i];
			if (histRes[i] > m) m = histRes[i];
		}
		return m;
	}

	function drawHistogram() {
		var c = dom.histo;
		var ctx = c.getContext('2d');
		var w = c.width, h = c.height;
		var padL = 30, padR = 8, padT = 8, padB = 16;
		var plotW = w - padL - padR, plotH = h - padT - padB;
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = '#0e1117';
		ctx.fillRect(0, 0, w, h);
		if (plotW < 20 || plotH < 10) return;

		var maxN = histMax();
		var log = state.params.histLog;
		var denom = log ? Math.log1p(maxN) : maxN;
		function yOf(v) {
			var n = log ? Math.log1p(v) : v;
			return padT + plotH * (1 - n / denom);
		}
		function xOf(b) {
			return padL + plotW * (b / (HIST_BINS - 1));
		}

		// grid at each stop, with the SDR white (0 stops) line emphasised
		ctx.lineWidth = 1;
		ctx.font = '10px system-ui, sans-serif';
		for (var s = HIST_MIN_STOP; s <= HIST_MAX_STOP; s++) {
			var x = padL + plotW * ((s - HIST_MIN_STOP) / (HIST_MAX_STOP - HIST_MIN_STOP));
			ctx.strokeStyle = s === 0 ? '#4a5260' : '#20252e';
			ctx.beginPath();
			ctx.moveTo(x + 0.5, padT);
			ctx.lineTo(x + 0.5, padT + plotH);
			ctx.stroke();
			ctx.fillStyle = '#5b6472';
			ctx.fillText((s >= 0 ? '+' : '') + s, x - 4, h - 4);
		}

		strokeHist(ctx, histSrc, '#5b6472', padL, padT, plotW, plotH, yOf, xOf);
		strokeHist(ctx, histRes, '#7fd4ff', padL, padT, plotW, plotH, yOf, xOf);

		// markers: display headroom and mastered peak
		markHist(ctx, Math.log2(state.params.headroom), '#e8eef7', padL, padT, plotW, plotH);
		markHist(ctx, capacityMax(), '#ffd479', padL, padT, plotW, plotH);
	}

	function strokeHist(ctx, arr, color, padL, padT, plotW, plotH, yOf, xOf) {
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		ctx.globalAlpha = 0.45;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(xOf(0), padT + plotH);
		for (var i = 0; i < HIST_BINS; i++) {
			ctx.lineTo(xOf(i), yOf(arr[i]));
		}
		ctx.lineTo(xOf(HIST_BINS - 1), padT + plotH);
		ctx.closePath();
		ctx.fill();
		ctx.globalAlpha = 1;
		ctx.beginPath();
		for (var j = 0; j < HIST_BINS; j++) {
			var yy = yOf(arr[j]);
			if (j === 0) ctx.moveTo(xOf(0), yy);
			else ctx.lineTo(xOf(j), yy);
		}
		ctx.stroke();
	}

	function markHist(ctx, stop, color, padL, padT, plotW, plotH) {
		var x = padL + plotW * ((stop - HIST_MIN_STOP) / (HIST_MAX_STOP - HIST_MIN_STOP));
		if (x < padL || x > padL + plotW) return;
		ctx.strokeStyle = color;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(x + 0.5, padT);
		ctx.lineTo(x + 0.5, padT + plotH);
		ctx.stroke();
	}

	// ── source ───────────────────────────────────────────────────────────────

	function cap(w, h) {
		var k = Math.min(1, MAX_WORK / Math.max(w, h));
		return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
	}

	function setSource(source, name) {
		var w = source.width, h = source.height;
		var size = cap(w, h);
		state.source = source;
		state.sourceName = name;
		state.srcW = size[0];
		state.srcH = size[1];
		if (state.file && state.file.url) URL.revokeObjectURL(state.file.url);
		state.file = null;
		fileMeta = null;
		dom.viewRadio.set('hdr');
		state.view = 'hdr';
		fitCanvas();
		fitHisto();
		allocForSource();
		render();
		status(name + ' — ' + state.srcW + '×' + state.srcH +
			(size[0] !== w ? ' (from ' + w + '×' + h + ')' : ''));
	}

	function fitCanvas() {
		var maxW = dom.viewWrap.clientWidth || 900;
		var maxH = dom.viewWrap.clientHeight || 600;
		var k = Math.min(1, maxW / state.srcW, maxH / state.srcH);
		dom.canvas.width = Math.max(1, Math.round(state.srcW * k));
		dom.canvas.height = Math.max(1, Math.round(state.srcH * k));
	}

	function fitHisto() {
		if (!dom.histo) return;
		dom.histo.width = Math.max(64, dom.viewCol.clientWidth || 900);
	}

	function usePattern(kind) {
		setSource(PATTERNS.make(kind, 1280, 800), 'pattern: ' + kind);
	}

	async function openFile(file) {
		try {
			var bitmap = await createImageBitmap(file);
			setSource(bitmap, file.name);
		} catch (e) {
			status('cannot decode ' + file.name + ': ' + e.message);
		}
	}

	// ── encode / save ────────────────────────────────────────────────────────

	function toBlob(source, w, h, type, quality) {
		var c = PATTERNS.canvasOf(w, h);
		c.getContext('2d').drawImage(source, 0, 0, w, h);
		return new Promise(function (resolve) {
			c.toBlob(resolve, type, quality);
		});
	}

	function bytesOf(blob) {
		return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
	}

	function gainImageData(raw, w, h) {
		var data = new Uint8ClampedArray(w * h * 4);
		for (var i = 0; i < w * h; i++) {
			var v = raw[i * 4];
			data[i * 4] = v;
			data[i * 4 + 1] = v;
			data[i * 4 + 2] = v;
			data[i * 4 + 3] = 255;
		}
		return new ImageData(data, w, h);
	}

	function buildMeta() {
		return {
			gainMapMin: rangeMin(),
			gainMapMax: rangeMax(),
			hdrCapacityMin: capacityMin(),
			hdrCapacityMax: capacityMax(),
			offsetSDR: 0,
			offsetHDR: 0,
			gamma: 1
		};
	}

	async function encodePair() {
		var p = state.params;
		var baseBlob = await toBlob(state.source, state.srcW, state.srcH,
			'image/jpeg', p.baseQuality / 100);
		var raw = await GPUX.readTexture(device, gainTex, gainW, gainH, GPUX.RGBA8);
		var gmCanvas = PATTERNS.canvasOf(gainW, gainH);
		gmCanvas.getContext('2d').putImageData(gainImageData(raw, gainW, gainH), 0, 0);
		var gmBlob = await new Promise(function (resolve) {
			gmCanvas.toBlob(resolve, 'image/jpeg', p.gainQuality / 100);
		});
		return {
			base: await bytesOf(baseBlob),
			gain: await bytesOf(gmBlob),
			meta: buildMeta()
		};
	}

	async function save() {
		if (!srcTex) return;
		status('encoding…');
		var pair = await encodePair();
		var built = UHDR.buildUltraHDR(pair.base, pair.gain, pair.meta);
		var blob = new Blob([built.bytes], { type: 'image/jpeg' });

		state.file = { blob: blob, bytes: built.bytes, meta: built.meta, built: built };
		if (state.file.url) URL.revokeObjectURL(state.file.url);
		state.file.url = URL.createObjectURL(blob);

		var stem = stemOf();
		dom.img.src = state.file.url;
		dom.link.href = state.file.url;
		dom.link.download = stem + '_ultrahdr.jpg';
		dom.link.classList.remove('hidden');

		var info = await describeFile(built);
		status('saved ' + dom.link.download + ' — ' +
			(built.bytes.length / 1024).toFixed(0) + ' KB');
		await verify(info);
	}

	async function describeFile(built) {
		var parsed = UHDR.parseUltraHDR(built.bytes);
		var base = UHDR.jpegInfo(parsed.base);
		var gm = UHDR.jpegInfo(parsed.gainmap);
		fileMeta = parsed.meta;
		var baseBitmap = await createImageBitmap(new Blob([parsed.base], { type: 'image/jpeg' }));
		var gmBitmap = await createImageBitmap(new Blob([parsed.gainmap], { type: 'image/jpeg' }));
		allocForFile(baseBitmap.width, baseBitmap.height, gmBitmap.width, gmBitmap.height,
			baseBitmap, gmBitmap);

		return {
			parsed: parsed,
			base: base,
			gainmap: gm,
			primarySize: built.primarySize,
			gainLength: built.gainMapLength,
			stops: parsed.meta.gainMapMax - parsed.meta.gainMapMin
		};
	}

	async function verify(info) {
		if (!info || state.srcW * state.srcH > 4e6) {
			report(info, null);
			return;
		}
		// compare at weight 1, i.e. the authored boost, not the adapted one
		var keep = state.view;
		var keepHeadroom = state.params.headroom;
		state.params.headroom = 1e6;
		state.view = 'hdr';
		render();
		var a = GPUX.halfRowsToFloat(
			await GPUX.readTexture(device, hdrTex, state.srcW, state.srcH, GPUX.HDRTEX),
			state.srcW, state.srcH);
		state.view = 'file';
		render();
		var b = GPUX.halfRowsToFloat(
			await GPUX.readTexture(device, hdrTex, state.srcW, state.srcH, GPUX.HDRTEX),
			state.srcW, state.srcH);
		state.view = keep;
		state.params.headroom = keepHeadroom;
		render();

		var max = 0, sum = 0, n = 0;
		for (var i = 0; i < a.length; i += 4) {
			var la = 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
			var lb = 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
			if (la <= 1e-5) continue;
			var d = Math.abs(Math.log2(Math.max(1e-6, lb) / Math.max(1e-6, la)));
			max = Math.max(max, d);
			sum += d;
			n++;
		}
		report(info, { max: max, mean: n ? sum / n : 0 });
	}

	// ── terminal export (AVIF path) ──────────────────────────────────────────

	async function exportPair() {
		if (!srcTex) return;
		status('encoding…');
		var pair = await encodePair();
		var stem = stemOf();
		saveBlob(new Blob([pair.base], { type: 'image/jpeg' }), stem + '_base.jpg');
		saveBlob(new Blob([pair.gain], { type: 'image/jpeg' }), stem + '_gainmap.jpg');
		var meta = Object.assign({}, pair.meta, {
			baseWidth: state.srcW,
			baseHeight: state.srcH,
			gainMapWidth: gainW,
			gainMapHeight: gainH,
			sdrWhiteNits: state.params.sdrWhite,
			peakNits: state.params.peakNits
		});
		saveBlob(new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' }),
			stem + '_gainmap.json');
		status('exported base.jpg + gainmap.jpg + json — run tools/avif_gainmap.py');
	}

	function stemOf() {
		return (state.sourceName || 'image').replace(/\.[^.]+$/, '');
	}

	function saveBlob(blob, name) {
		var a = UI.el('a', { href: URL.createObjectURL(blob), download: name });
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	// ── reporting ────────────────────────────────────────────────────────────

	function report(info, diff) {
		if (!info) {
			dom.report.textContent = '';
			return;
		}
		var m = info.parsed.meta;
		var lines = [
			'primary  ' + info.base.width + '×' + info.base.height + '  ' +
				(info.primarySize / 1024).toFixed(0) + ' KB',
			'gain map ' + info.gainmap.width + '×' + info.gainmap.height + '  ' +
				info.gainmap.components + ' component' + (info.gainmap.components > 1 ? 's' : '') +
				'  ' + (info.gainLength / 1024).toFixed(1) + ' KB',
			'range    ' + m.gainMapMin.toFixed(3) + ' … ' + m.gainMapMax.toFixed(3) + ' stops  (' +
				Math.pow(2, info.stops).toFixed(2) + '× boost)',
			'capacity ' + m.hdrCapacityMin.toFixed(3) + ' … ' + m.hdrCapacityMax.toFixed(3) +
				' stops  (' + Math.pow(2, m.hdrCapacityMax).toFixed(2) + '× display)',
			'MPF      image 2 at byte ' + info.parsed.gainMapOffset +
				', ' + info.parsed.images[1].size + ' bytes'
		];
		if (diff) {
			lines.push('round trip  max Δ ' + diff.max.toFixed(3) + ' stops, mean ' +
				diff.mean.toFixed(4) + '  ' + verdict(diff.max));
		}
		dom.report.textContent = lines.join('\n');
	}

	function verdict(max) {
		if (max < 0.05) return '(good)';
		if (max < 0.25) return '(jpeg loss, raise gain map quality)';
		return '(FAIL: gain map does not round trip)';
	}

	function status(text) {
		dom.status.textContent = text;
	}

	// ── ui ───────────────────────────────────────────────────────────────────

	function refreshRange() {
		var cap = capacityMax();
		var wasAtMax = lastCap > 0 && Math.abs(state.params.highlightGain - lastCap) < 1e-4;
		lastCap = cap;
		controls.highlightGain.input.max = cap.toFixed(4);
		if (wasAtMax) state.params.highlightGain = cap;
		if (state.params.highlightGain < minStops() + 0.01) state.params.highlightGain = minStops() + 0.01;
		if (state.params.highlightGain > cap) state.params.highlightGain = cap;
		controls.highlightGain.set(state.params.highlightGain);
	}

	function buildUI() {
		var p = state.params;

		controls.shadowLift = UI.slider({
			label: 'shadow lift', min: -2, max: 1, step: 0.05, value: p.shadowLift,
			format: function (v) { return v.toFixed(2) + ' stops'; },
			onInput: function (v) { p.shadowLift = v; render(); }
		});
		controls.highlightGain = UI.slider({
			label: 'highlight gain', min: 0, max: capacityMax(), step: 0.05, value: capacityMax(),
			format: function (v) { return v.toFixed(2) + ' stops'; },
			onInput: function (v) { p.highlightGain = v; render(); }
		});
		controls.threshold = UI.slider({
			label: 'highlight threshold', min: 0.05, max: 1, step: 0.01, value: p.threshold,
			format: function (v) { return v.toFixed(2) + ' Y'; },
			onInput: function (v) {
				p.threshold = v;
				setCurve(CURVE.rampPoints(v));
			}
		});
		controls.peakNits = UI.slider({
			label: 'peak nits', min: 100, max: 4000, step: 10, value: p.peakNits,
			format: function (v) { return v.toFixed(0) + ' nits'; },
			onInput: function (v) { p.peakNits = v; refreshRange(); render(); }
		});
		controls.sdrWhite = UI.slider({
			label: 'SDR white', min: 80, max: 400, step: 1, value: p.sdrWhite,
			format: function (v) { return v.toFixed(0) + ' nits'; },
			onInput: function (v) { p.sdrWhite = v; refreshRange(); render(); }
		});
		controls.gainScale = UI.select({
			label: 'gain map scale', value: String(p.gainScale),
			options: [1, 2, 4, 8].map(function (s) {
				return { value: String(s), label: s === 1 ? '1 : 1' : '1 : ' + s };
			}),
			onChange: function (v) {
				p.gainScale = parseInt(v, 10);
				allocForSource();
				render();
			}
		});
		controls.exposure = UI.slider({
			label: 'preview exposure', min: -3, max: 3, step: 0.05, value: p.exposure,
			format: function (v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + ' stops'; },
			onInput: function (v) { p.exposure = v; render(); }
		});
		controls.headroom = UI.slider({
			label: 'display headroom', min: 1, max: 16, step: 0.25, value: p.headroom,
			format: function (v) { return v.toFixed(2) + '× SDR'; },
			onInput: function (v) { p.headroom = v; render(); }
		});
		controls.baseQuality = UI.slider({
			label: 'base jpeg quality', min: 50, max: 100, step: 1, value: p.baseQuality,
			onInput: function (v) { p.baseQuality = v; }
		});
		controls.gainQuality = UI.slider({
			label: 'gain map quality', min: 50, max: 100, step: 1, value: p.gainQuality,
			onInput: function (v) { p.gainQuality = v; }
		});
		controls.histogram = UI.checkbox({
			label: 'histogram', value: p.histogram,
			onChange: function (v) { p.histogram = v; if (v) scheduleHist(); }
		});
		controls.histLog = UI.checkbox({
			label: 'log', value: p.histLog,
			onChange: function (v) { p.histLog = v; drawHistogram(); }
		});

		dom.controls.appendChild(UI.el('div', { class: 'group' }, [
			UI.el('h3', { text: 'tone — luminance → boost (stops)' }),
			controls.shadowLift.row,
			controls.highlightGain.row,
			controls.threshold.row
		]));

		dom.controls.appendChild(UI.el('div', { class: 'group' }, [
			UI.el('h3', { text: 'HDR range' }),
			controls.peakNits.row,
			controls.sdrWhite.row,
			controls.gainScale.row
		]));

		dom.controls.appendChild(UI.el('div', { class: 'group' }, [
			UI.el('h3', { text: 'curve — fine edit' }),
			dom.curveBox,
			UI.el('div', { class: 'buttons' }, Object.keys(CURVE.PRESETS).map(function (name) {
				return UI.el('button', {
					type: 'button', text: name,
					onclick: function () {
						setCurve(CURVE.PRESETS[name].map(function (pt) { return pt.slice(); }));
					}
				});
			}))
		]));

		dom.controls.appendChild(UI.el('div', { class: 'group' }, [
			UI.el('h3', { text: 'preview' }),
			dom.viewRow.row,
			controls.exposure.row,
			controls.headroom.row,
			UI.el('div', { class: 'chips' }, [controls.histogram.row, controls.histLog.row])
		]));

		dom.controls.appendChild(UI.el('div', { class: 'group' }, [
			UI.el('h3', { text: 'encoding' }),
			controls.baseQuality.row,
			controls.gainQuality.row,
			UI.buttons([
				{ label: 'save ultra hdr jpeg', onClick: save, title: 'writes SDR + gain map + XMP + MPF' },
				{ label: 'export jpeg pair + json', onClick: exportPair, title: 'for tools/avif_gainmap.py' }
			]),
			dom.link,
			UI.el('pre', { class: 'report' })
		]));
	dom.report = dom.controls.querySelector('.report');
	dom.controls.appendChild(dom.img.parentNode);  // saved-file thumbnail goes last
}

	function refreshLut() {
		state.lut = CURVE.sample(state.curve.points, SAMPLES);
		var mn = 1, mx = 0;
		for (var i = 0; i < state.lut.length; i++) {
			if (state.lut[i] < mn) mn = state.lut[i];
			if (state.lut[i] > mx) mx = state.lut[i];
		}
		state.lutMin = mn;
		state.lutMax = mx;
	}

	function setCurve(points) {
		state.curve.points = points;
		refreshLut();
		curveView.draw();
		render();
	}

	function curveChanged() {
		refreshLut();
		render();
	}

	// ── boot ─────────────────────────────────────────────────────────────────

	async function main() {
		dom.canvas = document.getElementById('view');
		dom.histo = document.getElementById('histo');
		dom.viewCol = document.getElementById('viewcol');
		dom.viewWrap = document.getElementById('viewwrap');
		dom.img = document.getElementById('saved');
		dom.controls = document.getElementById('controls');
		dom.status = document.getElementById('status');
		dom.gpu = document.getElementById('gpu');
		dom.drop = document.getElementById('drop');
		dom.curveBox = document.getElementById('curve');
		dom.link = UI.el('a', { class: 'hidden', text: 'download ultra hdr jpeg' });

		dom.viewRow = UI.radio('view', [
			{ value: 'hdr', label: 'HDR (full)' },
			{ value: 'sdr', label: 'SDR base' },
			{ value: 'gain', label: 'gain map' },
			{ value: 'file', label: 'saved file (adapted)' }
		], 'hdr', function (v) {
			state.view = v;
			render();
		});
		dom.viewRadio = dom.viewRow;

		state.curve.points = CURVE.rampPoints(state.params.threshold);
		curveView = CURVE.editor(dom.curveBox, state.curve, curveChanged);
		lastCap = capacityMax();
		state.params.highlightGain = lastCap;

		try {
			gpu = await GPUX.init(dom.canvas);
		} catch (e) {
			dom.gpu.textContent = e.message;
			return;
		}
		device = gpu.device;
		context = gpu.context;
		samp = GPUX.sampler(device);
		ubo = device.createBuffer({
			size: params.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		makePipelines();

		state.params.headroom = GPUX.headroom();
		dom.gpu.textContent = 'WebGPU · HDR canvas ' + (gpu.hdrCanvas ? 'on' : 'off (SDR only)') +
			' · headroom ' + state.params.headroom.toFixed(2) + '×';

		buildUI();
		controls.headroom.set(state.params.headroom);
		refreshLut();
		fitHisto();

		dom.drop.addEventListener('dragover', function (e) {
			e.preventDefault();
			dom.drop.classList.add('over');
		});
		dom.drop.addEventListener('dragleave', function () {
			dom.drop.classList.remove('over');
		});
		dom.drop.addEventListener('drop', function (e) {
			e.preventDefault();
			dom.drop.classList.remove('over');
			var file = e.dataTransfer.files[0];
			if (file) openFile(file);
		});
		document.getElementById('open').addEventListener('change', function (e) {
			if (e.target.files[0]) openFile(e.target.files[0]);
		});
		document.getElementById('patterns').addEventListener('click', function (e) {
			if (e.target.dataset.kind) usePattern(e.target.dataset.kind);
		});
		window.addEventListener('resize', function () {
			if (!srcTex) return;
			fitCanvas();
			fitHisto();
			render();
		});

		usePattern('sky');
	}

	window.addEventListener('DOMContentLoaded', main);
})();
