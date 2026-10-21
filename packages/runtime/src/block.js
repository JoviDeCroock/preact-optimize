import { options } from 'preact';
import { jsx } from 'preact/jsx-runtime';
import { Signal, effect, signal, untracked } from '@preact/signals';
import { $hole, $text } from './signals.js';

/**
 * Blocks: host-only JSX compiled to a DOM template.
 *
 * `$block([tpl, ...slots], key)` renders one host vnode with no children and
 * a single `__pob` prop. Preact creates the root element and, because
 * `Element.prototype` has a `__pob` accessor, hands the prop to it through
 * its usual `dom[name] = value` path. The accessor clones the template's
 * content into the element on mount and patches the slots that changed on
 * every later render, so Preact never sees (or diffs) the inside of a block.
 *
 * Slots compiled as reactive are functions: one effect per block calls them,
 * so the signals they read update the DOM without a render. Text slots that
 * turn out to hold vnodes fall back to the original JSX for that render.
 *
 * Lists: `$list(<ul />, items, row, tpl, pure)` is `<ul>{items.map(row)}</ul>`
 * where `row` returns a keyed block. The `__pol` accessor owns the element's
 * children: it matches rows by key, patches them like blocks and moves only
 * the rows outside the longest run already in order. A `pure` row renders
 * from its item alone, so a row whose item is the same value as last time
 * isn't rendered again.
 */

/**
 * @typedef {object} Template
 * @property {(s: any[]) => any} fn The original JSX with `s[i]` for slot i.
 * @property {boolean[]} reactive Per slot, whether it is a function to track.
 * @property {string} [type] The root tag, once `fn` has run.
 * @property {number[]} [text] Indices of text slots.
 * @property {import('@preact/signals').Signal<number>} epoch Read by every
 * render with a reactive (or signal) text slot, and by every list of this
 * row, and bumped when an effect finds a vnode in one, so whatever rendered
 * it (a component, or a hole's computed) runs again and falls back.
 * @property {boolean} [vnodes] A text slot held a vnode once: lists of this
 * row render their children through Preact from then on.
 * @property {Map<string, Built>} [built] DOM per namespace.
 */

/**
 * @typedef {object} Built
 * @property {DocumentFragment} content The root's children.
 * @property {[string, string][]} attrs The root's static attributes.
 * @property {[string, any][]} props The root's static props, to remove the
 * way Preact would.
 * @property {{ path: number[], name: string | null, value?: any }[]} slots
 * `name` is the prop a slot sets, `null` for text. Slots past the template's
 * markers have a fixed `value`.
 * @property {number[]} order Slot indices in write order: source order, with
 * `value` and `checked` last, once the options they select exist.
 */

/**
 * @param {(s: any[]) => any} fn
 * @param {number[]} reactive Indices of reactive slots.
 * @returns {Template}
 */
export function $template(fn, reactive) {
	const flags = [];
	for (const i of reactive) flags[i] = true;
	return { fn, reactive: flags, epoch: signal(0) };
}

/**
 * Whether a clone of `el` carries static prop `name` as Preact set it: false
 * for listeners (Preact attaches even a string), for `value` and `checked`
 * (Preact writes them back over user input on every render) and for
 * properties that don't reflect to an attribute (`volume`, ...). Those
 * become slots with a fixed value, written to every instance.
 * @param {Element} el @param {string} name
 */
function carried(el, name) {
	if ((name[0] == 'o' && name[1] == 'n') || name == 'value' || name == 'checked') return false;
	if (!(name in el)) return true;
	const a = /** @type {any} */ (el)[name];
	const b = /** @type {any} */ (el.cloneNode(false))[name];
	return a === b || (a !== a && b !== b);
}

/** Slot markers, created once and reused by every template. */
const markers = [];
const marker = (/** @type {number} */ i) => markers[i] || (markers[i] = { $slot: i });
const slotOf = (/** @type {any} */ value) =>
	value != null && typeof value == 'object' && '$slot' in value ? value.$slot : -1;

