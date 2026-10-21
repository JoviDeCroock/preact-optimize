import { options } from 'preact';
import { useState } from 'preact/hooks';
import { batch, computed, signal } from '@preact/signals';

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
 * The signal behind a `useState`/`useReducer` call the hooks transform
 * rewrote. Returns `[signal, setter]`, both stable for the component's
 * lifetime.
 *
 * Writes are queued like Preact's state updates and committed on its render
 * tick, so code that runs after `setX()` in the same handler still sees the
 * previous value, exactly as it would with hooks. Updater functions compose
 * against the pending value.
 *
 * @template S, A
 * @param {(state: S, action: A) => S} reducer
 * @param {S | (() => S)} initial
 * @param {(arg: any) => S} [init]
 */
function useSignalState(reducer, initial, init) {
	return useState(() => {
		const state = signal(
			init ? init(initial) : typeof initial == 'function' ? initial() : initial
		);
		let next,
			queued = false;
		const commit = () => {
			queued = false;
			state.value = next;
		};
		const dispatch = action => {
			if (!queued) {
				next = state.peek();
				queued = true;
				enqueue(commit);
			}
			next = reducer(next, action);
		};
		return [state, dispatch];
	})[0];
}

/** @type {Array<() => void>} */
let commits = [];

/** Commit every queued state write in one batch on Preact's render tick. */
function enqueue(commit) {
	if (commits.push(commit) === 1) {
		(options.debounceRendering || queueMicrotask)(() => {
			const queue = commits;
			commits = [];
			batch(() => queue.forEach(fn => fn()));
		});
	}
}

const applyUpdate = (state, update) =>
	typeof update == 'function' ? update(state) : update;

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
