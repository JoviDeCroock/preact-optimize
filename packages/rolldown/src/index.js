import { withMagicString } from 'rolldown-string';
import {
	findStateHooks,
	isBindablePosition,
	isSignalHole,
	isStaticJSX,
	moduleScope
} from 'preact-optimize/compiler';

const SCRIPT_RE = /\.[cm]?(?:jsx?|tsx)$/;

/** @param {string} id */
const getLang = id => (/\.[cm]?tsx$/.test(id) ? 'tsx' : 'jsx');

/** @param {any} value */
const isNode = value => !!value && typeof value.type === 'string';

/**
 * @typedef {object} Options
 * @property {boolean} [hoist=true] Cache static JSX at module scope.
 * @property {boolean} [hoistComponents=false] Also cache static trees that
 * contain component elements. Those components then only re-render from
 * their own state, context or signals, like `memo()` with constant props.
 * @property {boolean} [signals=true] Move JSX expressions that read `.value`
 * into their own computed so they bind to the DOM instead of re-rendering the
 * component.
 * @property {boolean} [hooks=false] Back `useState`/`useReducer` state with a
 * signal when it is only read inside JSX expressions and closures, so updates
 * skip the component render. Requires `signals`.
 * @property {string} [runtime='preact-optimize'] Module the helpers are
 * imported from.
 * @property {RegExp} [include] Module ids to transform.
 * @property {RegExp} [exclude=/node_modules/] Module ids to skip.
 */

/**
 * @param {Options} [options]
 * @returns {import('rolldown').Plugin}
 */
export default function preactOptimize(options = {}) {
	const {
		hoist = true,
		hoistComponents = false,
		signals = true,
		hooks = false,
		runtime = 'preact-optimize',
		include = SCRIPT_RE,
		exclude = /node_modules/
	} = options;

	const transform = withMagicString(function (s, id) {
		const program = this.parse(s.original, { lang: getLang(id) });
		const scope = moduleScope(program);

		/** Avoid colliding with names already in the file. */
		const uid = (/** @type {string} */ name) => {
			let id = '_' + name;
			while (s.original.includes(id)) id = '_' + id;
			return id;
		};
		/** @type {Record<string, string>} */
		const helpers = {};
		/** @param {'static' | 'signals'} entry @param {string} name */
		const helper = (entry, name) => (helpers[`${entry}:${name}`] ||= uid(name));
		const cachePrefix = uid('h');
		let caches = 0;

		/** Identifiers the hooks transform turned into signal reads. */
		const reactive = new Set();
		if (signals && hooks) {
			for (const { declarator, hook, name, references } of findStateHooks(
				program,
				scope
			)) {
				const signal = uid(name);
				const state = declarator.id.elements[0];
				s.update(state.start, state.end, signal);
				const callee = declarator.init.callee;
				s.update(callee.start, callee.end, helper('signals', '$' + hook));
				for (const { node, shorthand } of references) {
					reactive.add(node);
					s.update(
						node.start,
						node.end,
						shorthand ? `${name}: ${signal}.value` : `${signal}.value`
					);
				}
			}
		}
		const isReactive = (/** @type {any} */ node) => reactive.has(node);

		const openingOf = new WeakMap();

		// Pre-order walk: outer nodes are edited before inner ones. Openers
		// stack with `appendRight` and closers with `prependLeft` so nested
		// wrappers that share a boundary nest correctly.
		/** @param {any} node @param {any} parent @param {number} fnDepth */
		const visit = (node, parent, fnDepth) => {
			if (
				hoist &&
				fnDepth > 0 &&
				(node.type === 'JSXElement' || node.type === 'JSXFragment') &&
				isStaticJSX(node, { hoistComponents, scope })
			) {
				const cache = `${cachePrefix}${++caches}`;
				const container =
					parent.type === 'JSXElement' ||
					parent.type === 'JSXFragment' ||
					parent.type === 'JSXAttribute';
				s.appendRight(
					node.start,
					`${container ? '{' : ''}(${cache} || (${cache} = ${helper('static', '$static')}(`
				);
				s.prependLeft(node.end, `)))${container ? '}' : ''}`);
				return;
			}

			if (
				signals &&
				node.type === 'JSXExpressionContainer' &&
				isBindablePosition(parent, openingOf.get(parent)) &&
				isSignalHole(node.expression, isReactive)
			) {
				s.appendRight(node.expression.start, `${helper('signals', '$hole')}(() => (`);
				s.prependLeft(node.expression.end, '))');
				fnDepth++;
			}

			if (/Function/.test(node.type)) fnDepth++;
			// ESTree has no parent pointers; attributes need their tag name.
			if (node.type === 'JSXOpeningElement') {
				for (const attr of node.attributes) openingOf.set(attr, node);
			}

			for (const key in node) {
				const value = node[key];
				if (Array.isArray(value)) {
					for (const child of value) {
						if (isNode(child)) visit(child, node, fnDepth);
					}
				} else if (isNode(value)) {
					visit(value, node, fnDepth);
				}
			}
		};
		visit(program, null, 0);

		const keys = Object.keys(helpers);
		if (!keys.length) return;

		let header = '';
		for (const key of keys) {
			const [entry, name] = key.split(':');
			header += `import { ${name} as ${helpers[key]} } from ${JSON.stringify(`${runtime}/${entry}`)};\n`;
		}
		if (caches) {
			const vars = [];
			for (let i = 1; i <= caches; i++) vars.push(cachePrefix + i);
			header += `var ${vars.join(', ')};\n`;
		}

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