/** Run the template once with markers to learn its root and text slots. */
function init(/** @type {Template} */ t) {
	const vnode = t.fn(markers);
	t.type = vnode.type;
	t.text = [];
	const walk = (/** @type {any} */ children) => {
		if (Array.isArray(children)) return children.forEach(walk);
		const slot = slotOf(children);
		if (slot >= 0) t.text.push(slot);
		else if (children != null && typeof children == 'object') walk(children.props.children);
	};
	walk(vnode.props.children);
}

/**
 * @param {any[]} values `[template, ...slots]`
 * @param {any} [key]
 */
export function $block(values, key) {
	const t = /** @type {Template} */ (values[0]);
	if (!t.type) {
		// Enough markers for every slot, then learn the shape.
		for (let i = markers.length; i < values.length; i++) marker(i);
		init(t);
	}
	// The server (and render-to-string, which sets `options._skipEffects`,
	// mangled `__s`) renders the original JSX.
	if (!HAS_DOM || options.__s) return fallback(t, values, key);
	let live = false;
	const text = /** @type {number[]} */ (t.text);
	for (let j = 0; j < text.length; j++) {
		const i = text[j];
		let v = values[i + 1];
		if (t.reactive[i]) {
			live = true;
			v = untracked(v);
		} else if (v instanceof Signal) {
			live = true;
			v = v.peek();
		}
		if (v != null && typeof v == 'object') return fallback(t, values, key);
	}
	// Subscribe to the epoch only where an effect may find a vnode later.
	if (live) t.epoch.value;
	return jsx(/** @type {string} */ (t.type), { __pob: () => values }, key);
}

/** Re-render whatever rendered blocks of `t`, which then fall back. */
function fallBack(/** @type {Template} */ t) {
	t.vnodes = true;
	t.epoch.value = t.epoch.peek() + 1;
}

/**
 * `<el>{items.map(row)}</el>`, with `row` returning `$block(..., key)`.
 * @param {any} vnode The element, without children.
 * @param {any} items
 * @param {(item: any) => any} row
 * @param {Template} t The row's template.
 * @param {number} pure Whether `row` reads nothing but its item and values
 * that never change, so it can be skipped for an item it rendered before.
 */
export function $list(vnode, items, row, t, pure) {
	if (HAS_DOM && !options.__s && !t.vnodes) {
		t.epoch.value;
		if (pure && Array.isArray(items)) {
			vnode.props.__pol = () => [items, row, t];
			return vnode;
		}
		const rows = items.map(row);
		// A row that fell back can't live in the list.
		if (rows.every((/** @type {any} */ r) => r.props.__pob)) {
			vnode.props.__pol = () => [rows];
			return vnode;
		}
	}
	vnode.props.children = items.map(row);
	return vnode;
}

/** The original JSX for values a template can't hold. */
function fallback(/** @type {Template} */ t, /** @type {any[]} */ values, /** @type {any} */ key) {
	const s = [];
	for (let i = 1; i < values.length; i++) {
		s.push(t.reactive[i - 1] ? (t.text.includes(i - 1) ? $text : $hole)(values[i]) : values[i]);
	}
	const vnode = t.fn(s);
	vnode.key = key;
	return vnode;
}

/**
 * Build the template's DOM for one namespace.
 * @param {Template} t
 * @param {Document} doc
 * @param {string} namespace
 * @returns {Built}
 */
