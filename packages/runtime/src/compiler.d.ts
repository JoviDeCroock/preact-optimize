export interface ModuleBinding {
	kind: 'import' | 'const' | 'let' | 'function' | 'class';
	init?: any;
	source?: string;
	imported?: string;
}
export interface ModuleScope {
	bindings: Map<string, ModuleBinding>;
}
export interface StaticOptions {
	hoistComponents: boolean;
	scope: ModuleScope;
}
export interface Wrap {
	kind: 'hole' | 'element' | 'return' | 'derived';
	node: any;
	parent: any;
	key: string;
	/**
	 * What the scope reads from outside itself, so its computed can be reused
	 * while they stay the same: a converted binding's signal, or a name.
	 * `null` when it reads something else (`this`, impure globals, a ref's
	 * `.current`, component elements without `hoistComponents`).
	 */
	deps: { name: string; binding?: Binding }[] | null;
}
export interface Reference {
	node: any;
	parent: any;
	key: string;
	shorthand: boolean;
}
export interface Binding {
	kind: 'useState' | 'useReducer' | 'useMemo' | 'derived';
	name: string;
	declarator: any;
	/** The hook call, without TypeScript wrappers; absent for derived values. */
	call?: any;
	references: Reference[];
}
/** A host-only tree printed as `$block([template, ...slots], key)`. */
export interface Block {
	node: any;
	parent: any;
	key: string;
	/** The root's `key` value, if any. */
	keyNode: any;
	/** Attribute values (`name`) and text children (`name: null`) in source order. */
	slots: { node: any; container: any; name: string | null; reactive: boolean }[];
}
export interface BlockShape {
	slots: { node: any; container: any; name: string | null }[];
	key: any;
}
export interface Diagnostic {
	node: any;
	reason: string;
	line: number;
	column: number;
}
export interface Plan {
	hoists: { node: any; parent: any; key: string }[];
	wraps: Wrap[];
	blocks: Block[];
	bindings: Binding[];
	/** Render-created functions that start by snapshotting converted values. */
	snapshots: { fn: any; bindings: Binding[] }[];
	/** Hook dependency arrays to rewrite; signal dependencies move to `sources`. */
	deps: {
		node: any;
		keep: any[];
		call: any;
		kind: 'useMemo' | 'useCallback' | 'useEffect' | 'useLayoutEffect';
		sources: ({ binding: Binding } | { node: any })[];
	}[];
	diagnostics: Diagnostic[];
	keptState: { name: string; reason: string; line: number; column: number }[];
	stats: { reads: number; moved: number };
}
export interface AnalyzeOptions {
	hoist?: boolean;
	hoistComponents?: boolean;
	signals?: boolean;
	hooks?: boolean;
	blocks?: boolean;
}
export declare function patternNames(node: any, names: Set<string>): Set<string>;
export declare function moduleScope(program: any): ModuleScope;
export declare function isStaticValue(node: any, scope?: ModuleScope, asChild?: boolean): boolean;
export declare function isHostName(name: any): boolean;
export declare function componentRoot(name: any): string | null;
export declare function isStaticJSX(node: any, opts: StaticOptions): boolean;
export declare function isBindableAttribute(attr: any): boolean;
export declare function isBindablePosition(parent: any, opening?: any): boolean;
export declare function blockShape(root: any): BlockShape | null;
export declare function analyze(program: any, code: string, options?: AnalyzeOptions): Plan;
