// node tests/node/wgsl.check.mjs   (needs: npm i wgsl_reflect)
// Parses every WGSL template literal in the demos and the plugin, so a typo in
// a shader shows up here instead of as a silent black canvas in the browser.
// The literals interpolate a few JS constants; they are supplied below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

let WgslReflect;
for (const spec of ['wgsl_reflect', process.env.WGSL_REFLECT]) {
	if (!spec || WgslReflect) continue;
	try { ({ WgslReflect } = await import(spec)); } catch (e) {}
}
if (!WgslReflect) {
	// `npm i wgsl_reflect` here, or point WGSL_REFLECT at an installed copy
	console.log('skip: wgsl_reflect not installed (npm i wgsl_reflect)');
	process.exit(0);
}

// values the shader templates interpolate, per file
const scope = {
	'examples/hdr-canvas-demo.html': { LADDER: [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0] },
	'examples/hdr-selftest.html': { LADDER: [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0] },
	'hdr-gainmap-plugin.js': { LUT_SAMPLES: 64 }
};

const files = ['examples/hdr-canvas-demo.html', 'examples/galaxy-hdr-capture.html', 'examples/hdr-selftest.html', 'i2HDR_webGPU_example.html', 'hdr-gainmap-plugin.js'];

let failures = 0, shaders = 0;
for (const rel of files) {
	const text = fs.readFileSync(path.join(root, rel), 'utf8');
	const vars = scope[rel] || {};
	// template literals that look like WGSL: they all declare an entry point
	const re = /`([^`]*@(?:vertex|fragment|compute)[^`]*)`/g;
	let m;
	while ((m = re.exec(text))) {
		shaders++;
		let code;
		try {
			code = new Function(...Object.keys(vars), 'return `' + m[1] + '`')(...Object.values(vars));
		} catch (e) {
			failures++;
			console.log(`FAIL ${rel}: cannot expand template — ${e.message}`);
			continue;
		}
		try {
			const r = new WgslReflect(code);
			const entries = [...r.entry.vertex, ...r.entry.fragment, ...r.entry.compute].map(e => e.name);
			console.log(`ok   ${rel}: ${entries.join(', ')}`);
		} catch (e) {
			failures++;
			console.log(`FAIL ${rel}: ${e.message}`);
		}
	}
}

console.log(failures ? `\n${failures} of ${shaders} shaders failed` : `\nall ${shaders} shaders parse`);
process.exit(failures ? 1 : 0);
