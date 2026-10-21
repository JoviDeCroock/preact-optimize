/**
 * Mark a hoisted vnode so Preact always clones it before diffing. Preact
 * clones vnodes whose `_depth` (mangled `__b`) is already set, the same trick
 * `@preact/signals` uses for `Signal.prototype`. Without it the first render
 * would adopt the shared object and pin that render's DOM and vnode tree to
 * the module for the lifetime of the app.
 *
 * Clones keep the hoisted vnode's `_original`, which is what lets Preact's
 * strict-equality bail skip the subtree on later renders.
 *
 * @template T
 * @param {T} vnode
 * @returns {T}
 */
export function $static(vnode) {
	vnode.__b = 1;
	return vnode;
}
