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
export interface StateReference {
	node: any;
	parent: any;
	key: string;
	shorthand: boolean;
}
export interface StateHook {
	declarator: any;
	hook: 'useState' | 'useReducer';
	name: string;
	references: StateReference[];
}
export declare function patternNames(node: any, names: Set<string>): Set<string>;
export declare function moduleScope(program: any): ModuleScope;
export declare function isStaticValue(node: any, scope?: ModuleScope, asChild?: boolean): boolean;
export declare function isHostName(name: any): boolean;
export declare function componentRoot(name: any): string | null;
export declare function isStaticJSX(node: any, opts: StaticOptions): boolean;
export declare function isSignalHole(expression: any, isReactive?: (node: any) => boolean): boolean;
export declare function isBindableAttribute(attr: any): boolean;
export declare function isBindablePosition(parent: any, opening?: any): boolean;
export declare function findStateHooks(program: any, scope: ModuleScope): StateHook[];