function build(t, doc, namespace) {
	const root = t.fn(markers);
	/** @type {Built['slots']} */
	const slots = [];
	/** @type {Built['slots']} */
	const fixed = [];
	const content = doc.createDocumentFragment();
	/** @type {[string, string][]} */
	const attrs = [];
	/** @type {[string, any][]} */
	const props = [];

	/**
	 * @param {any} given
	 * @param {Element} el
	 * @param {number[]} path
	 */
	const applyProps = (given, el, path) => {
		for (const name in given) {
			if (name === 'children') continue;
			const value = given[name];
			const slot = slotOf(value);
			if (slot >= 0) {
				slots[slot] = { path, name };
				continue;
			}
			if (name[0] != 'o' || name[1] != 'n') setProp(el, name, value);
			if (!carried(el, name)) fixed.push({ path, name, value });
			else if (!path.length) props.push([name, value]);
		}
	};

	/**
	 * Blocks hold no `svg`, `math` or `foreignObject`, so every element
	 * shares the root's namespace.
	 * @param {any} children
	 * @param {Node} parent
	 * @param {number[]} path
	 */
	const append = (children, parent, path) => {
		if (Array.isArray(children)) {
			for (const child of children) append(child, parent, path);
			return;
		}
		if (children == null || typeof children == 'boolean') return;
		const at = [...path, parent.childNodes.length];
		const slot = slotOf(children);
		if (slot >= 0) {
			slots[slot] = { path: at, name: null };
			parent.appendChild(doc.createTextNode(''));
		} else if (typeof children == 'object') {
			const el = doc.createElementNS(namespace, children.type);
			applyProps(children.props, el, at);
			append(children.props.children, el, at);
			parent.appendChild(el);
		} else {
			parent.appendChild(doc.createTextNode(String(children)));
		}
	};

	const scratch = doc.createElementNS(namespace, root.type);
	applyProps(root.props, scratch, []);
	for (const attr of Array.from(scratch.attributes)) attrs.push([attr.name, attr.value]);
	append(root.props.children, content, []);
	slots.push(...fixed);
	const order = slots.map((_, i) => i);
	const last = (/** @type {number} */ i) => +(slots[i].name == 'value' || slots[i].name == 'checked');
	order.sort((a, b) => last(a) - last(b) || a - b);
	return { content, attrs, props, slots, order };
}

/**
 * @typedef {object} Instance
 * @property {Template} t
 * @property {Built} b
 * @property {Node[]} nodes Per slot, the node it writes to.
 * @property {any[]} old Per slot, the value last written.
 * @property {import('@preact/signals').Signal<any[]> | null} input Latest
 * values, for the effect.
 * @property {(() => void) | null} dispose
 */

/**
 * @param {Element & { __pb?: Instance }} dom
 * @param {Template} t
 * @returns {Instance}
 */
function mount(dom, t) {
	const namespace = /** @type {string} */ (dom.namespaceURI);
	const built = t.built || (t.built = new Map());
	let b = built.get(namespace);
	if (!b) built.set(namespace, (b = build(t, dom.ownerDocument, namespace)));
	for (const [name, value] of b.attrs) dom.setAttribute(name, value);
	// Children Preact rendered here before (a fallback render) are still
	// attached until it unmounts them, so resolve paths from our first node.
	const first = dom.childNodes.length;
	dom.appendChild(b.content.cloneNode(true));
	const nodes = b.slots.map(({ path }) => {
		if (!path.length) return dom;
		/** @type {Node} */
		let node = dom.childNodes[first + path[0]];
		for (let d = 1; d < path.length; d++) {
			node = /** @type {Node} */ (node.firstChild);
			for (let k = path[d]; k--;) node = /** @type {Node} */ (node.nextSibling);
		}
		return node;
	});
	return (dom.__pb = { t, b, nodes, old: [], input: null, dispose: null });
}

/**
 * Stop a block's effect and its listeners, as Preact's unmount drops an
 * element's listeners. Enough on unmount: its DOM is going away.
 */
function dispose(/** @type {Element & { __pb?: Instance }} */ dom) {
	const inst = /** @type {Instance} */ (dom.__pb);
	dom.__pb = undefined;
	if (inst.dispose) inst.dispose();
	inst.b.slots.forEach(({ name }, i) => {
		if (name && name[0] == 'o' && name[1] == 'n') /** @type {any} */ (inst.nodes[i]).__pl = undefined;
	});
	return inst;
}

/**
 * Tear down a block on an element Preact keeps: remove the root props it
 * set, as Preact removes props, and its children.
 */
function reset(/** @type {Element & { __pb?: Instance }} */ dom) {
	const inst = dispose(dom);
	inst.b.slots.forEach(({ path, name }, i) => {
		// Only attribute slots sit on the root.
		if (!path.length) setProp(dom, /** @type {string} */ (name), null, inst.old[i]);
	});
	for (const [name, value] of inst.b.props) setProp(dom, name, null, value);
	dom.textContent = '';
}

