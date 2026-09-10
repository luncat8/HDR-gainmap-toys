// WebGPU helpers: device + HDR canvas, texture upload, readback.
(function (root) {
	'use strict';

	var RGBA8 = 'rgba8unorm';
	var HDRTEX = 'rgba16float';

	// ── setup ────────────────────────────────────────────────────────────────

	async function init(canvas) {
		if (!navigator.gpu) throw new Error('WebGPU is not available (needs Chrome 151+)');
		var adapter = await navigator.gpu.requestAdapter();
		if (!adapter) throw new Error('no WebGPU adapter');
		var device = await adapter.requestDevice();
		var context = canvas.getContext('webgpu');
		context.configure({
			device: device,
			format: HDRTEX,
			colorSpace: 'srgb',
			toneMapping: { mode: 'extended' },
			alphaMode: 'opaque'
		});
		var config = context.getConfiguration();
		return {
			device: device,
			context: context,
			canvasFormat: HDRTEX,
			// Chrome reports 'standard' when the platform cannot do extended range
			hdrCanvas: config.toneMapping && config.toneMapping.mode === 'extended',
			adapter: adapter
		};
	}

	function headroom() {
		var h = window.screen && window.screen.highDynamicRangeHeadroom;
		if (typeof h === 'number' && isFinite(h) && h > 0) return h;
		return window.matchMedia && window.matchMedia('(dynamic-range: high)').matches ? 4 : 1;
	}

	// ── textures ─────────────────────────────────────────────────────────────

	function texture(device, w, h, format, usage) {
		return device.createTexture({
			size: [w, h, 1],
			format: format,
			usage: usage
		});
	}

	var TU = typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage : null;
	var TXU = typeof GPUTextureUsage !== 'undefined' ? GPUTextureUsage : null;

	function imageTexture(device, w, h) {
		return texture(device, w, h, RGBA8,
			TXU.TEXTURE_BINDING | TXU.COPY_DST);
	}

	function renderTexture(device, w, h, format) {
		return texture(device, w, h, format,
			TXU.RENDER_ATTACHMENT | TXU.TEXTURE_BINDING | TXU.COPY_SRC);
	}

	function sampler(device) {
		return device.createSampler({
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge'
		});
	}

	// Upload via getImageData + writeTexture: no color management surprises for
	// either photos (sRGB bytes) or gain maps (plain data).
	var scratchCanvas = null;
	function uploadImage(device, tex, source, w, h) {
		if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
		scratchCanvas.width = w;
		scratchCanvas.height = h;
		var ctx = scratchCanvas.getContext('2d', { willReadFrequently: true });
		ctx.clearRect(0, 0, w, h);
		ctx.drawImage(source, 0, 0, w, h);
		return uploadPixels(device, tex, ctx.getImageData(0, 0, w, h).data, w, h, 4);
	}

	// writeTexture needs bytesPerRow padded to 256.
	function uploadPixels(device, tex, pixels, w, h, bytesPerPixel) {
		var row = w * bytesPerPixel;
		var padded = Math.ceil(row / 256) * 256;
		var bytes;
		if (padded === row) {
			bytes = pixels;
		} else {
			bytes = new Uint8Array(padded * h);
			for (var y = 0; y < h; y++) {
				bytes.set(pixels.subarray(y * row, y * row + row), y * padded);
			}
		}
		device.queue.writeTexture(
			{ texture: tex },
			bytes,
			{ bytesPerRow: padded, rowsPerImage: h },
			{ width: w, height: h }
		);
	}

	// ── readback ─────────────────────────────────────────────────────────────

	function bytesPerPixel(format) {
		if (format === RGBA8) return 4;
		if (format === HDRTEX) return 8;
		throw new Error('unsupported readback format ' + format);
	}

	async function readTexture(device, tex, w, h, format) {
		var bpp = bytesPerPixel(format);
		var padded = Math.ceil(w * bpp / 256) * 256;
		var buffer = device.createBuffer({
			size: padded * h,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		var enc = device.createCommandEncoder();
		enc.copyTextureToBuffer(
			{ texture: tex },
			{ buffer: buffer, bytesPerRow: padded, rowsPerImage: h },
			{ width: w, height: h }
		);
		device.queue.submit([enc.finish()]);
		await buffer.mapAsync(GPUMapMode.READ);
		var raw = new Uint8Array(buffer.getMappedRange().slice(0));
		buffer.unmap();
		buffer.destroy();
		if (padded === w * bpp) return raw;
		var out = new Uint8Array(w * bpp * h);
		for (var y = 0; y < h; y++) {
			out.set(raw.subarray(y * padded, y * padded + w * bpp), y * w * bpp);
		}
		return out;
	}

	function halfToFloat(h) {
		var sign = (h & 0x8000) ? -1 : 1;
		var exp = (h >> 10) & 0x1f;
		var frac = h & 0x3ff;
		if (exp === 0) return sign * frac * 5.9604644775390625e-8;
		if (exp === 31) return frac ? NaN : sign * Infinity;
		return sign * (frac + 1024) * Math.pow(2, exp - 25);
	}

	// rgba16float readback → Float32Array of linear RGBA
	function halfRowsToFloat(raw, w, h) {
		var u16 = new Uint16Array(raw.buffer, raw.byteOffset, w * h * 4);
		var out = new Float32Array(w * h * 4);
		for (var i = 0; i < out.length; i++) out[i] = halfToFloat(u16[i]);
		return out;
	}

	// ── passes ───────────────────────────────────────────────────────────────

	function draw(encoder, pipeline, bindGroup) {
		encoder.setPipeline(pipeline);
		encoder.setBindGroup(0, bindGroup);
		encoder.draw(3);
		encoder.end();
	}

	var api = {
		init: init,
		headroom: headroom,
		texture: texture,
		imageTexture: imageTexture,
		renderTexture: renderTexture,
		sampler: sampler,
		uploadImage: uploadImage,
		uploadPixels: uploadPixels,
		readTexture: readTexture,
		halfRowsToFloat: halfRowsToFloat,
		halfToFloat: halfToFloat,
		draw: draw,
		RGBA8: RGBA8,
		HDRTEX: HDRTEX
	};

	root.GPUX = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
