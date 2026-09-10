// Ultra HDR (ISO 21496-1 / Adobe gain map) JPEG container: XMP + MPF assembly,
// parsing and the standard gain map decode. Runs in browser and node.
//
// File layout produced here:
//   SOI | APP1 XMP (hdrgm + GContainer) | APP2 MPF | rest of base JPEG | EOI
//   SOI | APP1 XMP (hdrgm)              | rest of gain map JPEG      | EOI
//
// Reference: Ultra HDR Image Format v1.0, CIPA DC-007 (MPF), Adobe hdrgm XMP.
(function (root) {
	'use strict';

	var XAP = 'http://ns.adobe.com/xap/1.0/\u0000';
	var HDRGM_NS = 'http://ns.adobe.com/hdr-gain-map/1.0/';

	function u8(n) {
		return new Uint8Array(n);
	}

	function concat(parts) {
		var total = 0, i;
		for (i = 0; i < parts.length; i++) total += parts[i].length;
		var out = u8(total), at = 0;
		for (i = 0; i < parts.length; i++) {
			out.set(parts[i], at);
			at += parts[i].length;
		}
		return out;
	}

	function ascii(s) {
		var out = u8(s.length);
		for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
		return out;
	}

	function utf8(s) {
		return new TextEncoder().encode(s);
	}

	function latin(s) {
		return new TextDecoder('utf-8').decode(s);
	}

	// ── JPEG segments ────────────────────────────────────────────────────────
	// Walk the top level of a JPEG: stops at SOS payload, which is skipped to EOI.

	function segments(b) {
		var out = [], i = 2;
		if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG (no SOI)');
		while (i + 1 < b.length) {
			if (b[i] !== 0xff) throw new Error('bad JPEG at ' + i);
			var marker = b[i + 1];
			if (marker === 0xd9) {
				out.push({ marker: 0xd9, start: i, length: 2, end: i + 2 });
				return out;
			}
			if (marker === 0xda) {
				var end = skipEntropy(b, i);
				out.push({ marker: 0xda, start: i, length: end - i, end: end });
				i = end;
				continue;
			}
			var len = (b[i + 2] << 8) | b[i + 3];
			out.push({ marker: marker, start: i, length: len + 2, end: i + len + 2 });
			i += len + 2;
		}
		return out;
	}

	function skipEntropy(b, sos) {
		var i = sos + 2 + ((b[sos + 2] << 8) | b[sos + 3]);
		while (i + 1 < b.length) {
			if (b[i] !== 0xff) {
				i++;
				continue;
			}
			var m = b[i + 1];
			if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
				i += 2;
				continue;
			}
			return i;
		}
		return b.length;
	}

	function findSegment(b, marker, id) {
		var segs = segments(b);
		for (var i = 0; i < segs.length; i++) {
			var s = segs[i];
			if (s.marker !== marker) continue;
			if (id && !startsWith(b, s.start + 4, id)) continue;
			return s;
		}
		return null;
	}

	function startsWith(b, at, id) {
		for (var i = 0; i < id.length; i++) if (b[at + i] !== id.charCodeAt(i)) return false;
		return true;
	}

	// ── XMP ──────────────────────────────────────────────────────────────────

	function f6(x) {
		return (Math.round(x * 1e6) / 1e6).toFixed(6);
	}

	// Attribute layout and packet wrapper follow Google reference samples.
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
			body += '      <Container:Item Item:Mime="image/jpeg" Item:Semantic="GainMap"' +
				' Item:Length="' + meta.gainMapLength + '"/>\n';
			body += '     </rdf:li>\n    </rdf:Seq>\n   </Container:Directory>\n';
			body += '  </rdf:Description>\n';
		} else {
			body = '  <rdf:Description rdf:about=""\n' + ns + a + '/>\n';
		}

		return '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
			'<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 5.5.0">\n' +
			' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
			body +
			' </rdf:RDF>\n</x:xmpmeta>\n' +
			'<?xpacket end="w"?>';
	}

	function xmpApp1(meta, withContainer) {
		var payload = concat([ascii(XAP), utf8(buildXMP(meta, withContainer))]);
		var seg = u8(2 + 2 + payload.length);
		seg[0] = 0xff;
		seg[1] = 0xe1;
		seg[2] = ((payload.length + 2) >> 8) & 0xff;
		seg[3] = (payload.length + 2) & 0xff;
		seg.set(payload, 4);
		return seg;
	}

	var XMP_FIELDS = {
		Version: 'version',
		GainMapMin: 'gainMapMin',
		GainMapMax: 'gainMapMax',
		HDRCapacityMin: 'hdrCapacityMin',
		HDRCapacityMax: 'hdrCapacityMax',
		OffsetSDR: 'offsetSDR',
		OffsetHDR: 'offsetHDR',
		Gamma: 'gamma',
		BaseRenditionIsHDR: 'baseRenditionIsHDR'
	};

	function parseXMP(text) {
		var meta = { gamma: 1, offsetSDR: 0, offsetHDR: 0, baseRenditionIsHDR: false };
		var re = /([A-Za-z]+):([A-Za-z]+)="([^"]*)"/g, m;
		while ((m = re.exec(text))) {
			var key = XMP_FIELDS[m[2]];
			if (!key) continue;
			meta[key] = key === 'version' || key === 'baseRenditionIsHDR' ?
				m[3] : numbers(m[3]);
		}
		if (text.indexOf('BaseRenditionIsHDR="True"') >= 0) meta.baseRenditionIsHDR = true;
		return meta;
	}

	function numbers(s) {
		var parts = s.split(','), out = [];
		for (var i = 0; i < parts.length; i++) out.push(parseFloat(parts[i]));
		return out.length === 1 ? out[0] : out;
	}

	function xmpOf(b, at) {
		var seg = findSegment(b, 0xe1, XAP);
		if (!seg) return null;
		return latin(b.subarray(seg.start + 4 + XAP.length, seg.end));
	}

	// ── MPF (CIPA DC-007) ────────────────────────────────────────────────────
	// Little endian TIFF, 3 entries, offsets relative to the TIFF header that
	// follows the "MPF\0" signature (as in Google reference files).

	function mpfApp2(primarySize, secondarySize, secondaryOffset) {
		var data = u8(86);
		data.set(ascii('MPF\u0000'), 0);
		data.set(ascii('II'), 4);
		data[6] = 42;
		data[7] = 0;
		data[8] = 8; // IFD0 at TIFF offset 8
		data[9] = 0;
		data[10] = 0;
		data[11] = 0;
		var p = 12;
		data[p] = 3; // entry count
		p += 2;
		p = putEntry(data, p, 0xb000, 7, 4, ascii('0100'));
		p = putEntry(data, p, 0xb001, 4, 1, u32le(2));
		p = putEntry(data, p, 0xb002, 7, 32, u32le(50));
		data.set(u32le(0), p); // next IFD
		p += 4;
		data.set(u32le(0x00030000), p);
		data.set(u32le(primarySize), p + 4);
		data.set(u32le(0), p + 8);
		data.set(u32le(0x00000000), p + 12);
		data.set(u32le(secondarySize), p + 16);
		data.set(u32le(secondaryOffset), p + 20);

		var seg = u8(2 + 2 + data.length);
		seg[0] = 0xff;
		seg[1] = 0xe2;
		seg[2] = ((data.length + 2) >> 8) & 0xff;
		seg[3] = (data.length + 2) & 0xff;
		seg.set(data, 4);
		return seg;
	}

	function putEntry(data, p, tag, type, count, value) {
		data[p] = tag & 0xff;
		data[p + 1] = (tag >> 8) & 0xff;
		data[p + 2] = type & 0xff;
		data[p + 3] = (type >> 8) & 0xff;
		data.set(u32le(count), p + 4);
		data.set(value, p + 8);
		return p + 12;
	}

	function u32le(v) {
		return u8([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
	}

	function parseMPF(b) {
		var seg = findSegment(b, 0xe2, 'MPF\u0000');
		if (!seg) return null;
		var tiff = seg.start + 4 + 4;
		var le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
		function u16(at) {
			return le ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1];
		}
		function u32(at) {
			return le ?
				b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] * 0x1000000) :
				(b[at] * 0x1000000) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
		}
		var ifd = tiff + u32(tiff + 4);
		var count = u16(ifd);
		var list = null, images = 0;
		for (var i = 0; i < count; i++) {
			var e = ifd + 2 + i * 12;
			var tag = u16(e);
			if (tag === 0xb001) images = u32(e + 8);
			if (tag === 0xb002) list = tiff + u32(e + 8);
		}
		if (list === null) return null;
		var out = [];
		for (var k = 0; k < images; k++) {
			var at = list + k * 16;
			var raw = u32(at + 8);
			// Offsets are relative to the TIFF header; the first image carries 0
			// and means "the container itself", i.e. file offset 0.
			var fileOffset = k === 0 && raw === 0 ? 0 : raw + tiff;
			out.push({
				attribute: u32(at),
				size: u32(at + 4),
				offset: raw,
				fileOffset: fileOffset,
				dep1: u16(at + 12),
				dep2: u16(at + 14)
			});
		}
		return { images: out, tiffOffset: tiff, segment: seg };
	}

	// ── assembly ─────────────────────────────────────────────────────────────

	function normalizeMeta(meta) {
		var m = Object.assign({
			gainMapMin: 0,
			gainMapMax: 1,
			hdrCapacityMin: 0,
			hdrCapacityMax: 1,
			offsetSDR: 0,
			offsetHDR: 0,
			gamma: 1
		}, meta);
		m.hdrCapacityMin = Math.max(m.hdrCapacityMin, Math.min(m.gainMapMin, 0));
		return m;
	}

	// base, gainmap: Uint8Array of complete JPEG files (SOI..EOI).
	function buildUltraHDR(base, gainmap, meta) {
		if (base[0] !== 0xff || base[1] !== 0xd8) throw new Error('base is not a JPEG');
		if (gainmap[0] !== 0xff || gainmap[1] !== 0xd8) throw new Error('gain map is not a JPEG');

		var m = normalizeMeta(meta);
		var xmpGain = xmpApp1(m, false);
		var gainmapOut = concat([gainmap.subarray(0, 2), xmpGain, gainmap.subarray(2)]);
		m = Object.assign({}, m, { gainMapLength: gainmapOut.length });
		var xmpBase = xmpApp1(m, true);
		var mpf = mpfApp2(0, 0, 0); // placeholder, patched below

		var head = concat([base.subarray(0, 2), xmpBase, mpf, base.subarray(2)]);
		var primarySize = head.length;
		// MPF offsets are relative to the TIFF header: SOI + xmp + FFE2 + len + "MPF\0"
		var tiffOffset = 2 + xmpBase.length + 2 + 2 + 4;
		patchMPF(head, 2 + xmpBase.length, primarySize, gainmapOut.length,
			primarySize - tiffOffset);

		return {
			bytes: concat([head, gainmapOut]),
			meta: m,
			primarySize: primarySize,
			gainMapLength: gainmapOut.length
		};
	}

	function patchMPF(b, mpfStart, primarySize, secondarySize, secondaryOffset) {
		var list = mpfStart + 8 + 50; // FFE2 + len + "MPF\0" + TIFF hdr + IFD at TIFF offset 50
		b.set(u32le(primarySize), list + 4);
		b.set(u32le(secondarySize), list + 16 + 4);
		b.set(u32le(secondaryOffset), list + 16 + 8);
	}

	// ── parsing ──────────────────────────────────────────────────────────────

	function parseUltraHDR(b) {
		var mpf = parseMPF(b);
		if (!mpf || mpf.images.length < 2) throw new Error('no MPF with 2 images');
		var primary = mpf.images[0];
		var gain = mpf.images[1];
		var start = gain.fileOffset > 0 && gain.fileOffset < b.length ?
			gain.fileOffset : primary.size;
		if (b[start] !== 0xff || b[start + 1] !== 0xd8) throw new Error('MPF offset misses a SOI');
		var end = Math.min(start + gain.size, b.length);
		if (b[end - 2] !== 0xff || b[end - 1] !== 0xd9) end = endOfImage(b, start);

		var xmp = xmpOf(b.subarray(0, start));
		var meta = xmp ? parseXMP(xmp) : null;
		if (!meta || meta.version === undefined) {
			var gainXmp = xmpOf(b.subarray(start, end));
			if (gainXmp) meta = parseXMP(gainXmp);
		}
		if (!meta || meta.version === undefined) throw new Error('no hdrgm XMP metadata');

		return {
			base: b.subarray(0, start),
			gainmap: b.subarray(start, end),
			meta: meta,
			images: mpf.images,
			primarySize: primary.size,
			gainMapOffset: start
		};
	}

	// width, height and component count from the first SOF marker
	function jpegInfo(b) {
		var segs = segments(b);
		for (var i = 0; i < segs.length; i++) {
			var m = segs[i].marker;
			if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
				var at = segs[i].start;
				return {
					height: (b[at + 5] << 8) | b[at + 6],
					width: (b[at + 7] << 8) | b[at + 8],
					components: b[at + 9]
				};
			}
		}
		throw new Error('no SOF in JPEG');
	}

	function endOfImage(b, from) {
		var i = from + 2;
		while (i + 1 < b.length) {
			if (b[i] !== 0xff) {
				i++;
				continue;
			}
			if (b[i + 1] === 0xd9) return i + 2;
			if (b[i + 1] === 0xda) {
				i = skipEntropy(b, i);
				continue;
			}
			i += 2 + ((b[i + 2] << 8) | b[i + 3]);
		}
		return b.length;
	}

	// ── gain map math (Ultra HDR v1.0 "Display") ─────────────────────────────

	function weightFactor(meta, displayBoost) {
		var min = num(meta.hdrCapacityMin, 0);
		var max = num(meta.hdrCapacityMax, 1);
		var span = max - min;
		if (span <= 0) return displayBoost >= Math.pow(2, max) ? 1 : 0;
		var w = (Math.log2(displayBoost) - min) / span;
		w = Math.min(1, Math.max(0, w));
		return meta.baseRenditionIsHDR ? 1 - w : w;
	}

	function num(v, i) {
		return typeof v === 'number' ? v : v[i || 0];
	}

	// sdr: Float32Array linear RGB (in place out), gain: Uint8Array single channel
	// at (gw,gh), bilinear sampled to (w,h). Writes linear HDR RGB into out.
	function applyGainMap(sdr, w, h, gain, gw, gh, meta, displayBoost) {
		var out = new Float32Array(sdr.length);
		var min = num(meta.gainMapMin), max = num(meta.gainMapMax);
		var offS = num(meta.offsetSDR, 0), offH = num(meta.offsetHDR, 0);
		var gamma = meta.gamma || 1;
		var weight = weightFactor(meta, displayBoost || Math.pow(2, max));
		for (var y = 0; y < h; y++) {
			var fy = (y + 0.5) * gh / h - 0.5;
			var y0 = Math.floor(fy), ty = fy - y0;
			var y0c = Math.min(gh - 1, Math.max(0, y0));
			var y1c = Math.min(gh - 1, Math.max(0, y0 + 1));
			for (var x = 0; x < w; x++) {
				var fx = (x + 0.5) * gw / w - 0.5;
				var x0 = Math.floor(fx), tx = fx - x0;
				var x0c = Math.min(gw - 1, Math.max(0, x0));
				var x1c = Math.min(gw - 1, Math.max(0, x0 + 1));
				var a = gain[y0c * gw + x0c], bb = gain[y0c * gw + x1c];
				var c = gain[y1c * gw + x0c], d = gain[y1c * gw + x1c];
				var r = (a + (bb - a) * tx) + ((c + (d - c) * tx) - (a + (bb - a) * tx)) * ty;
				var logRecovery = Math.pow(r / 255, 1 / gamma);
				var logBoost = min * (1 - logRecovery) + max * logRecovery;
				var gainV = Math.pow(2, logBoost * weight);
				var i = (y * w + x) * 4;
				out[i] = (sdr[i] + offS) * gainV - offH;
				out[i + 1] = (sdr[i + 1] + offS) * gainV - offH;
				out[i + 2] = (sdr[i + 2] + offS) * gainV - offH;
				out[i + 3] = sdr[i + 3];
			}
		}
		return out;
	}

	var api = {
		buildUltraHDR: buildUltraHDR,
		parseUltraHDR: parseUltraHDR,
		applyGainMap: applyGainMap,
		weightFactor: weightFactor,
		buildXMP: buildXMP,
		xmpApp1: xmpApp1,
		parseXMP: parseXMP,
		mpfApp2: mpfApp2,
		parseMPF: parseMPF,
		segments: segments,
		jpegInfo: jpegInfo,
		xmpOf: xmpOf,
		HDRGM_NS: HDRGM_NS
	};

	root.UHDR = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
