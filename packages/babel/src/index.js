import { analyze } from 'preact-optimize/compiler';

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
 * @property {(file: string, report: import('preact-optimize/compiler').Plan['stats'] & {
 *   diagnostics: { line: number, column: number, reason: string }[],
 *   keptState: { name: string, line: number, column: number, reason: string }[]
 * }) => void} [report] Called per file with the reads that stayed in render.
 */

/**
 * Replace `node` in its parent slot (which may be an array).
 * @param {any} parent
 * @param {string} key
 * @param {any} node
 * @param {any} replacement
 */
function replace(parent, key, node, replacement) {
	const slot = parent[key];
	if (Array.isArray(slot)) slot[slot.indexOf(node)] = replacement;
	else parent[key] = replacement;
}

/**
 * @param {import('@babel/core').ConfigAPI & { types: typeof import('@babel/core').types }} api
 * @param {Options} options
 * @returns {import('@babel/core').PluginObj}
 */
export default function preactOptimize(api, options = {}) {
	const t = api.types;
	const { runtime = 'preact-optimize', report } = options;

	/** JSX children and attribute values need a `{}` container. */
	const inJSX = (/** @type {any} */ parent) =>
		parent.type === 'JSXElement' || parent.type === 'JSXFragment' || parent.type === 'JSXAttribute';

	return {
		name: 'preact-optimize',
		visitor: {
			Program(program, state) {
				const code = state.file.code;
				const plan = analyze(program.node, code, options);
				if (report) {
					report(state.filename || 'unknown', {
						...plan.stats,
						diagnostics: plan.diagnostics.map(({ line, column, reason }) => ({ line, column, reason })),
						keptState: plan.keptState
					});
				}
				if (!plan.hoists.length && !plan.wraps.length && !plan.bindings.length && !plan.blocks.length) {
					return;
				}

				/** @type {Record<string, import('@babel/core').types.Identifier>} */
				const helpers = {};
				/** @param {'static' | 'signals' | 'block'} entry @param {string} name */
				const helper = (entry, name) => {
					if (!helpers[name]) {
						const id = program.scope.generateUidIdentifier(name);
						helpers[name] = id;
						program.unshiftContainer(
							'body',
							t.importDeclaration([t.importSpecifier(id, t.identifier(name))], t.stringLiteral(`${runtime}/${entry}`))
						);
					}
					return t.cloneNode(helpers[name]);
				};

				/** @type {Map<import('preact-optimize/compiler').Binding, string>} */
				const targets = new Map();
				for (const binding of plan.bindings) {
					const target = program.scope.generateUid(binding.name);
					const id =
						binding.kind === 'useState' || binding.kind === 'useReducer'
							? binding.declarator.id.elements[0]
							: binding.declarator.id;
					id.name = target;
					targets.set(binding, target);
					if (binding.kind !== 'derived') {
						binding.call.callee = helper('signals', '$' + binding.kind);
					}
					for (const { node, parent, shorthand } of binding.references) {
						if (shorthand) parent.shorthand = false;
						// Mutate in place: the node may also be a wrap target.
						const read = t.memberExpression(t.identifier(target), t.identifier('value'));
						for (const key of Object.keys(node)) delete node[key];
						Object.assign(node, read);
					}
				}

				for (const { node, keep, call, kind, sources } of plan.deps) {
					node.elements = keep;
					if (kind === 'useEffect' || kind === 'useLayoutEffect') {
						call.callee = helper('signals', '$' + kind);
					}
					if (kind !== 'useCallback') {
						call.arguments.push(
							t.arrayExpression(
								sources.map(source =>
									'binding' in source
										? t.identifier(/** @type {string} */ (targets.get(source.binding)))
										: t.cloneNode(source.node)
								)
							)
						);
					}
				}

				// Before wraps: a wrap may hold a block root, which changes in place.
				for (const block of plan.blocks) {
					const root = block.node;
					const opening = root.openingElement;
					opening.attributes = opening.attributes.filter((/** @type {any} */ attr) => attr.name.name !== 'key');
					const values = [];
					const reactive = [];
					for (let i = 0; i < block.slots.length; i++) {
						const { node, container, reactive: isReactive } = block.slots[i];
						container.expression = t.memberExpression(t.identifier('s'), t.numericLiteral(i), true);
						values.push(isReactive ? t.arrowFunctionExpression([], node) : node);
						if (isReactive) reactive.push(t.numericLiteral(i));
					}
					const template = program.scope.generateUidIdentifier('t');
					const init = t.callExpression(helper('block', '$template'), [
						t.arrowFunctionExpression([t.identifier('s')], t.cloneNode(root, true)),
						t.arrayExpression(reactive)
					]);
					// Unused components can drop their templates.
					t.addComment(init, 'leading', '#__PURE__');
					program.scope.push({ id: template, init });
					const call = t.callExpression(helper('block', '$block'), [
						t.arrayExpression([t.cloneNode(template), ...values]),
						...(block.keyNode ? [block.keyNode] : [])
					]);
					const replacement = inJSX(block.parent) ? t.jsxExpressionContainer(call) : call;
					for (const key of Object.keys(root)) delete root[key];
					Object.assign(root, replacement);
				}

				// One key per reusable scope, so its computed survives re-renders.
				const reusable = plan.wraps.filter(wrap => wrap.deps);
				let sites = null;
				if (reusable.length) {
					sites = program.scope.generateUidIdentifier('k');
					program.scope.push({
						id: sites,
						init: t.callExpression(helper('signals', '$sites'), [t.numericLiteral(reusable.length)])
					});
				}
				for (const wrap of plan.wraps) {
					const args = [t.arrowFunctionExpression([], wrap.node)];
					if (wrap.deps) {
						args.push(
							t.arrayExpression(
								wrap.deps.map(dep =>
									t.identifier(dep.binding ? /** @type {string} */ (targets.get(dep.binding)) : dep.name)
								)
							),
							t.memberExpression(
								t.cloneNode(/** @type {any} */ (sites)),
								t.numericLiteral(reusable.indexOf(wrap)),
								true
							)
						);
					}
					const call = t.callExpression(helper('signals', wrap.kind === 'derived' ? '$derive' : '$hole'), args);
					replace(wrap.parent, wrap.key, wrap.node, wrap.kind === 'element' ? t.jsxExpressionContainer(call) : call);
				}

				for (const hoist of plan.hoists) {
					const cache = program.scope.generateUidIdentifier('h');
					program.scope.push({ id: cache, kind: 'var' });
					// `_h || (_h = $static(<jsx />))`: evaluated on first use rather
					// than at module init, which sidesteps TDZ and import cycles for
					// hoisted component references.
					const expression = t.logicalExpression(
						'||',
						t.cloneNode(cache),
						t.assignmentExpression('=', t.cloneNode(cache), t.callExpression(helper('static', '$static'), [hoist.node]))
					);
					replace(
						hoist.parent,
						hoist.key,
						hoist.node,
						inJSX(hoist.parent) ? t.jsxExpressionContainer(expression) : expression
					);
				}

				// Last, so bodies that wraps or hoists replaced are wrapped again.
				for (const { fn, bindings } of plan.snapshots) {
					const declaration = t.variableDeclaration(
						'const',
						bindings.map(binding =>
							t.variableDeclarator(
								t.identifier(binding.name),
								t.memberExpression(t.identifier(/** @type {string} */ (targets.get(binding))), t.identifier('value'))
							)
						)
					);
					if (fn.body.type === 'BlockStatement') fn.body.body.unshift(declaration);
					else fn.body = t.blockStatement([declaration, t.returnStatement(fn.body)]);
				}

				program.scope.crawl();
			}
		}
	};
}
