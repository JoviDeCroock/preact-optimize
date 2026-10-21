import type { Plugin } from 'rolldown';

export interface PreactOptimizeOptions {
	/** Cache static JSX at module scope. @default true */
	hoist?: boolean;
	/** Also cache static trees containing component elements. @default false */
	hoistComponents?: boolean;
	/** Bind JSX expressions that read `.value` straight to the DOM. @default true */
	signals?: boolean;
	/** Back hole-only `useState`/`useReducer` state with signals. @default false */
	hooks?: boolean;
	/** Module the runtime helpers are imported from. @default 'preact-optimize' */
	runtime?: string;
	/** Module ids to transform. @default /\.[cm]?(?:jsx?|tsx)$/ */
	include?: RegExp;
	/** Module ids to skip. @default /node_modules/ */
	exclude?: RegExp;
}

declare function preactOptimize(options?: PreactOptimizeOptions): Plugin;
export default preactOptimize;
export { preactOptimize };
