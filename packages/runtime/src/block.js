import { options } from 'preact';
import { jsx } from 'preact/jsx-runtime';
import { Signal, effect, signal, untracked } from '@preact/signals';
import { $hole } from './signals.js';

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
 */

/**
 * @typedef {object} Template
 * @property {(s: any[]) => any} fn The original JSX with `s[i]` for slot i.
 * @property {boolean[]} reactive Per slot, whether it is a function to track.
 * @property {string} [type] The root tag, once `fn` has run.
 * @property {number[]} [text] Indices of text slots.
 * @property {import('@preact/signals').Signal<number>} [epoch] Read by every
 * render with a reactive (or signal) text slot, and bumped when an effect finds a
 * vnode in one, so whatever rendered it (a component, or a hole's computed)
 * runs again and falls back.
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
	return { fn, reactive: flags };
}

/**
 * Props Preact sets as DOM properties that a clone wouldn't carry: properties
 * that don't reflect to attributes, and listeners (Preact attaches even a
 * string). Static ones become slots with a fixed value.
 */
const PROPERTY_ONLY =
	/^(?:value|checked|selected|defaultValue|defaultChecked|muted|indeterminate|innerHTML|textContent|innerText|srcObject|on.*)$/;

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
	t.epoch = signal(0);
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
	if (live) /** @type {any} */ (t.epoch).value;
	return jsx(/** @type {string} */ (t.type), { __pob: () => values }, key);
}

/** The original JSX for values a template can't hold. */
function fallback(/** @type {Template} */ t, /** @type {any[]} */ values, /** @type {any} */ key) {
	const s = [];
	for (let i = 1; i < values.length; i++) {
		s.push(t.reactive[i - 1] ? $hole(values[i]) : values[i]);
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
	 * @param {any} props
	 * @param {Element} el
	 * @param {number[]} path
	 */
	const applyProps = (props, el, path) => {
		for (const name in props) {
			if (name === 'children') continue;
			const slot = slotOf(props[name]);
			if (slot >= 0) slots[slot] = { path, name };
			else if (PROPERTY_ONLY.test(name)) fixed.push({ path, name, value: props[name] });
			else setProp(el, name, props[name]);
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
	for (const name in root.props) {
		const value = root.props[name];
		if (name !== 'children' && slotOf(value) < 0 && !PROPERTY_ONLY.test(name)) props.push([name, value]);
	}
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

/** Stop a block's effect. Enough on unmount: its DOM is going away. */
function dispose(/** @type {Element & { __pb?: Instance }} */ dom) {
	const inst = /** @type {Instance} */ (dom.__pb);
	dom.__pb = undefined;
	if (inst.dispose) inst.dispose();
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
	if (name == 'value' || name == 'checked') {
		// Like Preact, compare against the live DOM state.
		if (value !== undefined && value !== node[name]) setProp(node, name, value, old);
	} else if (value === old) {
		return;
	} else if (name) {
		setProp(node, name, value, old);
	} else {
		node.data = value == null || typeof value == 'boolean' ? '' : value;
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
			const epoch = /** @type {any} */ (t.epoch);
			epoch.value = epoch.peek() + 1;
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
			inst.dispose = effect(() => apply(self, input.value));
			return;
		}
	}
	apply(inst, values);
}

const HAS_DOM = typeof Element != 'undefined';
if (HAS_DOM) {
	Object.defineProperty(Element.prototype, '__pob', {
		configurable: true,
		set(/** @type {any} */ payload) {
			if (typeof payload == 'function') patch(this, payload());
			else reset(this);
		}
	});
}

// `@preact/signals`, imported above, has installed its own hook already.
const prevUnmount = /** @type {(vnode: any) => void} */ (options.unmount);
options.unmount = vnode => {
	if (typeof vnode.type == 'string' && vnode.props.__pob) dispose(/** @type {any} */ (vnode).__e);
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
		return this.__pl[name](options.event ? options.event(e) : e);
	};
}
