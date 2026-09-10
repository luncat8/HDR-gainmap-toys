// HDR gain map toy: SDR source -> authored HDR -> Ultra HDR JPEG -> check.
(function () {
	'use strict';

	var SAMPLES = SHADERS.LUT_SAMPLES;
	var MAX_WORK = 4096;   // working resolution cap: rgba16float + jpeg encode

	var state = {
		sourceName: '',
		source: null,          // drawable (ImageBitmap or canvas)
		srcW: 0,
		srcH: 0,
		params: {
			peakNits: 1000,
			sdrWhite: 203,
			floorStops: 0,
			gainScale: 4,
			exposure: 0,
			headroom: 4,
			baseQuality: 92,
			gainQuality: 85
		},
		view: 'hdr',
		curve: { points: CURVE.PRESETS.highlights.map(function (p) { return p.slice(); }) },
		lut: null,
		file: null
	};

	var gpu = null, device = null, context = null;
	var srcTex = null, gainTex = null, hdrTex = null;
	var fileBaseTex = null, fileGainTex = null, fileMeta = null;
	var gainW = 0, gainH = 0;
	var ubo = null, samp = null;
	var gainPipe = null, applyPipe = null, presentPipe = null;
	var bgGain = null, bgApply = null, bgFileApply = null, bgPresent = null, bgGainView = null;
	var params = new Float32Array(12 + SAMPLES);
	var controls = {};
	var dom = {};
	var curveView = null;

	// ── derived ──────────────────────────────────────────────────────────────

	function maxStops() {
		return Math.log2(state.params.peakNits / state.params.sdrWhite);
	}

	function minStops() {
		return Math.min(state.params.floorStops, maxStops() - 0.01);
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
		[srcTex, gainTex, hdrTex].forEach(function (t) { if (t) t.destroy(); });
		var gs = gainSize();
		gainW = gs[0];
		gainH = gs[1];
		srcTex = GPUX.imageTexture(device, state.srcW, state.srcH);
		gainTex = GPUX.renderTexture(device, gainW, gainH, GPUX.RGBA8);
		hdrTex = GPUX.renderTexture(device, state.srcW, state.srcH, GPUX.HDRTEX);
		GPUX.uploadImage(device, srcTex, state.source, state.srcW, state.srcH);
		bgGain = bindGroup(srcTex, srcTex);
		bgApply = bindGroup(srcTex, gainTex);
		bgPresent = bindGroup(hdrTex, hdrTex);
		bgGainView = bindGroup(gainTex, gainTex);
	}

	function allocForFile(w, h, gw, gh, base, gain) {
		[fileBaseTex, fileGainTex].forEach(function (t) { if (t) t.destroy(); });
		fileBaseTex = GPUX.imageTexture(device, w, h);
		fileGainTex = GPUX.imageTexture(device, gw, gh);
		GPUX.uploadImage(device, fileBaseTex, base, w, h);
		GPUX.uploadImage(device, fileGainTex, gain, gw, gh);
		bgFileApply = bindGroup(fileBaseTex, fileGainTex);
	}

	// One uniform write per frame: the three passes use disjoint fields.
	function writeParams(p) {
		params[0] = p.minStops;
		params[1] = p.maxStops;
		params[2] = Math.max(p.minStops, 0);
		params[3] = p.maxStops;
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

	var MODES = { hdr: 0, sdr: 1, gain: 2 };

	function render() {
		if (!device || !srcTex) return;
		var useFile = state.view === 'file' && bgFileApply;
		var headroom = useFile ? 1e6 : state.params.headroom; // decoded view: show intent
		var fileMin = fileMeta ? fileMeta.gainMapMin : 0;
		var fileMax = fileMeta ? fileMeta.gainMapMax : 1;

		writeParams({
			minStops: useFile ? fileMin : minStops(),
			maxStops: useFile ? fileMax : maxStops(),
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
		}), presentPipe, state.view === 'gain' ? bgGainView : bgPresent);
		device.queue.submit([enc.finish()]);
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
		allocForSource();
		render();
		status(name + ' — ' + state.srcW + '×' + state.srcH +
			(size[0] !== w ? ' (from ' + w + '×' + h + ')' : ''));
	}

	function fitCanvas() {
		var maxW = Math.min(1100, dom.viewCol.clientWidth || 900);
		var k = Math.min(1, maxW / state.srcW);
		dom.canvas.width = Math.max(1, Math.round(state.srcW * k));
		dom.canvas.height = Math.max(1, Math.round(state.srcH * k));
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

	// ── save ─────────────────────────────────────────────────────────────────

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

	async function save() {
		if (!srcTex) return;
		status('encoding…');
		var p = state.params;
		var baseBlob = await toBlob(state.source, state.srcW, state.srcH,
			'image/jpeg', p.baseQuality / 100);
		var raw = await GPUX.readTexture(device, gainTex, gainW, gainH, GPUX.RGBA8);
		var gmCanvas = PATTERNS.canvasOf(gainW, gainH);
		gmCanvas.getContext('2d').putImageData(gainImageData(raw, gainW, gainH), 0, 0);
		var gmBlob = await new Promise(function (resolve) {
			gmCanvas.toBlob(resolve, 'image/jpeg', p.gainQuality / 100);
		});

		var meta = {
			gainMapMin: minStops(),
			gainMapMax: maxStops(),
			hdrCapacityMin: Math.max(minStops(), 0),
			hdrCapacityMax: maxStops(),
			offsetSDR: 0,
			offsetHDR: 0,
			gamma: 1
		};
		var built = UHDR.buildUltraHDR(await bytesOf(baseBlob), await bytesOf(gmBlob), meta);
		var blob = new Blob([built.bytes], { type: 'image/jpeg' });

		state.file = { blob: blob, bytes: built.bytes, meta: built.meta, built: built };
		if (state.file.url) URL.revokeObjectURL(state.file.url);
		state.file.url = URL.createObjectURL(blob);

		var stem = (state.sourceName || 'image').replace(/\.[^.]+$/, '');
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
		var p = state.params;
		var base = await toBlob(state.source, state.srcW, state.srcH, 'image/png');
		var raw = await GPUX.readTexture(device, gainTex, gainW, gainH, GPUX.RGBA8);
		var gmCanvas = PATTERNS.canvasOf(gainW, gainH);
		gmCanvas.getContext('2d').putImageData(gainImageData(raw, gainW, gainH), 0, 0);
		var gm = await new Promise(function (r) { gmCanvas.toBlob(r, 'image/png'); });

		var stem = (state.sourceName || 'image').replace(/\.[^.]+$/, '');
		saveBlob(base, stem + '_base.png');
		saveBlob(gm, stem + '_gainmap.png');
		var meta = {
			gainMapMin: minStops(),
			gainMapMax: maxStops(),
			hdrCapacityMin: Math.max(minStops(), 0),
			hdrCapacityMax: maxStops(),
			offsetSDR: 0,
			offsetHDR: 0,
			gamma: 1,
			baseWidth: state.srcW,
			baseHeight: state.srcH,
			gainMapWidth: gainW,
			gainMapHeight: gainH,
			sdrWhiteNits: state.params.sdrWhite,
			peakNits: state.params.peakNits
		};
		saveBlob(new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' }),
			stem + '_gainmap.json');
		status('exported base.png + gainmap.png + json — run tools/avif_gainmap.py');
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

	function buildUI() {
		var p = state.params;
		controls.peakNits = UI.slider({
			label: 'peak nits', min: 100, max: 4000, step: 10, value: p.peakNits,
			format: function (v) { return v.toFixed(0) + ' nits'; },
			onInput: function (v) { p.peakNits = v; render(); }
		});
		controls.sdrWhite = UI.slider({
			label: 'SDR white', min: 80, max: 400, step: 1, value: p.sdrWhite,
			format: function (v) { return v.toFixed(0) + ' nits'; },
			onInput: function (v) { p.sdrWhite = v; render(); }
		});
		controls.floorStops = UI.slider({
			label: 'floor gain', min: -2, max: 1, step: 0.05, value: p.floorStops,
			format: function (v) { return v.toFixed(2) + ' stops'; },
			onInput: function (v) { p.floorStops = v; render(); }
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

		dom.controls.appendChild(UI.el('div', { class: 'group' }, [
			UI.el('h3', { text: 'HDR range' }),
			controls.peakNits.row,
			controls.sdrWhite.row,
			controls.floorStops.row,
			controls.gainScale.row
		]));

		dom.controls.appendChild(UI.el('div', { class: 'group' }, [
			UI.el('h3', { text: 'curve — luminance → boost' }),
			dom.curveBox,
			UI.el('div', { class: 'buttons' }, Object.keys(CURVE.PRESETS).map(function (name) {
				return UI.el('button', {
					type: 'button', text: name,
					onclick: function () {
						state.curve.points = CURVE.PRESETS[name].map(function (pt) { return pt.slice(); });
						curveChanged();
						curveView.draw();
					}
				});
			}))
		]));

		dom.controls.appendChild(UI.el('div', { class: 'group' }, [
			UI.el('h3', { text: 'preview' }),
			dom.viewRow.row,
			controls.exposure.row,
			controls.headroom.row
		]));

		dom.controls.appendChild(UI.el('div', { class: 'group' }, [
			UI.el('h3', { text: 'encoding' }),
			controls.baseQuality.row,
			controls.gainQuality.row,
			UI.buttons([
				{ label: 'save ultra hdr jpeg', onClick: save, title: 'writes SDR + gain map + XMP + MPF' },
				{ label: 'export png pair + json', onClick: exportPair, title: 'for tools/avif_gainmap.py' }
			]),
			dom.link,
			UI.el('pre', { class: 'report' })
		]));
		dom.report = dom.controls.querySelector('.report');
	}

	function curveChanged() {
		state.lut = CURVE.sample(state.curve.points, SAMPLES);
		render();
	}

	// ── boot ─────────────────────────────────────────────────────────────────

	async function main() {
		dom.canvas = document.getElementById('view');
		dom.viewCol = document.getElementById('viewcol');
		dom.img = document.getElementById('saved');
		dom.controls = document.getElementById('controls');
		dom.status = document.getElementById('status');
		dom.gpu = document.getElementById('gpu');
		dom.drop = document.getElementById('drop');
		dom.curveBox = document.getElementById('curve');
		dom.link = UI.el('a', { class: 'hidden', text: 'download ultra hdr jpeg' });

		dom.viewRow = UI.radio('view', [
			{ value: 'hdr', label: 'HDR' },
			{ value: 'sdr', label: 'clamped' },
			{ value: 'gain', label: 'gain map' },
			{ value: 'file', label: 'saved file' }
		], 'hdr', function (v) {
			state.view = v;
			render();
		});
		dom.viewRadio = dom.viewRow;

		curveView = CURVE.editor(dom.curveBox, state.curve, curveChanged);

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
		state.lut = CURVE.sample(state.curve.points, SAMPLES);

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
			render();
		});

		usePattern('sky');
	}

	window.addEventListener('DOMContentLoaded', main);
})();
