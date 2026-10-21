import { withMagicString } from 'rolldown-string';
import { analyze } from 'preact-optimize/compiler';

const SCRIPT_RE = /\.[cm]?(?:jsx?|tsx)$/;

/** @param {string} id */
const getLang = id => (/\.[cm]?tsx$/.test(id) ? 'tsx' : 'jsx');

/**
 * @typedef {object} Options
 * @property {boolean} [hoist=true] Cache static JSX at module scope.
 * @property {boolean} [hoistComponents=false] Also cache static trees that
 * contain component elements. Those components then only re-render from
 * their own state, context or signals, like `memo()` with constant props.
 * @property {boolean} [signals=true] Move render-time `.value` reads into
 * their own reactive scopes so they update the DOM without re-rendering the
 * component.
 * @property {boolean} [hooks=false] Back `useState`/`useReducer` state with a
 * signal when every render-time read of it can move out of render, so
 * updates skip the component render. Requires `signals`.
 * @property {boolean} [blocks=false] Render host-only JSX trees from cloned
 * DOM templates, patching only their dynamic parts. Requires `signals`.
 * @property {string} [runtime='preact-optimize'] Module the helpers are
 * imported from.
 * @property {RegExp} [include] Module ids to transform.
 * @property {RegExp} [exclude=/node_modules/] Module ids to skip.
 * @property {(id: string, report: import('preact-optimize/compiler').Plan['stats'] & {
 *   diagnostics: { line: number, column: number, reason: string }[],
 *   keptState: { name: string, line: number, column: number, reason: string }[]
 * }) => void} [report] Called per module with the reads that stayed in render.
 */

/**
 * @param {Options} [options]
 * @returns {import('rolldown').Plugin}
 */