/**
 * Write slot `i` if it changed.
 * @param {Instance} inst
 * @param {number} i
 * @param {any} value
 */
function write(inst, i, value) {
	const old = inst.old[i];
	const { name } = inst.b.slots[i];
	const node = /** @type {any} */ (inst.nodes[i]);
	if (name == 'value' && node.localName == 'progress' && value == null) {
		node.removeAttribute(name);
	} else if (name == 'value') {
		// Like Preact, compare against the live DOM state, skip null and
		// undefined, and always write a progress bar's 0 (indeterminate
		// otherwise).
		if (value != undefined && (value !== node.value || (node.localName == 'progress' && !value))) {
			setProp(node, name, value, old);
		}
	} else if (name == 'checked') {
		if (value != undefined && value != node.checked) setProp(node, name, value, old);
	} else if (value === old) {
		return;
	} else if (name) {
		setProp(node, name, value, old);
	} else {
		// Preact renders nothing for these, functions included.
		node.data = value == null || typeof value == 'boolean' || typeof value == 'function' ? '' : value;
	}
	inst.old[i] = value;
}

/**
 * Write every slot, in the order Preact would set them.
 * @param {Instance} inst
 * @param {any[]} values
 */
function apply(inst, values) {
	const t = inst.t;
	const order = inst.b.order;
	for (let j = 0; j < order.length; j++) {
		const i = order[j];
		let v = i + 1 < values.length ? values[i + 1] : inst.b.slots[i].value;
		if (t.reactive[i]) v = v();
		else if (v instanceof Signal) v = v.value;
		if (inst.b.slots[i].name == null && v != null && typeof v == 'object') {
			// A vnode now: re-render whatever rendered this, which falls back.
			fallBack(t);
		} else {
			write(inst, i, v);
		}
	}
}

/**
 * Apply one render's values. A block with reactive slots or signals writes
 * through one effect, which also follows the signals they read.
 * @param {Element & { __pb?: Instance }} dom
 * @param {any[]} values
 */
function patch(dom, values) {
	const t = /** @type {Template} */ (values[0]);
	let inst = dom.__pb;
	if (!inst || inst.t !== t) {
		if (inst) reset(dom);
		inst = mount(dom, t);
	}
	if (inst.input) {
		inst.input.value = values;
		return;
	}
	for (let i = 0; i < inst.nodes.length; i++) {
		if (t.reactive[i] || values[i + 1] instanceof Signal) {
			const self = inst;
			const input = (inst.input = signal(values));
			try {
				inst.dispose = effect(() => apply(self, input.value));
			} catch (e) {
				// The effect is gone; let the next render start a new one.
				inst.input = null;
				throw e;
			}
			return;
		}
	}
	apply(inst, values);
}

/**
 * @typedef {object} Row
 * @property {Element & { __pb?: Instance }} el
 * @property {any} key
 * @property {any} item
 * @property {number} gen The last reconcile that used it.
 * @property {number} at Its index after the last reconcile, -1 when new.
 */

/**
 * @typedef {object} List
 * @property {Row[]} rows In order.
 * @property {Map<any, Row>} keys
 * @property {Map<any, Row>} items Rows by the item they last rendered, for
 * pure rows.
 * @property {number} gen
 */

/**
 * Bring the element's rows in line with this render's.
 * @param {Element & { __ps?: List }} parent
 * @param {any[]} args `[items, row, template]` for pure rows, `[vnodes]`
 * otherwise.
 */
