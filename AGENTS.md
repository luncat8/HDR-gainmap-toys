# AGENTS.md


## style

	use a single tab indentation. LF end

	avoid deep nesting of braces { } and long if-else.
	flatten with early returns, helper functions, or flat data tables.

	avoid duplication of code.

	avoid allocations in the hot path (per-frame loop, sim, render).
		no new {}, [], object literals, closures, or string concat
		inside the frame loop.
		reuse preallocated buffers / typed arrays / scratch objects.
		allocate once at setup, mutate in place per frame.
		these are not strict rules, use best.

	plan*.md is NOT the implementation log. if need - update/improve plan, but keep final plan as artifact for possible fork or reimplementation without referring of what was and what done, without referring chat, etc.

	only essential concise comments in code that really helpful i.e. explain why and decision. prefer descriptive naming.

	no legacy support, no old versions, no outdated browsers, no leftovers and no over protecting from unreal edge cases. we need clean architecture.
	end-users have chrome >151 and RTX3060 or better GPU.

## runtime

	file:// friendly, classic <script> tags, no modules, no build.
	guard module.exports so files also run under node.
	no internet links: vendor any lib as a local js file.
	WebGPU

## concepts

	hdr image = linear light, sRGB primaries, 1.0 = SDR white (203 nits by default).
	everything above 1.0 is headroom the display may or may not have.

	gain map = per pixel log2 boost, stored as 8 bit "recovery" in [0,1] at a
	fraction of the image resolution. the file keeps the SDR rendition plus the
	map; a decoder combines them and adapts the boost to the display headroom.

	authoring here does not divide hdr by sdr: the curve *is* the gain, so there
	is no log(0) case and no offsets to tune. recovery = curve(Ysdr), and the
	preview applies the same weight a decoder would, so canvas == saved file.

	ultra hdr jpeg = SDR jpeg + gain map jpeg + XMP (hdrgm, GContainer) + MPF
	(APP2). see findings-pitfalls-skills.md for the byte level details.

## files

findings-pitfalls-skills.md - notes and pitfalls for LLM agents. write here if found good way to do something.

archive/ - for implemented plans
