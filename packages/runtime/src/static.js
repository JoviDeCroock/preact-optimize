import { Fragment, createElement } from 'preact';

/**
 * Prepare a hoisted vnode for reuse across renders.
 *
 * Preact clones vnodes whose `_depth` (mangled `__b`) is already set, the same
 * trick `@preact/signals` uses for `Signal.prototype`. Without it the first
 * render would adopt the shared object and pin that render's DOM and vnode
 * tree to the module for the lifetime of the app.
 *
 * Clones keep the hoisted vnode's `_original`, which Preact's strict-equality
 * bail compares, but core only bails on component vnodes. Host elements with
 * element children are therefore wrapped in a Fragment (keeping their key),
 * so the whole subtree is skipped on re-render instead of re-diffed. Leaves
 * and text-only elements aren't: re-diffing them (props are the same object)
 * is cheaper than mounting and unmounting a Fragment, which adds up in lists.
 *
 * @template T
 * @param {T} vnode
 * @returns {T}
 */
export function $static(vnode) {
	vnode.__b = 1;
	const children = vnode.props.children;
	if (typeof vnode.type == 'string' && children != null && typeof children == 'object') {
		vnode = createElement(Fragment, { key: vnode.key }, vnode);
		vnode.__b = 1;
	}
	return vnode;
}
