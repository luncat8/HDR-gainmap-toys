// Small DOM builders: flat tables in, wired controls out.
(function (root) {
	'use strict';

	function el(tag, attrs, kids) {
		var node = document.createElement(tag);
		if (attrs) {
			Object.keys(attrs).forEach(function (k) {
				if (k === 'class') node.className = attrs[k];
				else if (k === 'text') node.textContent = attrs[k];
				else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
				else node.setAttribute(k, attrs[k]);
			});
		}
		(kids || []).forEach(function (kid) {
			node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
		});
		return node;
	}

	// def: {label, min, max, step, value, format, onInput}
	function slider(def) {
		var out = el('span', { class: 'value' });
		var input = el('input', {
			type: 'range',
			min: def.min,
			max: def.max,
			step: def.step,
			value: def.value
		});
		function show() {
			out.textContent = def.format ? def.format(parseFloat(input.value)) : input.value;
		}
		input.addEventListener('input', function () {
			show();
			def.onInput(parseFloat(input.value));
		});
		show();
		return {
			row: el('label', { class: 'row' }, [
				el('span', { class: 'label', text: def.label }),
				input,
				out
			]),
			input: input,
			set: function (v) {
				input.value = v;
				show();
			}
		};
	}

	function select(def) {
		var node = el('select', {}, def.options.map(function (o) {
			return el('option', { value: o.value, text: o.label });
		}));
		node.value = def.value;
		node.addEventListener('change', function () { def.onChange(node.value); });
		return {
			row: el('label', { class: 'row' }, [
				el('span', { class: 'label', text: def.label }),
				node
			]),
			node: node,
			set: function (v) { node.value = v; }
		};
	}

	function buttons(defs) {
		return el('div', { class: 'buttons' }, defs.map(function (d) {
			return el('button', { type: 'button', text: d.label, onclick: d.onClick, title: d.title });
		}));
	}

	function radio(name, options, value, onChange) {
		var inputs = options.map(function (o) {
			var input = el('input', { type: 'radio', name: name, value: o.value });
			input.checked = o.value === value;
			input.addEventListener('change', function () {
				if (input.checked) onChange(o.value);
			});
			return el('label', { class: 'chip' }, [input, el('span', { text: o.label })]);
		});
		return {
			row: el('div', { class: 'chips' }, inputs),
			set: function (v) {
				inputs.forEach(function (wrap) {
					wrap.firstChild.checked = wrap.firstChild.value === v;
				});
			}
		};
	}

	var api = { el: el, slider: slider, select: select, buttons: buttons, radio: radio };
	root.UI = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
