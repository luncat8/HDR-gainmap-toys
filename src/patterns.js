// Synthesized test sources, so the whole pipeline can be exercised without a file.
(function (root) {
	'use strict';

	function canvasOf(w, h) {
		var c = document.createElement('canvas');
		c.width = w;
		c.height = h;
		return c;
	}

	function ramp(ctx, w, h) {
		var g = ctx.createLinearGradient(0, 0, w, 0);
		g.addColorStop(0, '#000');
		g.addColorStop(1, '#fff');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, w, h);

		var sun = ctx.createRadialGradient(w * 0.72, h * 0.3, 0, w * 0.72, h * 0.3, w * 0.16);
		sun.addColorStop(0, '#fff');
		sun.addColorStop(0.25, '#fffbe8');
		sun.addColorStop(1, 'rgba(255,240,200,0)');
		ctx.fillStyle = sun;
		ctx.fillRect(0, 0, w, h);

		var bars = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'];
		var bh = Math.round(h * 0.12);
		for (var i = 0; i < bars.length; i++) {
			ctx.fillStyle = bars[i];
			ctx.fillRect(Math.round(i * w / bars.length), h - bh,
				Math.round(w / bars.length), bh);
		}
	}

	function sky(ctx, w, h) {
		var g = ctx.createLinearGradient(0, 0, 0, h);
		g.addColorStop(0, '#0a1230');
		g.addColorStop(0.55, '#2a4a8f');
		g.addColorStop(0.8, '#e2723c');
		g.addColorStop(1, '#120a08');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, w, h);

		var sun = ctx.createRadialGradient(w * 0.5, h * 0.62, 0, w * 0.5, h * 0.62, w * 0.22);
		sun.addColorStop(0, '#ffffff');
		sun.addColorStop(0.12, '#fff4d0');
		sun.addColorStop(1, 'rgba(255,180,90,0)');
		ctx.fillStyle = sun;
		ctx.fillRect(0, 0, w, h);

		ctx.fillStyle = '#05070c';
		ctx.beginPath();
		ctx.moveTo(0, h);
		for (var x = 0; x <= w; x += 8) {
			ctx.lineTo(x, h * (0.78 + 0.05 * Math.sin(x / w * 7) + 0.03 * Math.sin(x / w * 23)));
		}
		ctx.lineTo(w, h);
		ctx.fill();
	}

	function steps(ctx, w, h) {
		var n = 10;
		for (var i = 0; i < n; i++) {
			var v = Math.round(i / (n - 1) * 255);
			ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
			ctx.fillRect(Math.round(i * w / n), 0, Math.round(w / n) - 2, Math.round(h * 0.7));
		}
		var sun = ctx.createRadialGradient(w * 0.5, h * 0.85, 0, w * 0.5, h * 0.85, w * 0.1);
		sun.addColorStop(0, '#fff');
		sun.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = sun;
		ctx.fillRect(0, Math.round(h * 0.7), w, Math.round(h * 0.3));
	}

	var KINDS = { ramp: ramp, sky: sky, steps: steps };

	function make(kind, w, h) {
		var c = canvasOf(w, h);
		(KINDS[kind] || ramp)(c.getContext('2d'), w, h);
		return c;
	}

	var api = { make: make, kinds: Object.keys(KINDS), canvasOf: canvasOf };

	root.PATTERNS = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
