// WGSL for the gain map toy.
//
// Colour: sRGB primaries, linear light, 1.0 = SDR white.
//   gain pass   : Y_sdr -> curve -> recovery (8 bit, at gain map resolution)
//   apply pass  : sdr + recovery -> linear HDR, weighted by display headroom
//                 exactly as a decoder does (Ultra HDR v1.0 "Display")
//   present pass: linear HDR -> extended sRGB (values > 1.0 are HDR)
(function (root) {
	'use strict';

	var LUT_SAMPLES = 64;

	var code = `
struct Params {
  a : vec4f,             // minStops, maxStops, capacityMin, capacityMax
  b : vec4f,             // exposure, headroomLog2, mode, gainScale
  c : vec4f,             // srcW, srcH, gainW, gainH
  lut : array<vec4f, 16>,
};

@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var tex0 : texture_2d<f32>;
@group(0) @binding(3) var tex1 : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out : VSOut;
  out.pos = vec4f(corners[i], 0.0, 1.0);
  out.uv = vec2f(corners[i].x * 0.5 + 0.5, 0.5 - corners[i].y * 0.5);
  return out;
}

fn srgbToLinear(c : vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

fn linearToSrgb(c : vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  let lo = x * 12.92;
  let hi = 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}

fn luma(c : vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn curve(y : f32) -> f32 {
  let t = clamp(y, 0.0, 1.0) * ${(LUT_SAMPLES - 1).toFixed(1)};
  let i = i32(floor(t));
  let i0 = clamp(i, 0, ${LUT_SAMPLES - 1});
  let i1 = clamp(i + 1, 0, ${LUT_SAMPLES - 1});
  let v0 = P.lut[i0 / 4][i0 % 4];
  let v1 = P.lut[i1 / 4][i1 % 4];
  return mix(v0, v1, t - floor(t));
}

// Ultra HDR decode weight: how much of the authored boost the display can show.
fn weight() -> f32 {
  let span = P.a.w - P.a.z;
  if (span <= 0.0) { return select(0.0, 1.0, P.b.y >= P.a.w); }
  return clamp((P.b.y - P.a.z) / span, 0.0, 1.0);
}

// gain pass: average Y_sdr over the gain map footprint, then apply the curve.
@fragment
fn fs_gain(in : VSOut) -> @location(0) vec4f {
  let scale = P.b.w;
  let taps = i32(min(scale, 4.0));
  let foot = vec2f(scale / P.c.x, scale / P.c.y);
  var sum = 0.0;
  for (var j = 0; j < taps; j = j + 1) {
    for (var i = 0; i < taps; i = i + 1) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / f32(taps) - vec2f(0.5);
      let c = textureSampleLevel(tex0, samp, in.uv + o * foot, 0.0);
      sum = sum + luma(srgbToLinear(c.rgb));
    }
  }
  let r = curve(sum / f32(taps * taps));
  return vec4f(r, r, r, 1.0);
}

// apply pass: sdr * exp2(logBoost * weight) - the decoder formula.
@fragment
fn fs_apply(in : VSOut) -> @location(0) vec4f {
  let sdr = srgbToLinear(textureSampleLevel(tex0, samp, in.uv, 0.0).rgb);
  let rec = textureSampleLevel(tex1, samp, in.uv, 0.0).r;
  let logBoost = mix(P.a.x, P.a.y, rec);
  let g = exp2(logBoost * weight());
  return vec4f(max(sdr * g, vec3f(0.0)), 1.0);
}

// present pass: linear HDR -> extended sRGB canvas.
// mode: 0 = HDR, 2 = gain map (gray), 3 = SDR base (sRGB bytes passthrough).
@fragment
fn fs_present(in : VSOut) -> @location(0) vec4f {
  let c = textureSampleLevel(tex0, samp, in.uv, 0.0);
  if (P.b.z > 2.5) { return vec4f(c.rgb, 1.0); }
  let scale = exp2(P.b.x);
  let rgb = select(c.rgb, vec3f(c.r), P.b.z > 1.5);
  return vec4f(linearToSrgb(rgb * scale), 1.0);
}

// histogram pass: log2 luma of two textures at low resolution, read back on
// the CPU and binned. tex0 is sRGB encoded (decoded here), tex1 is linear.
@fragment
fn fs_hist(in : VSOut) -> @location(0) vec4f {
  let a = srgbToLinear(textureSampleLevel(tex0, samp, in.uv, 0.0).rgb);
  let b = textureSampleLevel(tex1, samp, in.uv, 0.0).rgb;
  return vec4f(log2(max(luma(a), 1e-6)), log2(max(luma(b), 1e-6)), 0.0, 1.0);
}
`;

	var api = { code: code, LUT_SAMPLES: LUT_SAMPLES };
	root.SHADERS = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
