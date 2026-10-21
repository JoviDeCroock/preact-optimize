import type { Signal } from '@preact/signals';
export declare function $hole<T>(fn: () => T): T;
export declare function $useState<S>(
	initial: S | (() => S)
): [Signal<S>, (update: S | ((prev: S) => S)) => void];
export declare function $useReducer<S, A, I = S>(
	reducer: (state: S, action: A) => S,
	initial: I,
	init?: (arg: I) => S
): [Signal<S>, (action: A) => void];
