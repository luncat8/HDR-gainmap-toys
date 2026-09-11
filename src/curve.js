// Tone curve: monotone cubic spline through control points + a small editor.
// Maps SDR luminance (0..1) to the authored boost (0..1 of the min..max range).
(function (root) {
	'use strict';

	var PRESETS = {
		linear: [[0, 0], [1, 1]],
		highlights: [[0, 0], [0.55, 0.05], [0.85, 0.5], [1, 1]],
		shadows: [[0, 1], [0.25, 0.45], [0.6, 0.05], [1, 0]],
		scurve: [[0, 0], [0.25, 0.08], [0.5, 0.35], [0.75, 0.72], [1, 1]],
		flat: [[0, 0.5], [1, 0.5]]
	};

	// Parametric "highlights" curve: nothing below `threshold`, then a monotone
	// rise to 1.0 at white. The spline through three points gives a smooth S
	// with a flat shadow region, which is what the quick tone sliders use.
	function rampPoints(threshold) {
		threshold = Math.min(0.99, Math.max(0.01, threshold));
		return [[0, 0], [threshold, 0], [1, 1]];
	}

	// Fritsch-Carlson tangents: no overshoot, so the gain never rings.
	function tangents(pts) {
		var n = pts.length;
		var dx = [], slope = [], t = new Array(n);
		var i;
		for (i = 0; i < n - 1; i++) {
			dx[i] = Math.max(1e-6, pts[i + 1][0] - pts[i][0]);
			slope[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
		}
		t[0] = slope[0];
		t[n - 1] = slope[n - 2];
		for (i = 1; i < n - 1; i++) {
			if (slope[i - 1] * slope[i] <= 0) {
				t[i] = 0;
				continue;
			}
			var w1 = 2 * dx[i] + dx[i - 1];
			var w2 = dx[i] + 2 * dx[i - 1];
			t[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
		}
		return t;
	}

	function evalAt(pts, t, x) {
		if (x <= pts[0][0]) return pts[0][1];
		var last = pts.length - 1;
		if (x >= pts[last][0]) return pts[last][1];
		var i = 0;
		while (i < last - 1 && pts[i + 1][0] < x) i++;
		var h = pts[i + 1][0] - pts[i][0];
		var s = (x - pts[i][0]) / h;
		var s2 = s * s, s3 = s2 * s;
		var h00 = 2 * s3 - 3 * s2 + 1;
		var h10 = s3 - 2 * s2 + s;
		var h01 = -2 * s3 + 3 * s2;
		var h11 = s3 - s2;
		return h00 * pts[i][1] + h10 * h * t[i] + h01 * pts[i + 1][1] + h11 * h * t[i + 1];
	}

	function sample(points, count) {
		var t = tangents(points);
		var out = new Float32Array(count);
		for (var i = 0; i < count; i++) {
			var x = i / (count - 1);
			out[i] = Math.min(1, Math.max(0, evalAt(points, t, x)));
		}
		return out;
	}

	// ── editor ───────────────────────────────────────────────────────────────

	function editor(canvas, state, onChange) {
		var ctx = canvas.getContext('2d');
		var drag = -1;

		function toPx(p) {
			var w = canvas.width, h = canvas.height;
			return [p[0] * w, (1 - p[1]) * h];
		}

		function fromPx(px, py) {
			return [Math.min(1, Math.max(0, px / canvas.width)),
				Math.min(1, Math.max(0, 1 - py / canvas.height))];
		}

		function draw() {
			var w = canvas.width, h = canvas.height;
			ctx.clearRect(0, 0, w, h);
			ctx.fillStyle = '#12151b';
			ctx.fillRect(0, 0, w, h);

			ctx.strokeStyle = '#242a35';
			ctx.lineWidth = 1;
			for (var g = 1; g < 4; g++) {
				var x = Math.round(w * g / 4) + 0.5;
				var y = Math.round(h * g / 4) + 0.5;
				ctx.beginPath();
				ctx.moveTo(x, 0);
				ctx.lineTo(x, h);
				ctx.moveTo(0, y);
				ctx.lineTo(w, y);
				ctx.stroke();
			}

			var lut = sample(state.points, 128);
			ctx.strokeStyle = '#7fd4ff';
			ctx.lineWidth = 2;
			ctx.beginPath();
			for (var i = 0; i < lut.length; i++) {
				var px = i / (lut.length - 1) * w;
				var py = (1 - lut[i]) * h;
				if (i === 0) ctx.moveTo(px, py);
				else ctx.lineTo(px, py);
			}
			ctx.stroke();

			for (var k = 0; k < state.points.length; k++) {
				var p = toPx(state.points[k]);
				ctx.beginPath();
				ctx.arc(p[0], p[1], 5, 0, Math.PI * 2);
				ctx.fillStyle = k === drag ? '#ffd479' : '#e8eef7';
				ctx.fill();
			}
			ctx.fillStyle = '#5b6472';
			ctx.font = '11px system-ui, sans-serif';
			ctx.fillText('luminance → boost', 6, h - 6);
		}

		function hit(px, py) {
			for (var k = 0; k < state.points.length; k++) {
				var p = toPx(state.points[k]);
				var d = Math.hypot(p[0] - px, p[1] - py);
				if (d < 12) return k;
			}
			return -1;
		}

		// canvas space, not CSS pixels: the element is displayed scaled
		function local(e) {
			var r = canvas.getBoundingClientRect();
			return [(e.clientX - r.left) * canvas.width / r.width,
				(e.clientY - r.top) * canvas.height / r.height];
		}

		canvas.addEventListener('pointerdown', function (e) {
			var p = local(e);
			drag = hit(p[0], p[1]);
			if (drag < 0 && !e.shiftKey) {
				var np = fromPx(p[0], p[1]);
				state.points.push(np);
				state.points.sort(function (a, b) { return a[0] - b[0]; });
				drag = state.points.indexOf(np);
			}
			if (drag >= 0 && e.shiftKey && state.points.length > 2) {
				state.points.splice(drag, 1);
				drag = -1;
			}
			draw();
			onChange();
		});

		canvas.addEventListener('pointermove', function (e) {
			if (drag < 0) return;
			var p = local(e);
			var pt = fromPx(p[0], p[1]);
			var min = drag > 0 ? state.points[drag - 1][0] + 0.01 : 0;
			var max = drag < state.points.length - 1 ? state.points[drag + 1][0] - 0.01 : 1;
			pt[0] = Math.min(max, Math.max(min, pt[0]));
			state.points[drag] = pt;
			draw();
			onChange();
		});

		window.addEventListener('pointerup', function () {
			drag = -1;
			draw();
		});

		draw();
		return { draw: draw };
	}

	var api = {
		PRESETS: PRESETS,
		sample: sample,
		rampPoints: rampPoints,
		evalAt: function (points, x) { return evalAt(points, tangents(points), x); },
		editor: editor
	};

	root.CURVE = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
