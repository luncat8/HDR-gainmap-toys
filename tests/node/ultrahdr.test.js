// node tests/node/ultrahdr.test.js
// Builds an Ultra HDR JPEG from tests/data/*.jpg, checks the structure and the
// gain map math. Writes tests/out/test-ultrahdr.jpg for inspection with exiftool.
'use strict';

const fs = require('fs');
const path = require('path');
const UHDR = require('../../src/ultrahdr.js');

const here = path.join(__dirname, '..');
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + detail}`);
}

const base = new Uint8Array(fs.readFileSync(path.join(here, 'data/base.jpg')));
const gainmap = new Uint8Array(fs.readFileSync(path.join(here, 'data/gainmap.jpg')));

const meta = {
	gainMapMin: 0,
	gainMapMax: Math.log2(1000 / 203),
	hdrCapacityMin: 0,
	hdrCapacityMax: Math.log2(1000 / 203),
	offsetSDR: 0,
	offsetHDR: 0,
	gamma: 1
};

const built = UHDR.buildUltraHDR(base, gainmap, meta);
const file = path.join(out, 'test-ultrahdr.jpg');
fs.writeFileSync(file, Buffer.from(built.bytes));
console.log(`wrote ${file}  ${built.bytes.length} bytes` +
	` (primary ${built.primarySize}, gain map ${built.gainMapLength})`);

// ── structure ──────────────────────────────────────────────────────────────
check('starts with SOI', built.bytes[0] === 0xff && built.bytes[1] === 0xd8);
const mpf = UHDR.parseMPF(built.bytes);
check('MPF has 2 images', mpf && mpf.images.length === 2);
check('primary attribute is 0x00030000', mpf.images[0].attribute === 0x00030000,
	'0x' + mpf.images[0].attribute.toString(16));
check('primary offset is 0', mpf.images[0].fileOffset === 0, mpf.images[0].fileOffset);
check('primary size covers SOI..EOI', mpf.images[0].size === built.primarySize,
	`${mpf.images[0].size} vs ${built.primarySize}`);
const gmAt = mpf.images[1].fileOffset;
check('gain map offset points at a SOI',
	built.bytes[gmAt] === 0xff && built.bytes[gmAt + 1] === 0xd8, 'at ' + gmAt);
check('gain map size matches', mpf.images[1].size === built.gainMapLength);

const segs = UHDR.segments(built.bytes.subarray(0, gmAt));
check('primary XMP is the first segment', segs[0].marker === 0xe1 && segs[1].marker === 0xe2);
const gsegs = UHDR.segments(built.bytes.subarray(gmAt));
check('gain map XMP is its first segment after SOI', gsegs[0].marker === 0xe1);

// ── round trip parse ───────────────────────────────────────────────────────
const parsed = UHDR.parseUltraHDR(built.bytes);
check('parsed version', parsed.meta.version === '1.0', parsed.meta.version);
check('parsed gain map max', Math.abs(parsed.meta.gainMapMax - meta.gainMapMax) < 1e-6,
	parsed.meta.gainMapMax);
check('parsed capacity max', Math.abs(parsed.meta.hdrCapacityMax - meta.hdrCapacityMax) < 1e-6);
check('base slice is a JPEG',
	parsed.base[0] === 0xff && parsed.base[1] === 0xd8 && parsed.base[parsed.base.length - 1] === 0xd9);
check('gain map slice is a JPEG',
	parsed.gainmap[0] === 0xff && parsed.gainmap[1] === 0xd8 &&
	parsed.gainmap[parsed.gainmap.length - 1] === 0xd9);

// ── gain map math ──────────────────────────────────────────────────────────
const w = 4, h = 1, gw = 4, gh = 1; // same resolution: no resampling in this check
const sdr = new Float32Array([0.5, 0.5, 0.5, 1, 0.25, 0.25, 0.25, 1,
	1, 1, 1, 1, 0.125, 0.125, 0.125, 1]);
const gm = new Uint8Array([0, 64, 128, 255]);
const hdr = UHDR.applyGainMap(sdr, w, h, gm, gw, gh, parsed.meta, Math.pow(2, meta.gainMapMax));
const expect = (v, e) => v * Math.pow(2, meta.gainMapMax * e);
check('recovery 0/255 → no boost', Math.abs(hdr[0] - sdr[0]) < 1e-6, hdr[0]);
check('recovery 255/255 → full boost',
	Math.abs(hdr[12] - expect(0.125, 1)) < 1e-5, `${hdr[12]} vs ${expect(0.125, 1)}`);
check('recovery 128/255 → sqrt of full boost',
	Math.abs(hdr[8] - expect(1, 128 / 255)) < 1e-5, `${hdr[8]} vs ${expect(1, 128 / 255)}`);
check('recovery 64/255 → quarter of full stops',
	Math.abs(hdr[4] - expect(0.25, 64 / 255)) < 1e-5, `${hdr[4]} vs ${expect(0.25, 64 / 255)}`);
check('boost is per-pixel, not per-image',
	Math.abs(hdr[4] / sdr[4] - Math.pow(2, meta.gainMapMax * 64 / 255)) < 1e-5);
const half = UHDR.weightFactor(parsed.meta, Math.pow(2, meta.gainMapMax / 2));
check('half headroom weights the boost', Math.abs(half - 0.5) < 1e-6, half);
check('no headroom → no boost', UHDR.weightFactor(parsed.meta, 1) === 0);

console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed');
process.exit(failures ? 1 : 0);
