import type { Signal } from '@preact/signals';
/** One reuse key per scope in a module; the output declares `const _k = $sites(n)`. */
export declare function $sites(n: number): object[];
/**
 * Evaluate a JSX expression in its own computed. With `deps` (what it reads
 * from the render) and a `site`, the computed from the previous render is
 * reused while the deps stay the same.
 */
export declare function $hole<T>(fn: () => T, deps?: unknown[], site?: object): T;
export declare function $derive<T>(
	fn: () => T,
	deps?: unknown[],
	site?: object
): import('@preact/signals').ReadonlySignal<T>;
export declare function $useState<S>(initial: S | (() => S)): [Signal<S>, (update: S | ((prev: S) => S)) => void];
export declare function $useReducer<S, A, I = S>(
	reducer: (state: S, action: A) => S,
	initial: I,
	init?: (arg: I) => S
): [Signal<S>, (action: A) => void];

/**
 * A `useMemo` backed by a computed; see the hooks transform. Sources that are
 * not signals are compared by `.value` like dependencies.
 */
export declare function $useMemo<T>(
	fn: () => T,
	deps: unknown[],
	sources?: { readonly value: unknown }[]
): import('@preact/signals').ReadonlySignal<T>;

/** A `useEffect` that also re-runs when a converted state signal changes. */
export declare function $useEffect(
	fn: () => void | (() => void),
	deps: unknown[],
	sources: { readonly value: unknown }[]
): void;
/** A `useLayoutEffect` that also re-runs when a converted state signal changes. */
export declare function $useLayoutEffect(
	fn: () => void | (() => void),
	deps: unknown[],
	sources: { readonly value: unknown }[]
): void;
