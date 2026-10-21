import type { Plugin } from 'rolldown';

export interface OptimizeReport {
	/** Render-time reactive reads (`.value`, and state with `hooks`). */
	reads: number;
	/** How many of those moved into a hole or derived signal. */
	moved: number;
	/** Reads that stayed in render. */
	diagnostics: { line: number; column: number; reason: string }[];
	/** `useState`/`useReducer` calls that stayed hooks (with `hooks`). */
	keptState: { name: string; line: number; column: number; reason: string }[];
}

export interface PreactOptimizeOptions {
	/** Cache static JSX at module scope. @default true */
	hoist?: boolean;
	/** Also cache static trees containing component elements. @default false */
	hoistComponents?: boolean;
	/** Move render-time `.value` reads into their own reactive scopes. @default true */
	signals?: boolean;
	/** Back `useState`/`useReducer` state with signals when no read needs the render. @default false */
	hooks?: boolean;
	/**
	 * Render host-only JSX trees from cloned DOM templates, patching only their
	 * dynamic parts. Experimental; needs `signals`. @default false
	 */
	blocks?: boolean;
	/** Module the runtime helpers are imported from. @default 'preact-optimize' */
	runtime?: string;
	/**
	 * Called once per file with how many render-time reads moved out of
	 * render, plus the position and reason of every read that stayed.
	 */
	report?: (file: string, report: OptimizeReport) => void;
	/** Module ids to transform. @default /\.[cm]?(?:jsx?|tsx)$/ */
	include?: RegExp;
	/** Module ids to skip. @default /node_modules/ */
	exclude?: RegExp;
}

/** A Rolldown plugin; Vite reads `enforce` to run it before its JSX transform. */
declare function preactOptimize(options?: PreactOptimizeOptions): Plugin & { enforce: 'pre' };
export default preactOptimize;
export { preactOptimize };
