import { options } from 'preact';
import { useEffect, useLayoutEffect, useMemo } from 'preact/hooks';
import { Signal, computed, effect, signal } from '@preact/signals';

/**
 * Evaluate a JSX expression in its own reactive scope.
 *
 * The expression runs once, untracked, so the rendering component does not
 * subscribe to the signals it reads. When it did read signals, the computed
 * is returned and `@preact/signals` binds it straight to the DOM: a text
 * node, an attribute, or a `ReactiveTextNode` that re-renders on its own for
 * vnode values. When it read none, the plain value is returned and nothing
 * changes compared to the untransformed code.
 *
 * A fresh computed per render is intentional: the closure captures this
 * render's props and state, and the component re-renders (and recreates the
 * hole) whenever those change.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function $hole(fn) {
	const c = computed(fn);
	const value = c.peek();
	// `_sources` (mangled `s`) is the head of the computed's dependency list.
	return c.s ? c : value;
}

/**
 * A hole rendered as a child. `@preact/signals` renders a text computed's
 * falsy values as nothing, where Preact renders `NaN` and `0n`: hand it
 * those as strings, which render the same.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function $text(fn) {
	return $hole(() => {
		const value = fn();
		return /** @type {any} */ (value !== value || typeof value == 'bigint' ? '' + value : value);
	});
}

/**
 * A derived constant (`const doubled = count.value * 2`) whose reads all moved
 * into holes.
 *
 * @template T
 * @param {() => T} fn
 */
export function $derive(fn) {
	const c = computed(fn);
	// Evaluate where the declaration was, like the initializer it replaces.
	c.peek();
	return c;
}

/**
 * The signal behind a `useState`/`useReducer` call the hooks transform
 * rewrote. Returns `[signal, setter]`, both stable for the component's
 * lifetime.
 *
 * Writes commit right away. Code later in the same handler still sees the
 * previous value, because every function created during render starts by
 * snapshotting the state it reads; committing before Preact's render queue
 * runs lets ancestors re-render their holes in the same pass as hook updates
 * from the same handler, instead of a child seeing half of them. Actions go
 * through the latest render's reducer, like `useReducer`.
 *
 * Held with `useMemo`, not `useState`: the setter never runs, and a
 * `useState` call alone makes preact/hooks wrap `shouldComponentUpdate` and
 * @preact/signals mark the component as having hook state, which turns off
 * its bail-out for signal-driven components.
 *
 * @template S, A
 * @param {(state: S, action: A) => S} reducer
 * @param {S | (() => S)} initial
 * @param {(arg: any) => S} [init]
 */
function useSignalState(reducer, initial, init) {
	const hook = useMemo(() => {
		const state = signal(init ? init(initial) : typeof initial == 'function' ? initial() : initial);
		const dispatch = action => {
			const prev = state.peek();
			const next = hook.reducer(prev, action);
			// Like hooks, `NaN` to `NaN` is no update. Signals compare with `!==`,
			// so `-0` to `0` is no update either (hooks would re-render).
			if (!Object.is(prev, next)) state.value = next;
		};
		return { reducer, pair: [state, dispatch] };
	}, []);
	hook.reducer = reducer;
	return hook.pair;
}

const applyUpdate = (state, update) => (typeof update == 'function' ? update(state) : update);

/**
 * @template S
 * @param {S | (() => S)} initial
 */
export function $useState(initial) {
	return useSignalState(applyUpdate, initial);
}

/**
 * @template S, A
 * @param {(state: S, action: A) => S} reducer
 * @param {any} initial
 * @param {(arg: any) => S} [init]
 */
export function $useReducer(reducer, initial, init) {
	// `useReducer` never treats the initial value as a lazy initializer.
	return useSignalState(reducer, init ? initial : () => initial, init);
}

/**
 * A `useMemo` whose result is only read in reactive scopes. The value is a
 * computed that recomputes when one of the `sources` (dependencies that are
 * signals now) changes; the remaining dependencies recreate it like
 * `useMemo` would.
 *
 * @template T
 * @param {() => T} fn
 * @param {unknown[]} deps
 * @param {import('@preact/signals').ReadonlySignal[]} [sources]
 */
export function $useMemo(fn, deps, sources = []) {
	[deps, sources] = split(deps, sources);
	return useMemo(
		() =>
			computed(() => {
				for (const source of sources) source.value;
				return fn();
			}),
		deps
	);
}

