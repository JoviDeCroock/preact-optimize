import {
	findStateHooks,
	isBindablePosition,
	isSignalHole,
	isStaticJSX,
	moduleScope
} from 'preact-optimize/compiler';

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
 */

/**
 * @param {import('@babel/core').ConfigAPI & { types: typeof import('@babel/core').types }} api
 * @param {Options} options
 * @returns {import('@babel/core').PluginObj}
 */
export default function preactOptimize(api, options = {}) {
	const t = api.types;
	const {
		hoist = true,
		hoistComponents = false,
		signals = true,
		hooks = false,
		runtime = 'preact-optimize'
	} = options;

	return {
		name: 'preact-optimize',
		visitor: {
			Program(program) {
				/** @type {Record<string, import('@babel/core').types.Identifier>} */
				const helpers = {};
				/** Hoisted JSX nodes, so the requeued replacement isn't re-hoisted. */
				const hoisted = new WeakSet();
				const scope = moduleScope(program.node);

				/** @param {'static' | 'signals'} entry @param {string} name */
				const helper = (entry, name) => {
					if (!helpers[name]) {
						const id = program.scope.generateUidIdentifier(name);
						helpers[name] = id;
						program.unshiftContainer(
							'body',
							t.importDeclaration(
								[t.importSpecifier(id, t.identifier(name))],
								t.stringLiteral(`${runtime}/${entry}`)
							)
						);
					}
					return t.cloneNode(helpers[name]);
				};

				if (signals && hooks) {
					const stateHooks = findStateHooks(program.node, scope);
					for (const { declarator, hook, name, references } of stateHooks) {
						const signal = program.scope.generateUid(name);
						declarator.id.elements[0] = t.identifier(signal);
						declarator.init.callee = helper('signals', '$' + hook);
						for (const { node, parent, key, shorthand } of references) {
							const read = t.memberExpression(
								t.identifier(signal),
								t.identifier('value')
							);
							if (shorthand) parent.shorthand = false;
							const slot = parent[key];
							if (Array.isArray(slot)) slot[slot.indexOf(node)] = read;
							else parent[key] = read;
						}
					}
					if (stateHooks.length) program.scope.crawl();
				}

				/** @param {import('@babel/core').NodePath<any>} path */
				const tryHoist = path => {
					if (hoisted.has(path.node)) return path.skip();
					if (!hoist || !path.getFunctionParent()) return;
					if (!isStaticJSX(path.node, { hoistComponents, scope })) return;

					hoisted.add(path.node);
					const cache = program.scope.generateUidIdentifier('h');
					program.scope.push({ id: cache, kind: 'var' });
					// `_h || (_h = $static(<jsx />))`: evaluated on first use rather
					// than at module init, which sidesteps TDZ and import cycles for
					// hoisted component references.
					const expression = t.logicalExpression(
						'||',
						t.cloneNode(cache),
						t.assignmentExpression(
							'=',
							t.cloneNode(cache),
							t.callExpression(helper('static', '$static'), [path.node])
						)
					);
					// JSX children and attribute values need a `{}` container.
					path.replaceWith(
						path.parentPath.isJSXElement() ||
							path.parentPath.isJSXFragment() ||
							path.parentPath.isJSXAttribute()
							? t.jsxExpressionContainer(expression)
							: expression
					);
					path.skip();
				};

				program.traverse({
					JSXElement: tryHoist,
					JSXFragment: tryHoist,
					JSXExpressionContainer(path) {
						if (!signals) return;
						const opening =
							path.parent.type === 'JSXAttribute' ? path.parentPath.parent : null;
						if (
							!isBindablePosition(path.parent, opening) ||
							!isSignalHole(path.node.expression)
						) {
							return;
						}

						path
							.get('expression')
							.replaceWith(
								t.callExpression(helper('signals', '$hole'), [
									t.arrowFunctionExpression([], path.node.expression)
								])
							);
					}
				});
			}
		}
	};
}