function reconcile(parent, args) {
	const [items, row, t] = args;
	const list = parent.__ps || (parent.__ps = { rows: [], keys: new Map(), items: new Map(), gen: 0 });
	const gen = ++list.gen;
	/** @type {Row[]} */
	const rows = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		let r = row && list.items.get(item);
		if (!r || r.gen == gen) {
			const vnode = row ? untracked(() => row(item)) : item;
			const payload = vnode.props.__pob;
			if (!payload) {
				// Its text holds a vnode. Leave it out until the list re-renders
				// as plain children.
				fallBack(t);
				continue;
			}
			const key = vnode.key;
			r = list.keys.get(key);
			if (!r || r.gen == gen) {
				r = {
					el: parent.ownerDocument.createElementNS(parent.namespaceURI, vnode.type),
					key,
					item,
					gen,
					at: -1
				};
				if (!list.keys.has(key)) list.keys.set(key, r);
			} else if (r.item !== item) {
				if (list.items.get(r.item) == r) list.items.delete(r.item);
				r.item = item;
			}
			patch(r.el, payload());
			if (row) list.items.set(item, r);
		}
		r.gen = gen;
		rows.push(r);
	}
	if (!rows.length && parent.childNodes.length == list.rows.length) {
		// Clearing: one DOM write.
		for (const r of list.rows) drop(list, r);
		parent.textContent = '';
	} else {
		for (const r of list.rows) if (r.gen != gen) drop(list, r).remove();
	}
	// Rows in the longest run already in order stay; the others move in front
	// of the row after them.
	const keep = inOrder(rows);
	/** @type {Node | null} */
	let anchor = null;
	for (let i = rows.length; i--;) {
		const el = rows[i].el;
		if (!keep[i]) parent.insertBefore(el, anchor);
		anchor = el;
	}
	rows.forEach((r, i) => (r.at = i));
	list.rows = rows;
}

/** Forget a row and stop its block. @param {List} list @param {Row} r */
function drop(list, r) {
	dispose(r.el);
	if (list.keys.get(r.key) == r) list.keys.delete(r.key);
	if (list.items.get(r.item) == r) list.items.delete(r.item);
	return r.el;
}

/**
 * Which rows are in the longest subsequence whose previous positions
 * increase.
 * @param {Row[]} rows
 */
function inOrder(rows) {
	const keep = new Uint8Array(rows.length);
	const prev = new Int32Array(rows.length);
	/** @type {number[]} Per length, the row ending the best run of it. */
	const tails = [];
	for (let i = 0; i < rows.length; i++) {
		const at = rows[i].at;
		if (at < 0) continue;
		let lo = tails.length;
		if (lo && rows[tails[lo - 1]].at > at) {
			let hi = lo - 1;
			lo = 0;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (rows[tails[mid]].at < at) lo = mid + 1;
				else hi = mid;
			}
		}
		prev[i] = lo ? tails[lo - 1] : -1;
		tails[lo] = i;
	}
	for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep[i] = 1;
	return keep;
}

/**
 * Stop every row, and remove them unless the element is going away.
 * @param {Element & { __ps?: List }} parent
 * @param {boolean} [unmount]
 */
function clear(parent, unmount) {
	const list = /** @type {List} */ (parent.__ps);
	parent.__ps = undefined;
	for (const r of list.rows) {
		drop(list, r);
		if (!unmount) r.el.remove();
	}
}

/** @param {any} proto `Element.prototype` of a realm */
function install(proto) {
	Object.defineProperty(proto, '__pob', {
		configurable: true,
		set(/** @type {any} */ payload) {
			try {
				if (typeof payload == 'function') patch(this, payload());
				else reset(this);
			} catch (e) {
				// Preact's `setProperty` swallows errors; rethrown from `diffed`.
				this.__pe = [e];
			}
		}
	});
	Object.defineProperty(proto, '__pol', {
		configurable: true,
		set(/** @type {any} */ payload) {
			try {
				if (typeof payload == 'function') reconcile(this, payload());
				else clear(this);
			} catch (e) {
				this.__pe = [e];
			}
		}
	});
}

const HAS_DOM = typeof Element != 'undefined';
if (HAS_DOM) install(Element.prototype);

