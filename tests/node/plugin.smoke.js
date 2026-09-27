// node tests/node/plugin.smoke.js
// Drives hdr-gainmap-plugin.js against a stubbed DOM + WebGPU. It catches
// wiring errors that otherwise only show up as a red status line in a browser
// (the curve editor drawing before any capture set a curve, for one).
// No WGSL runs here, so it complements a browser check, it does not replace it.
'use strict';

const path = require('path');
const pluginPath = path.join(__dirname, '..', '..', 'hdr-gainmap-plugin.js');

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + detail}`);
}

// ── DOM stub ───────────────────────────────────────────────────────────────

const allNodes = [];

function ctx2d(canvas) {
	return {
		canvas,
		fillStyle: '', strokeStyle: '', lineWidth: 1,
		clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
		stroke() {}, arc() {}, fill() {}, drawImage() {},
		createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
		putImageData() {},
		getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
	};
}

function matches(node, sel) {
	if (sel.charAt(0) === '#') return node.id === sel.slice(1);
	if (sel.charAt(0) === '.') return String(node.className).split(' ').indexOf(sel.slice(1)) >= 0;
	return node.tagName === sel.toUpperCase();
}

function element(tag) {
	const node = {
		tagName: tag.toUpperCase(),
		id: '', className: '', textContent: '', title: '', value: '',
		children: [], style: {}, attrs: {}, _listeners: {},
		classList: {
			_names: new Set(),
			add(n) { this._names.add(n); },
			remove(n) { this._names.delete(n); },
			toggle(n) { this._names.has(n) ? this._names.delete(n) : this._names.add(n); },
			contains(n) { return this._names.has(n); }
		},
		appendChild(kid) { node.children.push(kid); return kid; },
		remove() {}, click() {}, focus() {},
		setAttribute(k, v) { node.attrs[k] = String(v); },
		getAttribute(k) { return k in node.attrs ? node.attrs[k] : null; },
		closest() { return null; },
		getBoundingClientRect() { return { left: 0, top: 0, right: node.width || 100, bottom: node.height || 100, width: node.width || 100, height: node.height || 100 }; },
		addEventListener(type, fn) { (node._listeners[type] ||= []).push(fn); },
		_fire(type, event) { return Promise.all((node._listeners[type] || []).map(fn => fn(event || {}))); },
		querySelectorAll(sel) {
			const out = [];
			(function walk(n) {
				for (const kid of n.children) { if (matches(kid, sel)) out.push(kid); walk(kid); }
			})(node);
			return out;
		},
		querySelector(sel) { return node.querySelectorAll(sel)[0] || null; }
	};
	Object.defineProperty(node, 'innerHTML', {
		get() { return ''; },
		set(html) { node.children.length = 0; parseInto(node, html); }
	});
	allNodes.push(node);
	return node;
}

// minimal tag-stack parser: enough for the plugin's one innerHTML template
function parseInto(root, html) {
	const stack = [root];
	const re = /<\/?([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9:_-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
	let m;
	while ((m = re.exec(html))) {
		const [, tag, attrText, selfClose] = m;
		if (m[0].charAt(1) === '/') { if (stack.length > 1) stack.pop(); continue; }
		const node = tag === 'canvas' ? makeCanvas(1, 1) : element(tag);
		const attrRe = /([a-zA-Z0-9:_-]+)\s*=\s*"([^"]*)"/g;
		let a;
		while ((a = attrRe.exec(attrText))) {
			node.setAttribute(a[1], a[2]);
			if (a[1] === 'id') node.id = a[2];
			if (a[1] === 'class') node.className = a[2];
			if (a[1] === 'width' || a[1] === 'height') node[a[1]] = parseInt(a[2], 10);
		}
		stack[stack.length - 1].appendChild(node);
		if (!selfClose && tag !== 'br' && tag !== 'input' && tag !== 'img') stack.push(node);
	}
}

// the plugin patches HTMLCanvasElement.prototype.getContext, so canvases must
// really inherit it — an own getContext property would bypass the patch.
function HTMLCanvasElementStub() {}
HTMLCanvasElementStub.prototype.getContext = function (type) {
	this._contexts ||= {};
	if (!this._contexts[type]) this._contexts[type] = type === '2d' ? ctx2d(this) : webgpuContext(this);
	return this._contexts[type];
};
global.HTMLCanvasElement = HTMLCanvasElementStub;

function makeCanvas(w, h) {
	const c = element('canvas');
	Object.setPrototypeOf(c, HTMLCanvasElementStub.prototype);
	c.width = w; c.height = h;
	c.toBlob = (cb) => cb({ arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer });
	return c;
}

const head = element('head');
const body = element('body');
global.document = {
	readyState: 'complete',
	head, body,
	createElement: (tag) => (tag === 'canvas' ? makeCanvas(1, 1) : element(tag)),
	getElementById: (id) => allNodes.find(n => n.id === id) || null,
	querySelectorAll: (sel) => allNodes.filter(n => matches(n, sel)),
	addEventListener() {}
};
global.MutationObserver = class { observe() {} disconnect() {} };
global.setInterval = () => 0;
global.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
global.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, devicePixelRatio: 1 };
global.createImageBitmap = async (canvas) => ({ width: canvas.width, height: canvas.height });
global.TextEncoder = require('util').TextEncoder;

// ── WebGPU stub ────────────────────────────────────────────────────────────

global.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8, MAP_READ: 1, COPY_SRC: 4 };
global.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1, COPY_DST: 2 };
global.GPUShaderStage = { FRAGMENT: 2, VERTEX: 1 };
global.GPUMapMode = { READ: 1 };

const calls = { submits: 0, passes: 0, textures: [], configures: [] };

function makeDevice() {
	return {
		createShaderModule: () => ({}),
		createBindGroupLayout: () => ({}),
		createPipelineLayout: () => ({}),
		createRenderPipeline: () => ({}),
		createSampler: () => ({}),
		createBindGroup: () => ({}),
		createBuffer: (d) => ({
			size: d.size,
			mapAsync: async () => {},
			getMappedRange: () => new ArrayBuffer(d.size),
			unmap() {}, destroy() {}
		}),
		createTexture: (d) => {
			calls.textures.push(d.format + ' ' + d.size[0] + 'x' + d.size[1]);
			return { createView: () => ({}), destroy() {} };
		},
		createCommandEncoder: () => ({
			beginRenderPass: () => { calls.passes++; return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }; },
			copyTextureToBuffer() {},
			finish: () => ({})
		}),
		queue: { writeBuffer() {}, writeTexture() {}, submit() { calls.submits++; } }
	};
}

const appDevice = makeDevice();

function webgpuContext(canvas) {
	return {
		configure(config) { calls.configures.push(config); this._config = config; },
		getConfiguration() { return this._config || null; },
		getCurrentTexture: () => ({ width: canvas.width, height: canvas.height, createView: () => ({}) })
	};
}

Object.defineProperty(global, 'navigator', {
	value: { gpu: { requestAdapter: async () => ({ requestDevice: async () => makeDevice() }) } },
	writable: true, configurable: true
});

// ── run ────────────────────────────────────────────────────────────────────

const plugin = require(pluginPath);

(async () => {
	const errors = [];
	process.on('unhandledRejection', e => errors.push(e));

	const status = () => (document.getElementById('hdr-status') || {}).textContent || '';

	check('UI built on load', !!document.getElementById('hdr-plugin-panel'));
	check('curve editor drew before any capture', !!document.getElementById('hdr-curve'));

	// SDR capture — this is the path that used to throw on the very first click,
	// because the curve editor drew with state.curvePoints still null.
	const sdrCanvas = makeCanvas(320, 200);
	await plugin.captureSDR(sdrCanvas);
	check('SDR capture succeeded', /^SDR captured 320×200/.test(status()), JSON.stringify(status()));

	// HDR capture — swapchain readback is resolved by the next queue.submit()
	const hdrCanvas = makeCanvas(64, 32);
	const ctx = hdrCanvas.getContext('webgpu');
	ctx.configure({ device: appDevice, format: 'rgba16float', colorSpace: 'srgb', toneMapping: { mode: 'extended' }, alphaMode: 'opaque' });
	check('plugin added COPY_SRC to swapchain usage',
		(calls.configures[0].usage & GPUTextureUsage.COPY_SRC) !== 0, calls.configures[0].usage);
	check('plugin kept the extended tone mapping',
		calls.configures[0].toneMapping.mode === 'extended');

	ctx.getCurrentTexture();
	const captured = plugin.captureHDR(hdrCanvas);
	setTimeout(() => { ctx.getCurrentTexture(); appDevice.queue.submit([]); }, 0);
	await captured;
	check('HDR capture succeeded', /^HDR captured 64×32/.test(status()), JSON.stringify(status()));
	check('HDR pipeline allocated an rgba16float source', calls.textures.includes('rgba16float 64x32'), calls.textures.join(' | '));
	check('gain map is 1/4 of the HDR source', calls.textures.includes('rgba8unorm 16x8'), calls.textures.join(' | '));

	await new Promise(r => setTimeout(r, 30));
	check('no unhandled rejections', errors.length === 0, errors.map(e => (e && e.stack) || String(e)).join(' | '));

	console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed');
	process.exit(failures ? 1 : 0);
})();
