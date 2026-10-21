/** A compiled host-only JSX tree: `fn` is the original JSX with `s[i]` for slot i. */
export interface Template {
	fn: (s: any[]) => any;
	reactive: boolean[];
}
export declare function $template(fn: (s: any[]) => any, reactive: number[]): Template;
/** Render a template with this render's slot values (`[template, ...slots]`). */
export declare function $block(values: [Template, ...any[]], key?: any): any;
/**
 * `<el>{items.map(row)}</el>` where `row` returns a keyed `$block` of `template`:
 * the element's rows are matched by key and patched without diffing. With `pure`,
 * a row isn't rendered again for an item it rendered before.
 */
export declare function $list<T>(
	element: any,
	items: readonly T[],
	row: (item: T) => any,
	template: Template,
	pure: number
): any;
