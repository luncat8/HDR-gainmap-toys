// node tests/node/app.smoke.js
// Runs src/app.js against a stubbed DOM + WebGPU: catches wiring errors that
// would otherwise only appear in a browser. It does not execute WGSL and does
// not encode real JPEGs, so it complements (not replaces) a browser run.
'use strict';

const fs = require('fs');
const path = require('path');
const here = path.join(__dirname, '..');
const src = path.join(here, '..', 'src');
const baseJpeg = fs.readFileSync(path.join(here, 'data/base.jpg'));
const gainJpeg = fs.readFileSync(path.join(here, 'data/gainmap.jpg'));

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + detail}`);
}

// ── DOM stub ───────────────────────────────────────────────────────────────

function ctx2d(canvas) {
	const gradient = { addColorStop() {} };
	return {
		canvas,
		fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
		clearRect() {}, fillRect() {}, strokeRect() {},
		createLinearGradient: () => gradient,
		createRadialGradient: () => gradient,
		beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, closePath() {},
		fill() {}, stroke() {}, fillText() {}, drawImage() {},
		putImageData(d) { canvas._imageData = d; },
		getImageData(x, y, w, h) {
			const data = new Uint8ClampedArray(w * h * 4);
			for (let i = 0; i < w * h; i++) {
				const v = Math.round((i % w) / w * 255);
				data[i * 4] = v;
				data[i * 4 + 1] = v;
				data[i * 4 + 2] = v;
				data[i * 4 + 3] = 255;
			}
			return { data, width: w, height: h };
		}
	};
}

function element(tag) {
	const node = {
		tagName: tag.toUpperCase(),
		children: [],
		className: '',
		textContent: '',
		dataset: {},
		style: {},
		_listeners: {},
		classList: {
			_names: new Set(),
			add(n) { this._names.add(n); },
			remove(n) { this._names.delete(n); },
			contains(n) { return this._names.has(n); }
		},
		appendChild(kid) { node.children.push(kid); return kid; },
		remove() {}, click() {}, setAttribute() {},
		addEventListener(type, fn) { (node._listeners[type] ||= []).push(fn); },
		_fire(type, event) {
			return Promise.all((node._listeners[type] || []).map(fn => fn(event || {})));
		},
		querySelector(sel) {
			const want = sel.replace('.', '');
			for (const kid of node.children) {
				if (kid.className === want) return kid;
				const deep = kid.querySelector && kid.querySelector(sel);
				if (deep) return deep;
			}
			return null;
		}
	};
	Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
	return node;
}

function makeCanvas(w, h) {
	const c = element('canvas');
	c.width = w;
	c.height = h;
	c._ctx = ctx2d(c);
	c.getContext = (kind) => (kind === '2d' ? c._ctx : webgpuContext());
	c.toBlob = (cb) => cb(new Blob([c._imageData ? gainJpeg : baseJpeg], { type: 'image/jpeg' }));
	return c;
}

const ids = {};
['view', 'viewcol', 'saved', 'status', 'gpu', 'drop', 'open', 'patterns', 'controls', 'curve']
	.forEach(id => {
		ids[id] = id === 'view' ? makeCanvas(900, 600) :
			id === 'curve' ? makeCanvas(300, 190) : element('div');
		ids[id].id = id;
	});
ids.viewcol.clientWidth = 900;

global.document = {
	getElementById: (id) => ids[id] || null,
	createElement: (tag) => (tag === 'canvas' ? makeCanvas(1, 1) : element(tag)),
	body: element('body')
};
global.ImageData = class ImageData {
	constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
};
global.URL.createObjectURL = () => 'blob:stub';
global.URL.revokeObjectURL = () => {};
global.createImageBitmap = async (blob) => {
	const UHDR = require(path.join(src, 'ultrahdr.js'));
	const info = UHDR.jpegInfo(new Uint8Array(await blob.arrayBuffer()));
	return { width: info.width, height: info.height };
};

// ── WebGPU stub ────────────────────────────────────────────────────────────

global.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8, MAP_READ: 1, COPY_SRC: 4, VERTEX: 32, STORAGE: 128 };
global.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1, COPY_DST: 2 };
global.GPUShaderStage = { FRAGMENT: 2, VERTEX: 1, COMPUTE: 4 };
global.GPUMapMode = { READ: 1 };

const calls = { pipelines: 0, passes: 0, submits: 0, uploads: 0, readbacks: 0, textures: [] };

const device = {
	limits: { maxTextureDimension2D: 8192 },
	createShaderModule: () => ({}),
	createBindGroupLayout: () => ({}),
	createPipelineLayout: () => ({}),
	createRenderPipeline: () => { calls.pipelines++; return {}; },
	createBuffer: () => ({ destroy() {} }),
	createTexture: (d) => {
		calls.textures.push(d.format + ' ' + d.size[0] + 'x' + d.size[1]);
		return { size: d.size, format: d.format, createView: () => ({}), destroy() {} };
	},
	createSampler: () => ({}),
	createBindGroup: () => ({}),
	createCommandEncoder: () => ({
		beginRenderPass: () => {
			calls.passes++;
			return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
		},
		copyTextureToBuffer() {},
		finish: () => ({})
	}),
	queue: {
		writeBuffer() {},
		writeTexture() { calls.uploads++; },
		submit() { calls.submits++; }
	}
};

Object.defineProperty(global, 'navigator', {
	value: {
		gpu: {
			requestAdapter: async () => ({ requestDevice: async () => device, info: { vendor: 'stub' } })
		}
	},
	writable: true,
	configurable: true
});

function webgpuContext() {
	return {
		configure: () => {},
		getConfiguration: () => ({ toneMapping: { mode: 'extended' } }),
		getCurrentTexture: () => ({ createView: () => ({}) })
	};
}

// ── load ───────────────────────────────────────────────────────────────────

const listeners = {};
global.window = {
	screen: { highDynamicRangeHeadroom: 4 },
	matchMedia: () => ({ matches: true }),
	addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }
};
global.addEventListener = global.window.addEventListener;

['ultrahdr', 'gpu', 'shaders', 'curve', 'patterns', 'ui', 'app'].forEach(f => {
	require(path.join(src, f + '.js'));
});

// only the readback needs plausible bytes
const GPUX = require(path.join(src, 'gpu.js'));
GPUX.readTexture = async function (dev, tex, w, h, format) {
	calls.readbacks++;
	return new Uint8Array(w * h * (format === 'rgba16float' ? 8 : 4));
};

function findButton(label, node) {
	for (const kid of (node || ids.controls).children || []) {
		if (kid.textContent === label) return kid;
		const deep = findButton(label, kid);
		if (deep) return deep;
	}
	return null;
}

(async () => {
	const errors = [];
	process.on('unhandledRejection', e => errors.push(e));

	check('app registered DOMContentLoaded', !!listeners.DOMContentLoaded);
	try {
		await Promise.all(listeners.DOMContentLoaded.map(fn => fn()));
	} catch (e) {
		console.log('BOOT ERROR:', e && e.stack || e);
		process.exit(2);
	}

	check('three pipelines', calls.pipelines === 3, calls.pipelines);
	check('three passes per render', calls.passes === 3, calls.passes);
	check('gain map is 1/4 of source',
		calls.textures.includes('rgba8unorm 320x200'), calls.textures.join(' | '));
	check('hdr texture is rgba16float',
		calls.textures.includes('rgba16float 1280x800'), calls.textures.join(' | '));
	check('gpu line reports HDR canvas', /HDR canvas on/.test(ids.gpu.textContent),
		ids.gpu.textContent);

	const save = findButton('save ultra hdr jpeg');
	check('save button exists', !!save);
	await save._fire('click');

	const report = ids.controls.querySelector('.report');
	check('report written', report.textContent.length > 20, JSON.stringify(report.textContent));
	check('report mentions the gain map', /gain map\s+64×64/.test(report.textContent));
	check('report mentions the boost', /boost\)/.test(report.textContent));
	check('gain map was read back for encoding', calls.readbacks >= 1, calls.readbacks);

	const exportPair = findButton('export png pair + json');
	check('export button exists', !!exportPair);

	check('no unhandled rejections', errors.length === 0, errors.map(String).join(' | '));

	console.log('---- report ----\n' + report.textContent + '\n----');
	console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed');
	process.exit(failures ? 1 : 0);
})();
