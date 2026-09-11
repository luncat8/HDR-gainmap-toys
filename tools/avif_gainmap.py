#!/usr/bin/env python3
"""Ultra HDR JPEG -> gain map AVIF, with a built-in fallback converter.

preferred path (needs a libavif built *with* libxml2):

    avifgainmaputil convert in.ultrahdr.jpg out.avif       (default)
    avifenc --qgain-map QG -q Q in.ultrahdr.jpg out.avif   (--avifenc)

many avifgainmaputil builds ship without libxml2 and then refuse JPEG gain
map input ("JPEG gainmap conversion unavailable..."). when the external
converter fails, this script falls back to a built-in path that needs no
libxml2: it splits the Ultra HDR JPEG here (XMP + MPF), encodes the two
renditions with avifenc, and re-packs them into an AVIF gain map file - the
same 'tmap' container libavif itself writes, carrying the *authored* gain map
unchanged. nothing is recomputed.

    python3 tools/avif_gainmap.py photo_ultrahdr.jpg [-o out.avif]
    python3 tools/avif_gainmap.py base.jpg gainmap.jpg meta.json [-o out.avif]

options: -q quality, --qgain-map quality, --gainmaputil PATH,
--avifenc-bin PATH, --dry-run.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

XAP = "http://ns.adobe.com/xap/1.0/\u0000"
HDRGM_NS = "http://ns.adobe.com/hdr-gain-map/1.0/"


def f6(x: float) -> str:
    return f"{x:.6f}"


# ── ultra hdr jpeg: assembly ────────────────────────────────────────────────


def build_xmp(meta: dict, with_container: bool) -> str:
    a = (
        '   hdrgm:Version="1.0"\n'
        f'   hdrgm:GainMapMin="{f6(meta["gainMapMin"])}"\n'
        f'   hdrgm:GainMapMax="{f6(meta["gainMapMax"])}"\n'
        f'   hdrgm:HDRCapacityMin="{f6(meta["hdrCapacityMin"])}"\n'
        f'   hdrgm:HDRCapacityMax="{f6(meta["hdrCapacityMax"])}"\n'
        f'   hdrgm:OffsetHDR="{f6(meta.get("offsetHDR", 0))}"\n'
        f'   hdrgm:OffsetSDR="{f6(meta.get("offsetSDR", 0))}"'
    )
    ns = f'    xmlns:hdrgm="{HDRGM_NS}"\n'
    if with_container:
        ns += '    xmlns:Container="http://ns.google.com/photos/1.0/container/"\n'
        ns += '    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"\n'
        body = f'  <rdf:Description rdf:about=""\n{ns}{a}>\n'
        body += "   <Container:Directory>\n    <rdf:Seq>\n"
        body += '     <rdf:li rdf:parseType="Resource">\n'
        body += '      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary"/>\n'
        body += '     </rdf:li>\n     <rdf:li rdf:parseType="Resource">\n'
        body += '      <Container:Item Item:Mime="image/jpeg" Item:Semantic="GainMap"'
        body += f' Item:Length="{meta["gainMapLength"]}"/>\n'
        body += '     </rdf:li>\n    </rdf:Seq>\n   </Container:Directory>\n'
        body += "  </rdf:Description>\n"
    else:
        body = f'  <rdf:Description rdf:about=""\n{ns}{a}/>\n'

    return (
        '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 5.5.0">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        + body
        + ' </rdf:RDF>\n</x:xmpmeta>\n'
        + '<?xpacket end="w"?>'
    )


def app1(xmp: str) -> bytes:
    payload = XAP.encode("ascii") + xmp.encode("utf-8")
    length = len(payload) + 2
    return b"\xff\xe1" + length.to_bytes(2, "big") + payload


def u32le(v: int) -> bytes:
    return v.to_bytes(4, "little")


def put_entry(data: bytearray, p: int, tag: int, typ: int, count: int, value: bytes) -> int:
    data[p:p + 2] = tag.to_bytes(2, "little")
    data[p + 2:p + 4] = typ.to_bytes(2, "little")
    data[p + 4:p + 8] = count.to_bytes(4, "little")
    data[p + 8:p + 12] = value[:4].ljust(4, b"\x00")
    return p + 12


def mpf_app2(primary_size: int, secondary_size: int, secondary_offset: int) -> bytes:
    data = bytearray(86)
    data[0:4] = b"MPF\x00"
    data[4:6] = b"II"
    data[6] = 42
    data[8:12] = u32le(8)  # IFD0 at TIFF offset 8
    p = 12
    data[p:p + 2] = (3).to_bytes(2, "little")  # entry count
    p += 2
    p = put_entry(data, p, 0xB000, 7, 4, b"0100")
    p = put_entry(data, p, 0xB001, 4, 1, u32le(2))
    p = put_entry(data, p, 0xB002, 7, 32, u32le(50))
    data[p:p + 4] = u32le(0)  # next IFD
    p += 4
    data[p:p + 4] = u32le(0x00030000)
    data[p + 4:p + 8] = u32le(primary_size)
    data[p + 8:p + 12] = u32le(0)
    data[p + 12:p + 16] = u32le(0x00000000)
    data[p + 16:p + 20] = u32le(secondary_size)
    data[p + 20:p + 24] = u32le(secondary_offset)
    length = len(data) + 2
    return b"\xff\xe2" + length.to_bytes(2, "big") + bytes(data)


def patch_mpf(head: bytearray, mpf_start: int, primary_size: int,
              secondary_size: int, secondary_offset: int) -> None:
    lst = mpf_start + 8 + 50
    head[lst + 4:lst + 8] = u32le(primary_size)
    head[lst + 20:lst + 24] = u32le(secondary_size)
    head[lst + 24:lst + 28] = u32le(secondary_offset)


def normalize_meta(meta: dict) -> dict:
    m = {
        "gainMapMin": 0.0,
        "gainMapMax": 1.0,
        "hdrCapacityMin": 0.0,
        "hdrCapacityMax": 1.0,
        "offsetSDR": 0.0,
        "offsetHDR": 0.0,
        "gamma": 1.0,
    }
    m.update(meta)
    if isinstance(m["hdrCapacityMin"], (int, float)) and isinstance(m["gainMapMin"], (int, float)):
        m["hdrCapacityMin"] = max(m["hdrCapacityMin"], min(m["gainMapMin"], 0.0))
    return m


def build_ultrahdr(base: bytes, gainmap: bytes, meta: dict) -> bytes:
    if base[:2] != b"\xff\xd8":
        raise ValueError("base is not a JPEG")
    if gainmap[:2] != b"\xff\xd8":
        raise ValueError("gain map is not a JPEG")

    m = normalize_meta(meta)
    gain_out = gainmap[:2] + app1(build_xmp(m, False)) + gainmap[2:]
    m = {**m, "gainMapLength": len(gain_out)}
    xmp_base = app1(build_xmp(m, True))
    mpf = mpf_app2(0, 0, 0)  # placeholder, patched below
    head = bytearray(base[:2] + xmp_base + mpf + base[2:])
    primary_size = len(head)
    tiff_offset = 2 + len(xmp_base) + 2 + 2 + 4
    patch_mpf(head, 2 + len(xmp_base), primary_size, len(gain_out),
              primary_size - tiff_offset)
    return bytes(head) + gain_out


# ── ultra hdr jpeg: parsing (mirror of src/ultrahdr.js) ─────────────────────


def skip_entropy(b: bytes, sos: int) -> int:
    i = sos + 2 + ((b[sos + 2] << 8) | b[sos + 3])
    n = len(b)
    while i + 1 < n:
        if b[i] != 0xFF:
            i += 1
            continue
        m = b[i + 1]
        if m == 0x00 or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        return i
    return n


def jpeg_segments(b: bytes) -> list[tuple[int, int, int]]:
    if b[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG (no SOI)")
    segs, i = [], 2
    n = len(b)
    while i + 1 < n:
        if b[i] != 0xFF:
            raise ValueError(f"bad JPEG at {i}")
        marker = b[i + 1]
        if marker == 0xD9:
            segs.append((0xD9, i, i + 2))
            return segs
        if marker == 0xDA:
            end = skip_entropy(b, i)
            segs.append((0xDA, i, end))
            i = end
            continue
        ln = (b[i + 2] << 8) | b[i + 3]
        segs.append((marker, i, i + ln + 2))
        i += ln + 2
    return segs


def find_segment(b: bytes, marker: int, prefix: bytes) -> tuple[int, int] | None:
    for m, start, end in jpeg_segments(b):
        if m == marker and b.startswith(prefix, start + 4):
            return start, end
    return None


def parse_mpf(b: bytes) -> list[dict] | None:
    seg = find_segment(b, 0xE2, b"MPF\x00")
    if not seg:
        return None
    tiff = seg[0] + 8
    bo = "little" if b[tiff:tiff + 2] == b"II" else "big"

    def u16(at: int) -> int:
        return int.from_bytes(b[at:at + 2], bo)

    def u32(at: int) -> int:
        return int.from_bytes(b[at:at + 4], bo)

    ifd = tiff + u32(tiff + 4)
    images = 0
    lst = None
    for i in range(u16(ifd)):
        e = ifd + 2 + i * 12
        tag = u16(e)
        if tag == 0xB001:
            images = u32(e + 8)
        if tag == 0xB002:
            lst = tiff + u32(e + 8)
    if lst is None:
        return None
    out = []
    for k in range(images):
        at = lst + k * 16
        raw = u32(at + 8)
        # offsets are relative to the TIFF header; the first image carries 0
        # and means "the container itself", i.e. file offset 0
        out.append({
            "attribute": u32(at),
            "size": u32(at + 4),
            "offset": raw,
            "fileOffset": 0 if k == 0 and raw == 0 else raw + tiff,
        })
    return out


HDRGM_FIELDS = {
    "GainMapMin": "gainMapMin",
    "GainMapMax": "gainMapMax",
    "HDRCapacityMin": "hdrCapacityMin",
    "HDRCapacityMax": "hdrCapacityMax",
    "OffsetSDR": "offsetSDR",
    "OffsetHDR": "offsetHDR",
    "Gamma": "gamma",
    "Version": "version",
    "BaseRenditionIsHDR": "baseRenditionIsHDR",
}


def parse_hdrgm(text: str) -> dict:
    meta = {"gamma": 1.0, "offsetSDR": 0.0, "offsetHDR": 0.0}
    for m in re.finditer(r'([A-Za-z]+):([A-Za-z]+)="([^"]*)"', text):
        key = HDRGM_FIELDS.get(m.group(2))
        if not key:
            continue
        if key in ("version", "baseRenditionIsHDR"):
            meta[key] = m.group(3)
            continue
        vals = [float(x) for x in m.group(3).split(",")]
        meta[key] = vals[0] if len(vals) == 1 else vals
    return meta


def xmp_of(b: bytes) -> str | None:
    seg = find_segment(b, 0xE1, XAP.encode("ascii"))
    if not seg:
        return None
    return b[seg[0] + 4 + len(XAP):seg[1]].decode("utf-8", "replace")


def parse_ultrahdr(data: bytes) -> dict:
    """Ultra HDR JPEG -> {base, gainmap, meta}, same shape as UHDR.parseUltraHDR."""
    images = parse_mpf(data)
    if not images or len(images) < 2:
        raise ValueError("no MPF with 2 images")
    primary, gain = images[0], images[1]
    start = gain["fileOffset"] if 0 < gain["fileOffset"] < len(data) else primary["size"]
    if data[start:start + 2] != b"\xff\xd8":
        raise ValueError("MPF offset misses a SOI")
    end = min(start + gain["size"], len(data))
    if data[end - 2:end] != b"\xff\xd9":
        eoi = data.find(b"\xff\xd9", start)
        end = len(data) if eoi < 0 else eoi + 2

    meta = None
    xmp = xmp_of(data[:start])
    if xmp and "hdrgm:Version" in xmp:
        meta = parse_hdrgm(xmp)
    if not meta or "version" not in meta:
        gx = xmp_of(data[start:end])
        if not gx:
            raise ValueError("no hdrgm XMP metadata")
        meta = parse_hdrgm(gx)
    if meta.get("baseRenditionIsHDR") == "True":
        raise ValueError("BaseRenditionIsHDR=true files are not supported")
    return {"base": data[:start], "gainmap": data[start:end], "meta": meta}


# ── fractions (mirror of libavif avifDoubleToUnsignedFractionImpl) ──────────


def frac(v: float, max_num: int) -> tuple[int, int]:
    if v < 0 or v > max_num or math.isnan(v):
        raise ValueError(f"fraction out of range: {v}")
    max_d = 0xFFFFFFFF if v <= 1 else max_num // v
    d, prev_d = 1, 0
    cur = v - math.floor(v)
    for _ in range(39):
        n = round(d * v)
        if abs(d * v - n) == 0.0:
            return n, d
        cur = 1.0 / cur
        new_d = prev_d + math.floor(cur) * d
        if new_d > max_d:
            return n, d
        prev_d, d = d, int(new_d)
        cur -= math.floor(cur)
    return round(d * v), d


def sfrac(v: float) -> tuple[int, int]:
    n, d = frac(abs(v), 0x7FFFFFFF)
    return (-n if v < 0 else n), d


# ── avif boxes ───────────────────────────────────────────────────────────────


def box(typ: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + typ + payload


def fullbox(typ: bytes, version: int, flags: int, payload: bytes) -> bytes:
    return box(typ, bytes([version]) + flags.to_bytes(3, "big") + payload)


def box_iter(data: bytes, start: int, end: int):
    """yields (type, box start, payload start, box end)"""
    at = start
    while at + 8 <= end:
        size = int.from_bytes(data[at:at + 4], "big")
        hdr = 8
        if size == 1:
            size = int.from_bytes(data[at + 8:at + 16], "big")
            hdr = 16
        elif size == 0:
            size = end - at
        yield data[at + 4:at + 8], at, at + hdr, at + size
        at += size


def find_box(data: bytes, start: int, end: int, typ: bytes) -> tuple[int, int] | None:
    for t, _b, s, e in box_iter(data, start, end):
        if t == typ:
            return s, e
    return None


def rb(data: bytes, at: int, size: int) -> int:
    return int.from_bytes(data[at:at + size], "big") if size else 0


def parse_iloc(payload: bytes) -> dict:
    """item id -> [(offset, length)] extents, absolute file offsets."""
    version = payload[0]
    p = 4
    offset_size, length_size = payload[p] >> 4, payload[p] & 15
    base_size = payload[p + 1] >> 4
    index_size = payload[p + 1] & 15 if version in (1, 2) else 0
    p += 2
    count = rb(payload, p, 2 if version < 2 else 4)
    p += 2 if version < 2 else 4
    id_size = 2 if version < 1 else 4
    out = {}
    for _ in range(count):
        item_id = rb(payload, p, id_size)
        p += id_size + 2  # data_reference_index / construction_method
        extent_count = rb(payload, p, 2)
        p += 2
        base_offset = rb(payload, p, base_size)
        p += base_size
        extents = []
        for _ in range(extent_count):
            p += index_size
            off, ln = rb(payload, p, offset_size), rb(payload, p + offset_size, length_size)
            p += offset_size + length_size
            extents.append((base_offset + off, ln))
        out[item_id] = extents
    return out


def parse_ipma(payload: bytes) -> dict:
    """item id -> [(property index 1-based, essential)]"""
    version = payload[0]
    flags = int.from_bytes(payload[1:4], "big")
    p = 4
    count = rb(payload, p, 4)
    p += 4
    id_size = 2 if version < 1 else 4
    out = {}
    for _ in range(count):
        item_id = rb(payload, p, id_size)
        p += id_size
        assoc_count = payload[p]
        p += 1
        assocs = []
        for _ in range(assoc_count):
            if flags & 1:
                b16 = rb(payload, p, 2)
                assocs.append((b16 & 0x7FFF, bool(b16 >> 15)))
                p += 2
            else:
                assocs.append((payload[p] & 0x7F, bool(payload[p] >> 7)))
                p += 1
        out[item_id] = assocs
    return out


def parse_colr(prop: bytes) -> tuple[int, int, int, bool] | None:
    """nclx colr property -> (primaries, transfer, matrix, full range)"""
    if prop[4:8] != b"colr" or prop[8:12] != b"nclx":
        return None
    return (int.from_bytes(prop[12:14], "big"), int.from_bytes(prop[14:16], "big"),
            int.from_bytes(prop[16:18], "big"), bool(prop[18] & 0x80))


def avif_image(data: bytes) -> dict:
    """Extract the primary av01 item of an AVIF: bytes, properties, brands."""
    meta = find_box(data, 0, len(data), b"meta")
    if not meta:
        raise ValueError("not an AVIF: no meta box")
    ms, me = meta
    ms += 4  # meta is a full box

    pitm = find_box(data, ms, me, b"pitm")
    version = data[pitm[0]]
    primary = rb(data, pitm[0] + 4, 2 if version == 0 else 4)

    iloc = find_box(data, ms, me, b"iloc")
    extents = parse_iloc(data[iloc[0]:iloc[1]])
    iprp = find_box(data, ms, me, b"iprp")
    ipco = find_box(data, iprp[0], iprp[1], b"ipco")
    ipma = find_box(data, iprp[0], iprp[1], b"ipma")
    props = [(t, data[b:e]) for t, b, s, e in box_iter(data, ipco[0], ipco[1])]
    assocs = parse_ipma(data[ipma[0]:ipma[1]])
    if primary not in assocs or primary not in extents:
        raise ValueError(f"primary item {primary} missing from ipma/iloc")

    ftyp = find_box(data, 0, len(data), b"ftyp")
    brands = [data[i:i + 4] for i in range(ftyp[0] + 8, ftyp[1], 4)]

    item_props = [(props[i - 1][1], ess) for i, ess in assocs[primary]]
    payload = b"".join(data[o:o + ln] for o, ln in extents[primary])
    ispe = next((p for p, _ in item_props if p[4:8] == b"ispe"), None)
    if ispe is None or not any(p[4:8] == b"pixi" for p, _ in item_props):
        raise ValueError("primary item missing ispe/pixi")
    return {
        "data": payload,
        "props": item_props,
        "brands": brands,
        "colr": next((c for p, _ in item_props if (c := parse_colr(p)) is not None), None),
        "width": int.from_bytes(ispe[12:16], "big"),
        "height": int.from_bytes(ispe[16:20], "big"),
    }


def avif_tmap(data: bytes) -> dict:
    """Read back the tmap item + gain map structure (for verification)."""
    meta = find_box(data, 0, len(data), b"meta")
    ms, me = meta[0] + 4, meta[1]
    iinf = find_box(data, ms, me, b"iinf")
    items = {}
    for t, _b, s, e in box_iter(data, iinf[0] + 4 + 2, iinf[1]):
        if t != b"infe" or data[s] < 2:
            continue
        item_id = int.from_bytes(data[s + 4:s + 6], "big")
        items[item_id] = {
            "flags": int.from_bytes(data[s + 1:s + 4], "big"),
            "type": data[s + 8:s + 12],
        }
    iref = find_box(data, ms, me, b"iref")
    dimg = {}
    for t, _b, s, e in box_iter(data, iref[0] + 4, iref[1]):  # iref is a full box
        if t == b"dimg":
            frm = int.from_bytes(data[s:s + 2], "big")
            cnt = int.from_bytes(data[s + 2:s + 4], "big")
            dimg[frm] = [int.from_bytes(data[s + 4 + 2 * i:s + 6 + 2 * i], "big")
                         for i in range(cnt)]
    altr = []
    grpl = find_box(data, ms, me, b"grpl")
    if grpl:
        for t, _b, s, e in box_iter(data, grpl[0], grpl[1]):
            if t == b"altr":
                cnt = int.from_bytes(data[s + 8:s + 12], "big")
                altr = [int.from_bytes(data[s + 12 + 4 * i:s + 16 + 4 * i], "big")
                        for i in range(cnt)]
    iloc = find_box(data, ms, me, b"iloc")
    extents = parse_iloc(data[iloc[0]:iloc[1]])
    tmap_id = next(i for i, it in items.items() if it["type"] == b"tmap")
    payload = b"".join(data[o:o + ln] for o, ln in extents[tmap_id])
    return {"items": items, "dimg": dimg, "altr": altr,
            "tmap_id": tmap_id, "meta": parse_tmap_payload(payload)}


# ── gain map avif writer ─────────────────────────────────────────────────────
#
# same container libavif >= 1.3 writes (per its goldens):
#   items  1 av01 color, 2 tmap (ToneMapImage payload), 3 av01 gain map hidden
#   iref   dimg 2 -> [1, 3]
#   grpl   altr [2, 1]
#   ipma   color -> base props, tmap -> base ispe/pixi + alt colr (PQ),
#          gain map -> gain props

COLOR_ID, TMAP_ID, GAIN_ID = 1, 2, 3
PQ_TRANSFER = 16


def triple(v, default: float) -> list[float]:
    if v is None:
        return [default] * 3
    if isinstance(v, (int, float)):
        return [float(v)] * 3
    vals = [float(x) for x in v]
    return vals if len(vals) == 3 else vals * 3


def tmap_payload(meta: dict) -> bytes:
    """hdrgm XMP metadata -> ISO 21496-1 GainMapMetadata (ToneMapImage v0).

    mapping mirrors libavif apps/shared/avifjpeg.c: CapacityMin/Max become the
    base/alternate headrooms, OffsetSDR/HDR the base/alternate offsets, and
    the gain map is interpreted in the base color space.
    """
    gmin = triple(meta.get("gainMapMin"), 0.0)
    gmax = triple(meta.get("gainMapMax"), 1.0)
    gamma = triple(meta.get("gamma"), 1.0)
    off_s = triple(meta.get("offsetSDR"), 0.0)
    off_h = triple(meta.get("offsetHDR"), 0.0)
    cap_min = triple(meta.get("hdrCapacityMin"), 0.0)
    cap_max = triple(meta.get("hdrCapacityMax"), 1.0)
    if any(a >= b for a, b in zip(cap_min, cap_max)):
        raise ValueError("HDRCapacityMax must be > HDRCapacityMin")
    if any(g <= 0 for g in gamma):
        raise ValueError("gamma must be > 0")

    channels = 1
    for row in (gmin, gmax, gamma, off_s, off_h):
        if len(set(row)) > 1:
            channels = 3
    b = bytearray()
    b += bytes([0])  # ToneMapImage version
    b += struct.pack(">HH", 0, 0)  # minimum_version, writer_version
    b += bytes([(0x80 if channels == 3 else 0) | 0x40])  # multichannel, use_base_colour_space
    b += struct.pack(">II", *frac(cap_min[0], 0xFFFFFFFF))
    b += struct.pack(">II", *frac(cap_max[0], 0xFFFFFFFF))
    for c in range(channels):
        b += struct.pack(">iI", *sfrac(gmin[c]))
        b += struct.pack(">iI", *sfrac(gmax[c]))
        b += struct.pack(">II", *frac(gamma[c], 0xFFFFFFFF))
        b += struct.pack(">iI", *sfrac(off_s[c]))
        b += struct.pack(">iI", *sfrac(off_h[c]))
    return bytes(b)


def parse_tmap_payload(payload: bytes) -> dict:
    """inverse of tmap_payload, for round trip checks."""
    if payload[0] != 0:
        raise ValueError("unsupported ToneMapImage version")
    minimum, writer = struct.unpack_from(">HH", payload, 1)
    flags = payload[5]
    channels = 3 if flags & 0x80 else 1
    base_n, base_d, alt_n, alt_d = struct.unpack_from(">IIII", payload, 6)
    ch = []
    p = 22
    for _ in range(channels):
        mn, md, mx, xd, gn, gd, bn, bd, an, ad = struct.unpack_from(">iIiIiIiIiI", payload, p)
        ch.append((mn / md, mx / xd, gn / gd, bn / bd, an / ad))
        p += 40
    return {
        "minimum_version": minimum,
        "writer_version": writer,
        "use_base_colour_space": bool(flags & 0x40),
        "hdrCapacityMin": base_n / base_d,
        "hdrCapacityMax": alt_n / alt_d,
        "channels": ch,
    }


def colr_nclx(cp: int, tc: int, mc: int, full: bool) -> bytes:
    return box(b"colr", b"nclx" + struct.pack(">HHH", cp, tc, mc)
               + bytes([0x80 if full else 0]))


def infe(item_id: int, item_type: bytes, name: str, hidden: bool) -> bytes:
    return fullbox(b"infe", 2, 1 if hidden else 0,
                   struct.pack(">HH", item_id, 0) + item_type + name.encode() + b"\x00")


def ipma_entry(item_id: int, assocs: list[tuple[int, bool]]) -> bytes:
    out = struct.pack(">HB", item_id, len(assocs))
    for idx, essential in assocs:
        out += bytes([(0x80 if essential else 0) | idx])
    return out


def prop_index(props: list, typ: bytes) -> int:
    return 1 + next(i for i, (p, _e) in enumerate(props) if p[4:8] == typ)


def write_gainmap_avif(base: dict, gain: dict, meta: dict) -> bytes:
    """base + gain map AV1 images (as encoded by avifenc) -> gain map AVIF."""
    payload = tmap_payload(meta)

    cp, mc, full = 1, 6, True
    if base["colr"]:
        cp, _tc, mc, full = base["colr"]
    alt_colr = colr_nclx(cp, PQ_TRANSFER, mc, full)

    props = [p for p, _ in base["props"]] + [p for p, _ in gain["props"]] + [alt_colr]
    nb = len(base["props"])
    color_assocs = [(i + 1, e) for i, (_p, e) in enumerate(base["props"])]
    gain_assocs = [(nb + i + 1, e) for i, (_p, e) in enumerate(gain["props"])]
    tmap_assocs = [(prop_index(base["props"], b"ispe"), False),
                  (prop_index(base["props"], b"pixi"), False),
                  (len(props), False)]

    ipco = b"".join(props)
    ipma = fullbox(b"ipma", 0, 0, struct.pack(">I", 3)
                   + ipma_entry(COLOR_ID, color_assocs)
                   + ipma_entry(TMAP_ID, tmap_assocs)
                   + ipma_entry(GAIN_ID, gain_assocs))
    iprp = box(b"iprp", box(b"ipco", ipco) + ipma)

    iinf = fullbox(b"iinf", 0, 0, struct.pack(">H", 3)
                   + infe(COLOR_ID, b"av01", "Color", False)
                   + infe(TMAP_ID, b"tmap", "GMap", False)
                   + infe(GAIN_ID, b"av01", "GMap", True))
    # the inner SingleItemTypeReferenceBox is a plain box (no version/flags)
    iref = fullbox(b"iref", 0, 0, box(b"dimg", struct.pack(">HHHH",
               TMAP_ID, 2, COLOR_ID, GAIN_ID)))
    altr = box(b"grpl", fullbox(b"altr", 0, 0, struct.pack(">IIII",
               4, 2, TMAP_ID, COLOR_ID)))
    hdlr = fullbox(b"hdlr", 0, 0, struct.pack(">I", 0) + b"pict"
                    + struct.pack(">III", 0, 0, 0) + b"\x00")

    brands = list(dict.fromkeys(base["brands"] + [b"tmap"]))
    ftyp = box(b"ftyp", b"avif" + struct.pack(">I", 0) + b"".join(brands))

    # iloc offsets are file-absolute: build meta once to learn its size, then
    # rebuild with the real offsets (entries keep the same byte count).
    chunks = ((COLOR_ID, base["data"]), (TMAP_ID, payload), (GAIN_ID, gain["data"]))

    def iloc_with(offsets):
        entries = [struct.pack(">HHHII", item_id, 0, 1, off, len(chunk))
                   for (item_id, chunk), off in zip(chunks, offsets)]
        return fullbox(b"iloc", 0, 0, bytes([0x44, 0x00]) + struct.pack(">H", 3)
                       + b"".join(entries))

    def meta_with(offsets):
        return fullbox(b"meta", 0, 0, hdlr
                       + fullbox(b"pitm", 0, 0, struct.pack(">H", COLOR_ID))
                       + iloc_with(offsets) + iinf + iref + iprp + altr)

    header_len = len(ftyp) + len(meta_with([0, 0, 0])) + 8
    at = header_len
    offsets = []
    for _id, chunk in chunks:
        offsets.append(at)
        at += len(chunk)
    meta = meta_with(offsets)
    assert len(ftyp) + len(meta) + 8 == header_len
    mdat = box(b"mdat", base["data"] + payload + gain["data"])
    return ftyp + meta + mdat


# ── conversion flow ──────────────────────────────────────────────────────────


def run(cmd: list[str]) -> int:
    print("$ " + " ".join(cmd))
    cp = subprocess.run(cmd, capture_output=True, text=True)
    if cp.stdout:
        sys.stdout.write(cp.stdout)
    if cp.stderr:
        sys.stderr.write(cp.stderr)
    return cp.returncode


def fallback(pieces: dict, dst: str, args) -> int:
    """avifenc both renditions + repack into a gain map AVIF, no libxml2."""
    if not shutil.which(args.avifenc_bin or ""):
        print("fallback needs avifenc: install libavif or pass --avifenc-bin PATH",
              file=sys.stderr)
        return 2
    meta = normalize_meta(pieces["meta"])
    with tempfile.TemporaryDirectory(prefix="avifgain") as td:
        paths = {}
        for name, blob in (("base", pieces["base"]), ("gain", pieces["gainmap"])):
            paths[name + ".jpg"] = os.path.join(td, name + ".jpg")
            paths[name + ".avif"] = os.path.join(td, name + ".avif")
            with open(paths[name + ".jpg"], "wb") as f:
                f.write(blob)
        for name, q in (("base", args.quality), ("gain", args.qgain_map)):
            rc = run([args.avifenc_bin, "-q", str(q),
                      paths[name + ".jpg"], paths[name + ".avif"]])
            if rc != 0:
                print(f"avifenc failed on the {name} image (exit {rc})", file=sys.stderr)
                return rc
        with open(paths["base.avif"], "rb") as f:
            base = avif_image(f.read())
        with open(paths["gain.avif"], "rb") as f:
            gain = avif_image(f.read())
        out = write_gainmap_avif(base, gain, meta)
        with open(dst, "wb") as f:
            f.write(out)

    check = avif_tmap(out)
    ch = check["meta"]["channels"][0]
    print(f"wrote {dst}  {len(out)} bytes — base {base['width']}x{base['height']}, "
          f"gain map {gain['width']}x{gain['height']}, "
          f"range {ch[0]:.3f}..{ch[1]:.3f} stops, "
          f"capacity {check['meta']['hdrCapacityMin']:.3f}.."
          f"{check['meta']['hdrCapacityMax']:.3f} stops")
    return 0


def gather(args) -> tuple[dict, str]:
    """-> ({base, gainmap, meta}, ultra hdr jpeg path used by external tools)."""
    if len(args.inputs) == 1:
        src = args.inputs[0]
        with open(src, "rb") as f:
            pieces = parse_ultrahdr(f.read())
        return pieces, src
    if len(args.inputs) == 3:
        base_path, gain_path, meta_path = args.inputs
        with open(base_path, "rb") as f:
            base = f.read()
        with open(gain_path, "rb") as f:
            gain = f.read()
        meta = normalize_meta(json.load(open(meta_path)))
        ultra = build_ultrahdr(base, gain, meta)
        src = args.out.replace(".avif", "_ultrahdr.jpg") if args.out else \
            re.sub(r"\.(jpe?g)$", r"_ultrahdr.\1", base_path)
        with open(src, "wb") as f:
            f.write(ultra)
        print(f"assembled {src}  {len(ultra)} bytes")
        return {"base": base, "gainmap": gain, "meta": meta}, src
    raise ValueError("give one ultra hdr jpeg, or base.jpg + gainmap.jpg + meta.json")


def main() -> int:
    ap = argparse.ArgumentParser(description="Ultra HDR JPEG -> gain map AVIF")
    ap.add_argument("inputs", nargs="+",
                    help="photo_ultrahdr.jpg | base.jpg gainmap.jpg meta.json")
    ap.add_argument("-o", "--out", type=str, default=None)
    ap.add_argument("-q", "--quality", type=int, default=90)
    ap.add_argument("--qgain-map", type=int, default=80)
    ap.add_argument("--avifenc", action="store_true",
                    help="use avifenc instead of avifgainmaputil for the external path")
    ap.add_argument("--avifenc-bin", type=str, default=shutil.which("avifenc") or "")
    ap.add_argument("--gainmaputil", type=str,
                    default=shutil.which("avifgainmaputil") or "")
    ap.add_argument("--dry-run", action="store_true", help="print the command and stop")
    args = ap.parse_args()

    try:
        pieces, src = gather(args)
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    dst = args.out or os.path.splitext(src)[0] + ".avif"

    if args.avifenc:
        name = args.avifenc_bin or "avifenc"
        cmd = [name, "--qgain-map", str(args.qgain_map), "-q", str(args.quality), src, dst]
    else:
        name = args.gainmaputil or "avifgainmaputil"
        cmd = [name, "convert", src, dst]
    have = bool(shutil.which(name))

    if args.dry_run:
        print(" ".join(cmd) + ("   (not found — would use built-in fallback)" if not have else ""))
        return 0
    if have:
        rc = run(cmd)
        if rc == 0:
            return 0
        print(f"{os.path.basename(name)} failed (exit {rc}); "
              f"trying the built-in fallback", file=sys.stderr)
    else:
        print(f"{name} not found; using the built-in fallback", file=sys.stderr)
    return fallback(pieces, dst, args)


if __name__ == "__main__":
    raise SystemExit(main())
