import type { Signal } from '@preact/signals';
export declare function $hole<T>(fn: () => T): T;
export declare function $text<T>(fn: () => T): T;
export declare function $derive<T>(fn: () => T): import('@preact/signals').ReadonlySignal<T>;
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