export default function preactOptimize(options = {}) {
	const { runtime = 'preact-optimize', include = SCRIPT_RE, exclude = /node_modules/, report } = options;

	const transform = withMagicString(function (s, id) {
		const program = this.parse(s.original, { lang: getLang(id) });
		const plan = analyze(program, s.original, options);
		if (report) {
			report(id, {
				...plan.stats,
				diagnostics: plan.diagnostics.map(({ line, column, reason }) => ({ line, column, reason })),
				keptState: plan.keptState
			});
		}
		if (!plan.hoists.length && !plan.wraps.length && !plan.bindings.length && !plan.blocks.length) {
			return;
		}

		/** Names this transform declares, which must stay distinct too. */
		const taken = new Set();
		/** Avoid colliding with names already in the file. */
		const uid = (/** @type {string} */ name) => {
			let id = '_' + name;
			while (s.original.includes(id) || taken.has(id)) id = '_' + id;
			taken.add(id);
			return id;
		};
		/** @type {Record<string, string>} */
		const helpers = {};
		/** @param {'static' | 'signals' | 'block'} entry @param {string} name */
		const helper = (entry, name) => (helpers[`${entry}:${name}`] ||= uid(name));
		const cachePrefix = uid('h');
		for (let i = 1; i <= plan.hoists.length; i++) taken.add(cachePrefix + i);
		const templatePrefix = uid('t');
		for (let i = 1; i <= plan.blocks.length; i++) taken.add(templatePrefix + i);

		/** @type {Map<import('preact-optimize/compiler').Binding, string>} */
		const targets = new Map();
		for (const binding of plan.bindings) {
			const target = uid(binding.name);
			const id =
				binding.kind === 'useState' || binding.kind === 'useReducer'
					? binding.declarator.id.elements[0]
					: binding.declarator.id;
			s.update(id.start, id.end, target);
			targets.set(binding, target);
			if (binding.kind !== 'derived') {
				const callee = binding.call.callee;
				s.update(callee.start, callee.end, helper('signals', '$' + binding.kind));
			}
			for (const { node, shorthand } of binding.references) {
				s.update(node.start, node.end, shorthand ? `${binding.name}: ${target}.value` : `${target}.value`);
			}
		}

		for (const { node, keep, call, kind, sources } of plan.deps) {
			const slice = (/** @type {any} */ el) => s.original.slice(el.start, el.end);
			let text = `[${keep.map(slice).join(', ')}]`;
			if (kind === 'useEffect' || kind === 'useLayoutEffect') {
				s.update(call.callee.start, call.callee.end, helper('signals', '$' + kind));
			}
			if (kind !== 'useCallback') {
				text += `, [${sources.map(source => ('binding' in source ? targets.get(source.binding) : slice(source.node))).join(', ')}]`;
			}
			s.update(node.start, node.end, text);
		}

		/** @param {import('preact-optimize/compiler').Binding[]} bindings */
		const snapshot = bindings =>
			`const ${bindings.map(binding => `${binding.name} = ${targets.get(binding)}.value`).join(', ')};`;
		/** @type {{ node: any, open: string, close: string }[]} */
		const bodies = [];
		for (const { fn, bindings } of plan.snapshots) {
			const body = fn.body;
			if (body.type === 'BlockStatement') {
				// After any directive prologue.
				let at = body.start + 1;
				for (const stmt of body.body) {
					if (stmt.type !== 'ExpressionStatement' || !stmt.directive) break;
					at = stmt.end;
				}
				s.appendLeft(at, ` ${snapshot(bindings)}`);
			} else {
				// Oxc drops parentheses, so start the block right after `=>`.
				const start = s.original.lastIndexOf('=>', body.start) + 2;
				bodies.push({
					node: { start, end: fn.end },
					open: ` { ${snapshot(bindings)} return (`,
					close: '); }'
				});
			}
		}

		// Openers stack with `appendRight` and closers with `prependLeft`, so
		// applying outer edits first nests wrappers that share a boundary;
		// a function body is outside anything that wraps the same expression.
		const edits = [
			...bodies,
			...plan.hoists.map((hoist, i) => {
				const cache = `${cachePrefix}${i + 1}`;
				const container =
					hoist.parent.type === 'JSXElement' ||
					hoist.parent.type === 'JSXFragment' ||
					hoist.parent.type === 'JSXAttribute';
				return {
					node: hoist.node,
					open: `${container ? '{' : ''}(${cache} || (${cache} = ${helper('static', '$static')}(`,
					close: `)))${container ? '}' : ''}`
				};
			}),
			...plan.wraps.map(wrap => ({
				node: wrap.node,
				open: `${wrap.kind === 'element' ? '{' : ''}${helper(
					'signals',
					wrap.kind === 'derived' ? '$derive' : wrap.text ? '$text' : '$hole'
				)}(() => (`,
				close: `))${wrap.kind === 'element' ? '}' : ''}`
			})),
			// After wraps: inside one that wraps the same element.
			...plan.lists.map(list => {
				const container =
					!plan.wraps.some(wrap => wrap.node === list.node) &&
					(list.parent.type === 'JSXElement' ||
						list.parent.type === 'JSXFragment' ||
						list.parent.type === 'JSXAttribute');
				return {
					node: list.node,
					open: `${container ? '{' : ''}${helper('block', '$list')}(`,
					close: `)${container ? '}' : ''}`
				};
			})
		].sort((a, b) => a.node.start - b.node.start || b.node.end - a.node.end);

		for (const edit of edits) {
			s.appendRight(edit.node.start, edit.open);
			s.prependLeft(edit.node.end, edit.close);
		}

		// Blocks last: their text between slots is overwritten, keeping what
		// other edits added at the root's edges and inside slots.
		/** @type {string[]} */
		const templates = [];
		for (const [index, block] of plan.blocks.entries()) {
			const root = block.node;
			const name = templatePrefix + (index + 1);
			const keyAttr = root.openingElement.attributes.find((/** @type {any} */ attr) => attr.name.name === 'key');
			const key = block.keyNode ? s.slice(block.keyNode.start, block.keyNode.end) : null;
			// Template: the original JSX with `s[i]` in each slot, without the key.
			const cuts = block.slots.map((slot, i) => ({
				start: slot.node.start,
				end: slot.node.end,
				text: `s[${i}]`
			}));
			if (keyAttr) cuts.push({ start: keyAttr.start, end: keyAttr.end, text: '' });
			cuts.sort((a, b) => a.start - b.start);
			let template = '';
			let pos = root.start;
			for (const cut of cuts) {
				template += s.original.slice(pos, cut.start) + cut.text;
				pos = cut.end;
			}
			template += s.original.slice(pos, root.end);
			const reactive = block.slots.flatMap((slot, i) => (slot.reactive ? [i] : []));
			// Unused components can drop their templates.
			templates.push(
				`var ${name} = /* @__PURE__ */ ${helper('block', '$template')}(s => ${template}, [${reactive.join(', ')}]);\n`
			);

			const container =
				block.parent.type === 'JSXElement' ||
				block.parent.type === 'JSXFragment' ||
				block.parent.type === 'JSXAttribute';
			let text = `${container ? '{' : ''}${helper('block', '$block')}([${name}`;
			pos = root.start;
			for (const slot of block.slots) {
				text += slot.reactive ? ', () => (' : ', ';
				s.overwrite(pos, slot.node.start, text, { contentOnly: true });
				text = slot.reactive ? ')' : '';
				pos = slot.node.end;
			}
			text += `]${key ? `, ${key}` : ''})${container ? '}' : ''}`;
			s.overwrite(pos, root.end, text, { contentOnly: true });
		}

		// `<el>{items.map(row)}</el>` to `$list(<el></el>, items, row, template, pure)`.
		for (const list of plan.lists) {
			const el = list.node;
			const opening = el.openingElement;
			const tag = s.original.slice(opening.name.start, opening.name.end);
			const template = templatePrefix + (plan.blocks.indexOf(list.block) + 1);
			s.overwrite(opening.end, list.items.start, `</${tag}>, `, { contentOnly: true });
			s.overwrite(list.items.end, list.fn.start, ', ', { contentOnly: true });
			s.overwrite(list.fn.end, el.end, `, ${template}, ${+list.pure}`, { contentOnly: true });
		}

		let header = '';
		for (const key of Object.keys(helpers)) {
			const [entry, name] = key.split(':');
			header += `import { ${name} as ${helpers[key]} } from ${JSON.stringify(`${runtime}/${entry}`)};\n`;
		}
		if (plan.hoists.length) {
			header += `var ${plan.hoists.map((_, i) => cachePrefix + (i + 1)).join(', ')};\n`;
		}
		header += templates.join('');

		// Keep directives ("use client") and hashbangs first.
		let at = program.hashbang ? program.hashbang.end : 0;
		for (const stmt of program.body) {
			if (stmt.type !== 'ExpressionStatement' || !stmt.directive) break;
			at = stmt.end;
		}
		if (at) s.appendLeft(at, '\n' + header);
		else s.prepend(header);
	});

	return {
		name: 'preact-optimize',
		enforce: 'pre',
		transform: {
			filter: { id: { include, exclude } },
			handler(code, id) {
				return transform.call(this, code, id);
			}
		}
	};
}

export { preactOptimize };
