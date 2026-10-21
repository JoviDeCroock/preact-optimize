import type { PluginObj } from '@babel/core';

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
}

declare function preactOptimize(api: object, options?: PreactOptimizeOptions): PluginObj;
export default preactOptimize;
