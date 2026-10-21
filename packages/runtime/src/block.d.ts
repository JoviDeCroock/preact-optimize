/** A compiled host-only JSX tree: `fn` is the original JSX with `s[i]` for slot i. */
export interface Template {
	fn: (s: any[]) => any;
	reactive: boolean[];
}
export declare function $template(fn: (s: any[]) => any, reactive: number[]): Template;
/** Render a template with this render's slot values (`[template, ...slots]`). */
export declare function $block(values: [Template, ...any[]], key?: any): any;