/**
 * The compiler moves every `x.value` dependency to `sources`, but only
 * signals can be followed: anything else goes back to being an ordinary
 * dependency, compared by its current `.value`.
 * @param {unknown[]} deps
 * @param {any[]} sources
 * @returns {[unknown[], import('@preact/signals').Signal[]]}
 */
function split(deps, sources) {
	let signals = sources;
	for (const source of sources) {
		if (!(source instanceof Signal)) {
			if (signals === sources) {
				signals = sources.filter(s => s instanceof Signal);
				deps = deps.slice();
			}
			deps.push(source.value);
		}
	}
	return [deps, signals];
}

/**
 * An effect whose dependencies include converted state. The remaining
 * dependencies work as before; when one of the `sources` signals changes the
 * effect re-runs (cleanup first) with the latest render's callback, which
 * reads the same values a re-render would have given it.
 *
 * @param {typeof useEffect} hook
 * @param {boolean} layout
 * @param {() => any} fn
 * @param {unknown[]} deps
 * @param {import('@preact/signals').Signal[]} sources
 */
function useReactiveEffect(hook, layout, fn, deps, sources) {
	[deps, sources] = split(deps, sources);
	const latest = useMemo(() => ({ fn, deps, epoch: 0, sources: signal(sources) }), []);
	latest.fn = fn;
	// A render that changes `deps` re-runs the hook itself; a re-run queued by
	// the previous instance must not run against the new callback first.
	if (changed(deps, latest.deps)) latest.epoch++;
	latest.deps = deps;
	// Memos and derived values are new signals after some renders: point the
	// watcher at this render's ones. Re-runs still compare values.
	if (changed(sources, latest.sources.peek())) latest.sources.value = sources;
	hook(() => {
		const read = () => latest.sources.peek().map(source => source.peek());
		const epoch = latest.epoch;
		let values = read(),
			cleanup = latest.fn(),
			active = true,
			pending = false;
		const run = () => {
			pending = false;
			const next = read();
			if (!active || epoch !== latest.epoch || !changed(next, values)) return;
			values = next;
			if (typeof cleanup == 'function') cleanup();
			cleanup = latest.fn();
		};
		const dispose = effect(() => {
			for (const source of latest.sources.value) source.value;
			if (!pending) {
				pending = true;
				afterUpdate(layout, run);
			}
		});
		return () => {
			active = false;
			dispose();
			if (typeof cleanup == 'function') cleanup();
		};
	}, deps);
}

/** Whether two dependency lists differ, like hooks compare them. */
const changed = (next, prev) => next.length !== prev.length || next.some((value, i) => !Object.is(value, prev[i]));

/**
 * Like preact/hooks' fallback when `options.requestAnimationFrame` is unset:
 * the next frame, or 35ms without one.
 */
function afterNextFrame(cb) {
	const hasRaf = typeof requestAnimationFrame == 'function';
	let raf;
	const done = () => {
		clearTimeout(timeout);
		if (hasRaf) cancelAnimationFrame(raf);
		setTimeout(cb);
	};
	const timeout = setTimeout(done, 35);
	if (hasRaf) raf = requestAnimationFrame(done);
}

/** @param {() => void} cb */
const twoMicrotasks = cb => queueMicrotask(() => queueMicrotask(cb));

/**
 * Schedule an effect re-run once the DOM reflects the change.
 * @preact/signals flushes its DOM bindings through
 * `options.requestAnimationFrame` (or two microtasks) from the batch that
 * changed the source, which is where this is called from too; a second hop
 * of the same scheduler lands behind that flush and behind renders queued
 * on microtasks. Passive effects then wait for the next frame like
 * `useEffect` does.
 * @param {boolean} layout
 * @param {() => void} cb
 */
function afterUpdate(layout, cb) {
	const raf = options.requestAnimationFrame;
	if (raf) raf(() => raf(cb));
	else if (layout) twoMicrotasks(() => twoMicrotasks(cb));
	else afterNextFrame(cb);
}

/**
 * @param {() => any} fn
 * @param {unknown[]} deps
 * @param {import('@preact/signals').Signal[]} sources
 */
export function $useEffect(fn, deps, sources) {
	useReactiveEffect(useEffect, false, fn, deps, sources);
}

/**
 * @param {() => any} fn
 * @param {unknown[]} deps
 * @param {import('@preact/signals').Signal[]} sources
 */
export function $useLayoutEffect(fn, deps, sources) {
	useReactiveEffect(useLayoutEffect, true, fn, deps, sources);
}
