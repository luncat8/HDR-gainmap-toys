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


## files

findings-pitfalls-skills.md - notes and pitfalls for LLM agents. write here if found good way to do something.

archive/ - for implemented plans