// `@preact/signals`, imported above, has installed its own hooks already.
const prevDiffed = /** @type {(vnode: any) => void} */ (options.diffed);
options.diffed = vnode => {
	const dom = vnode.__e;
	const props = vnode.props;
	if (typeof vnode.type == 'string' && (props.__pob || props.__pol) && dom) {
		if (!('__pob' in dom)) {
			// An element from another document (an iframe, a popup), which
			// Preact skipped the function-valued prop on.
			install(dom.ownerDocument.defaultView.Element.prototype);
			if (props.__pob) dom.__pob = props.__pob;
			else dom.__pol = props.__pol;
		}
		const error = dom.__pe;
		if (error) {
			// Thrown outside the element's diff, so the nearest error boundary
			// catches it, as it would a throw from the JSX it replaced.
			dom.__pe = undefined;
			throw error[0];
		}
	}
	prevDiffed(vnode);
};

const prevUnmount = /** @type {(vnode: any) => void} */ (options.unmount);
options.unmount = vnode => {
	if (typeof vnode.type == 'string') {
		if (vnode.props.__pob && vnode.__e.__pb) dispose(vnode.__e);
		else if (vnode.props.__pol) clear(vnode.__e, true);
	}
	prevUnmount(vnode);
};

// Preact's own prop logic, for nodes inside a block.

const CAPTURE = /(PointerCapture)$|Capture$/i;
/**
 * Per listener prop name, the event it listens to and the one proxy every
 * block element attaches for it.
 * @type {Record<string, { event: string, capture: boolean, proxy: (e: any) => any }>}
 */
const listeners = {};
let clock = 0;

/** @param {string} name */
function listener(name) {
	let event = name.replace(CAPTURE, '$1');
	const capture = event != name;
	event = event.slice(2);
	if (event[0] < 'a') event = event.toLowerCase();
	return (listeners[name] = { event, capture, proxy: createProxy(name) });
}

/**
 * @param {Element & { __pl?: Record<string, any>, __pa?: Record<string, number> }} dom
 * @param {string} name
 * @param {any} value
 * @param {any} oldValue
 */
function setProp(dom, name, value, oldValue) {
	if (name == 'style') {
		const style = /** @type {any} */ (dom).style;
		if (typeof value == 'string') {
			style.cssText = value;
			return;
		}
		if (typeof oldValue == 'string') style.cssText = oldValue = '';
		if (oldValue) for (const k in oldValue) if (!(value && k in value)) setStyle(style, k, '');
		if (value) {
			for (const k in value) if (!oldValue || value[k] != oldValue[k]) setStyle(style, k, value[k]);
		}
	} else if (name[0] == 'o' && name[1] == 'n') {
		(dom.__pl || (dom.__pl = {}))[name] = value;
		if (!value || !oldValue) {
			const { event, capture, proxy } = listeners[name] || listener(name);
			(dom.__pa || (dom.__pa = {}))[name] = clock;
			if (value) dom.addEventListener(event, proxy, capture);
			else dom.removeEventListener(event, proxy, capture);
		}
	} else {
		// Blocks are never SVG (see the compiler's SVG_ROOTS).
		if (
			name != 'width' &&
			name != 'height' &&
			name != 'href' &&
			name != 'list' &&
			name != 'form' &&
			name != 'tabIndex' &&
			name != 'download' &&
			name != 'rowSpan' &&
			name != 'colSpan' &&
			name != 'role' &&
			name != 'popover' &&
			name in dom
		) {
			try {
				/** @type {any} */ (dom)[name] = value == null ? '' : value;
				return;
			} catch (e) {}
		}
		if (typeof value == 'function') return;
		if (value != null && (value !== false || name[4] == '-')) {
			dom.setAttribute(name, name == 'popover' && value == true ? '' : value);
		} else {
			dom.removeAttribute(name);
		}
	}
}

/** @param {CSSStyleDeclaration} style @param {string} key @param {any} value */
function setStyle(style, key, value) {
	if (value == null) value = '';
	if (key[0] == '-') style.setProperty(key, value);
	else /** @type {any} */ (style)[key] = value;
}

/** @param {string} name */
function createProxy(name) {
	return function (/** @type {any} */ e) {
		// Skip listeners attached while this event was already dispatching,
		// like Preact does.
		if (e.__poc == null) e.__poc = clock++;
		else if (e.__poc < this.__pa[name]) return;
		const fn = this.__pl && this.__pl[name];
		if (fn) return fn(options.event ? options.event(e) : e);
	};
}
