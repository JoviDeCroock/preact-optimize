// AST analysis shared by the Babel and Rolldown plugins. Everything here
// accepts both Babel's AST and ESTree (oxc): the JSX node shapes are shared
// and the literal/property differences are handled explicitly. Keeping the
// analysis in one place is what keeps the two plugins' output equivalent.

/** Event handlers, refs and keys never become signal bindings. `style` is
 * excluded because `@preact/signals` assigns bound values to `dom.style`
 * wholesale, which breaks object styles. */
const UNBINDABLE_PROP = /^(?:on|key$|ref$|children$|style$|dangerouslySetInnerHTML$)/i;

const HOOK_NAME = /^use(?:[A-Z0-9]|$)/;

const FUNCTION_TYPES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ObjectMethod',
	'ClassMethod',
	'ClassPrivateMethod'
]);

const HOOK_SOURCES = new Set(['preact/hooks', 'preact/compat', 'react']);
const SIGNAL_SOURCES = /^@preact\/signals(?:-core|-react)?$/;

/** Keys holding type-only or positional data that never evaluates. */
const SKIP_KEYS = new Set([
	'loc',
	'range',
	'extra',
	'typeAnnotation',
	'returnType',
	'typeParameters',
	'typeArguments',
	'superTypeParameters',
	'superTypeArguments',
	'decorators',
	'leadingComments',
	'trailingComments',
	'innerComments'
]);

/** @param {any} value */
const isNode = value => !!value && typeof value.type === 'string';

/**
 * Visit each child node of `node` along with the key it lives under.
 * @param {any} node
 * @param {(child: any, key: string) => void} fn
 */
function eachChild(node, fn) {
	for (const key in node) {
		if (SKIP_KEYS.has(key)) continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const child of value) if (isNode(child)) fn(child, key);
		} else if (isNode(value)) {
			fn(value, key);
		}
	}
}

/** @param {any} node */
function unwrap(node) {
	while (
		node &&
		(node.type === 'ParenthesizedExpression' ||
			node.type === 'TSAsExpression' ||
			node.type === 'TSSatisfiesExpression' ||
			node.type === 'TSNonNullExpression' ||
			node.type === 'TSTypeAssertion' ||
			node.type === 'TypeCastExpression')
	) {
		node = node.expression;
	}
	return node;
}

/** @param {any} node */
function isPrimitiveLiteral(node) {
	switch (node.type) {
		case 'StringLiteral':
		case 'NumericLiteral':
		case 'BooleanLiteral':
		case 'NullLiteral':
		case 'BigIntLiteral':
			return true;
		// ESTree: regex literals are mutable objects (`lastIndex`), keep them out.
		case 'Literal':
			return !node.regex;
		case 'TemplateLiteral':
			return node.expressions.length === 0;
	}
	return false;
}

/** @param {any} key */
function isPlainKey(key) {
	return (
		key.type === 'Identifier' ||
		key.type === 'StringLiteral' ||
		key.type === 'NumericLiteral' ||
		(key.type === 'Literal' && !key.regex)
	);
}

/** @param {any} node */
function isFunction(node) {
	return FUNCTION_TYPES.has(node.type);
}

/**
 * Collect the names a binding pattern declares.
 * @param {any} node
 * @param {Set<string>} names
 */
export function patternNames(node, names) {
	if (!node) return names;
	switch (node.type) {
		case 'Identifier':
			names.add(node.name);
			break;
		case 'ObjectPattern':
			for (const prop of node.properties) {
				patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, names);
			}
			break;
		case 'ArrayPattern':
			for (const el of node.elements) patternNames(el, names);
			break;
		case 'RestElement':
			patternNames(node.argument, names);
			break;
		case 'AssignmentPattern':
			patternNames(node.left, names);
			break;
		case 'TSParameterProperty':
			patternNames(node.parameter, names);
			break;
	}
	return names;
}

/** @param {any} stmt */
function declarationOf(stmt) {
	return (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') &&
		isNode(stmt.declaration)
		? stmt.declaration
		: stmt;
}

/**
 * @typedef {object} ModuleBinding
 * @property {'import' | 'const' | 'let' | 'function' | 'class'} kind
 * @property {any} [init] Initializer of a `const`/`let` declared by a plain
 * identifier.
 * @property {string} [source] Module an import binding comes from.
 * @property {string} [imported] Exported name an import binding refers to.
 */

/**
 * @typedef {object} ModuleScope
 * @property {Map<string, ModuleBinding>} bindings Module-level bindings that
 * are never reassigned and never shadowed anywhere in the file. Without a
 * full scope analyzer this is deliberately conservative: a name redeclared in
 * any nested scope is left out.
 * @property {Set<string>} written Names assigned or updated anywhere in the
 * file, at any depth.
 * @property {Set<string>} mutated Names whose properties are assigned,
 * updated or deleted anywhere in the file.
 */

/**
 * @param {any} program
 * @returns {ModuleScope}
 */
export function moduleScope(program) {
	/** @type {Map<string, ModuleBinding>} */
	const bindings = new Map();
	const unsafe = new Set();
	/** @type {Set<string>} */
	const written = new Set();
	/** @type {Set<string>} */
	const mutated = new Set();

	for (const raw of program.body) {
		const stmt = declarationOf(raw);
		if (stmt.type === 'ImportDeclaration') {
			if (stmt.importKind === 'type' || stmt.importKind === 'typeof') continue;
			for (const spec of stmt.specifiers) {
				if (spec.importKind === 'type') continue;
				const imported =
					spec.type === 'ImportSpecifier'
						? (spec.imported.name ?? spec.imported.value)
						: spec.type === 'ImportDefaultSpecifier'
							? 'default'
							: '*';
				bindings.set(spec.local.name, {
					kind: 'import',
					source: stmt.source.value,
					imported
				});
			}
		} else if (stmt.type === 'VariableDeclaration') {
			const kind = stmt.kind === 'const' ? 'const' : 'let';
			for (const decl of stmt.declarations) {
				if (decl.id.type === 'Identifier') {
					bindings.set(decl.id.name, { kind, init: decl.init });
				} else {
					for (const name of patternNames(decl.id, new Set())) {
						bindings.set(name, { kind });
					}
				}
			}
		} else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) {
			bindings.set(stmt.id.name, {
				kind: stmt.type === 'FunctionDeclaration' ? 'function' : 'class'
			});
		}
	}

	/**
	 * `o.a.b = x` changes what a later read of `o` sees.
	 * @param {any} node
	 */
	const writeRoot = node => {
		if (!isMemberLike(node)) return;
		while (isMemberLike(node)) node = node.object;
		if (node.type === 'Identifier') mutated.add(node.name);
	};

	/** @param {any} node @param {boolean} isTop */
	const visit = (node, isTop) => {
		switch (node.type) {
			case 'VariableDeclaration':
				if (!isTop) {
					for (const decl of node.declarations) patternNames(decl.id, unsafe);
				}
				break;
			case 'FunctionDeclaration':
			case 'ClassDeclaration':
				if (node.id && !isTop) unsafe.add(node.id.name);
				break;
			case 'FunctionExpression':
			case 'ClassExpression':
				if (node.id) unsafe.add(node.id.name);
				break;
			case 'CatchClause':
				patternNames(node.param, unsafe);
				break;
			case 'AssignmentExpression':
				patternNames(node.left, unsafe);
				patternNames(node.left, written);
				writeRoot(node.left);
				break;
			case 'UpdateExpression':
				patternNames(node.argument, unsafe);
				patternNames(node.argument, written);
				writeRoot(node.argument);
				break;
			case 'UnaryExpression':
				if (node.operator === 'delete') writeRoot(node.argument);
				break;
			case 'ForInStatement':
			case 'ForOfStatement':
				if (node.left.type !== 'VariableDeclaration') {
					patternNames(node.left, unsafe);
					patternNames(node.left, written);
				}
				break;
		}
		if (isFunction(node)) {
			for (const param of node.params) patternNames(param, unsafe);
		}
		eachChild(node, child => visit(child, false));
	};
	for (const stmt of program.body) visit(declarationOf(stmt), true);

	for (const name of unsafe) bindings.delete(name);
	return { bindings, written, mutated };
}

/**
 * Whether `init` creates a signal through `@preact/signals`.
 * @param {any} init
 * @param {ModuleScope} scope
 */
function isSignalFactory(init, scope) {
	init = unwrap(init);
	if (!init || init.type !== 'CallExpression') return false;
	const callee = unwrap(init.callee);
	const binding = callee.type === 'Identifier' && scope.bindings.get(callee.name);
	return (
		!!binding &&
		binding.kind === 'import' &&
		SIGNAL_SOURCES.test(binding.source) &&
		(binding.imported === 'signal' || binding.imported === 'computed')
	);
}

/**
 * Whether a module-level identifier can be read once and cached in a hoisted
 * vnode. Attribute values only need a binding that never changes. Children
 * additionally need a value Preact won't re-read through on the next diff
 * (mutable arrays would be), so only literal and signal constants qualify.
 * @param {string} name
 * @param {ModuleScope} scope
 * @param {boolean} asChild
 */
function isModuleConstant(name, scope, asChild) {
	const binding = scope.bindings.get(name);
	if (!binding || binding.kind === 'let') return false;
	// An attribute bound to a signal can't be hoisted: Preact clones a hoisted
	// vnode, and the clone loses the props @preact/signals bound. Imports and
	// other module values could be signals.
	if (!asChild) {
		const init = binding.kind === 'const' && unwrap(binding.init);
		return (
			binding.kind === 'function' || binding.kind === 'class' || (!!init && (isFunction(init) || isStaticValue(init)))
		);
	}
	return (
		binding.kind === 'const' &&
		!!binding.init &&
		(isStaticValue(binding.init, undefined, true) || isSignalFactory(binding.init, scope))
	);
}

/**
 * A value that evaluates to the same thing every time and holds no closures:
 * literals, plain object/array literals made of them and, given a module
 * scope, module-level constants.
 * @param {any} node
 * @param {ModuleScope} [scope]
 * @param {boolean} [asChild]
 * @returns {boolean}
 */
export function isStaticValue(node, scope, asChild = false) {
	node = unwrap(node);
	if (!node) return false;
	if (isPrimitiveLiteral(node)) return true;

	if (node.type === 'Identifier') {
		return !!scope && isModuleConstant(node.name, scope, asChild);
	}

	if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+' || node.operator === '!')) {
		return isPrimitiveLiteral(unwrap(node.argument));
	}

	if (asChild) return false;

	if (node.type === 'ArrayExpression') {
		return node.elements.every(el => el && isStaticValue(el, scope));
	}

	if (node.type === 'ObjectExpression') {
		return node.properties.every(
			prop =>
				(prop.type === 'ObjectProperty' || (prop.type === 'Property' && prop.kind === 'init' && !prop.method)) &&
				!prop.computed &&
				!prop.shorthand &&
				isPlainKey(prop.key) &&
				isStaticValue(prop.value, scope)
		);
	}

	return false;
}

/**
 * Whether a JSX tag name compiles to a string (host element) rather than a
 * component reference. Mirrors the JSX transforms: lowercase identifiers,
 * dashed names and namespaced names are strings.
 * @param {any} name
 */
export function isHostName(name) {
	if (name.type === 'JSXNamespacedName') return true;
	return name.type === 'JSXIdentifier' && (/^[a-z]/.test(name.name) || name.name.includes('-'));
}

/**
 * The identifier a component tag name resolves through (`Foo` for `<Foo>` and
 * `<Foo.Bar>`), or `null` for host and `this.*` tags.
 * @param {any} name
 * @returns {string | null}
 */
export function componentRoot(name) {
	while (name.type === 'JSXMemberExpression') name = name.object;
	return name.type === 'JSXIdentifier' && name.name !== 'this' && !isHostName(name) ? name.name : null;
}

/** @param {any} attr */
function attrName(attr) {
	return attr.name.type === 'JSXNamespacedName' ? attr.name.namespace.name + ':' + attr.name.name.name : attr.name.name;
}

/**
 * @typedef {object} StaticOptions
 * @property {boolean} hoistComponents Allow component tags in hoisted trees.
 * @property {ModuleScope} scope
 */

/**
 * Whether a JSX element or fragment can be evaluated once and reused across
 * renders: no spreads, no refs, only static attribute values and children.
 * @param {any} node
 * @param {StaticOptions} opts
 * @returns {boolean}
 */
export function isStaticJSX(node, opts) {
	if (node.type === 'JSXElement') {
		const opening = node.openingElement;
		if (!isHostName(opening.name)) {
			const root = componentRoot(opening.name);
			const binding = root && opts.scope.bindings.get(root);
			if (!opts.hoistComponents || !binding || binding.kind === 'let') {
				return false;
			}
		}

		for (const attr of opening.attributes) {
			if (attr.type !== 'JSXAttribute' || attrName(attr) === 'ref') return false;
			const value = attr.value;
			if (!value) continue;
			// Otherwise a string literal.
			if (value.type === 'JSXExpressionContainer') {
				if (!isStaticValue(value.expression, opts.scope)) return false;
			} else if (value.type !== 'StringLiteral' && value.type !== 'Literal') {
				if (!isStaticJSX(value, opts)) return false;
			}
		}
	} else if (node.type !== 'JSXFragment') {
		return false;
	}

	return node.children.every(child => {
		switch (child.type) {
			case 'JSXText':
				return true;
			case 'JSXExpressionContainer':
				return child.expression.type === 'JSXEmptyExpression' || isStaticValue(child.expression, opts.scope, true);
			case 'JSXElement':
			case 'JSXFragment':
				return isStaticJSX(child, opts);
		}
		return false;
	});
}

/**
 * Tags a block never contains: their children or values need Preact's own
 * handling, they switch namespace, or they are custom elements whose props
 * may be properties the template can't carry.
 */
const NON_BLOCK_TAGS = new Set([
	'svg',
	'math',
	'template',
	'select',
	'option',
	'optgroup',
	'textarea',
	'script',
	'style',
	'slot'
]);
/**
 * Lowercase SVG element names. Preact sets no DOM properties on SVG elements,
 * which is how a block's root receives its payload, so a root that could be
 * rendered inside `<svg>` must stay JSX.
 */
const SVG_ROOTS = new Set(
	'a animate circle defs desc discard ellipse filter g image line marker mask metadata mpath path pattern polygon polyline rect set stop switch symbol text title tspan use view'.split(
		' '
	)
);

/**
 * MathML element names. A block's DOM is built in its root's namespace, but
 * Preact switches token elements' (`mi`, `mo`, ...) children back to HTML.
 */
const MATH_ROOTS = new Set(
	'annotation annotation-xml maction menclose merror mfenced mfrac mi mmultiscripts mn mo mover mpadded mphantom mprescripts mroot mrow ms mspace msqrt mstyle msub msubsup msup mtable mtd mtext mtr munder munderover none semantics'.split(
		' '
	)
);

/** @param {any} name */
const isBlockTag = name =>
	name.type === 'JSXIdentifier' && /^[a-z][a-z0-9]*$/.test(name.name) && !NON_BLOCK_TAGS.has(name.name);

/**
 * @typedef {object} BlockShape
 * @property {{ node: any, container: any, name: string | null }[]} slots
 * Dynamic attribute values (`name`) and text children (`name: null`), in
 * source order.
 * @property {any} key The root's `key` value, if any.
 */

/**
 * Whether a JSX element is a host-only tree that can render from a DOM
 * template: no components, fragments, spreads, refs or inner keys, and
 * children that are text. Expressions that look like vnodes (`children`,
 * JSX) rule it out; anything else is checked at runtime, falling back to the
 * plain JSX.
 * @param {any} root
 * @returns {BlockShape | null}
 */
export function blockShape(root) {
	const rootName = root.openingElement.name;
	if (!isBlockTag(rootName) || SVG_ROOTS.has(rootName.name) || MATH_ROOTS.has(rootName.name)) {
		return null;
	}
	/** @type {BlockShape['slots']} */
	const slots = [];
	let key = null;
	let nodes = 0;
	/** @param {any} el @param {boolean} isRoot */
	const element = (el, isRoot) => {
		if (!isBlockTag(el.openingElement.name)) return false;
		const seen = new Set();
		for (const attr of el.openingElement.attributes) {
			if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier') return false;
			const name = attr.name.name;
			const value = attr.value;
			// A repeated attribute overwrites its slot, so leave it to JSX.
			if (seen.has(name)) return false;
			seen.add(name);
			if (name === 'key' && isRoot && value) {
				key = value.type === 'JSXExpressionContainer' ? value.expression : value;
				continue;
			}
			// Content props replace the children the template holds.
			if (/^(?:key|ref|children|dangerouslySetInnerHTML|innerHTML|innerText|textContent|is)$/.test(name)) {
				return false;
			}
			// Literal values stay in the template (the runtime applies the ones
			// a clone can't carry, like `value`, as properties).
			if (value && value.type === 'JSXExpressionContainer') {
				// `a={}` doesn't parse.
				const expression = value.expression;
				if (hasJSX(expression)) return false;
				if (!isPrimitiveLiteral(expression)) slots.push({ node: expression, container: value, name });
			} else if (value && value.type !== 'StringLiteral' && value.type !== 'Literal') {
				return false;
			}
		}
		for (const child of el.children) {
			if (child.type === 'JSXText') {
				if (/\S/.test(child.value)) nodes++;
			} else if (child.type === 'JSXExpressionContainer') {
				const expression = child.expression;
				if (expression.type === 'JSXEmptyExpression') continue;
				if (hasJSX(expression) || looksLikeChildren(expression)) return false;
				nodes++;
				if (!isPrimitiveLiteral(expression)) slots.push({ node: expression, container: child, name: null });
			} else if (child.type === 'JSXElement') {
				nodes++;
				if (!element(child, false)) return false;
			} else {
				return false;
			}
		}
		return true;
	};
	return element(root, true) && nodes >= 2 ? { slots, key } : null;
}

/** `children` and `props.children` are vnodes far more often than text. */
function looksLikeChildren(/** @type {any} */ node) {
	node = unwrap(node);
	return (
		(node.type === 'Identifier' && node.name === 'children') ||
		(isMemberLike(node) && !node.computed && node.property.name === 'children')
	);
}

/** Array methods whose callbacks run synchronously, i.e. during render when
 * called from render. Reads inside them count as render-time reads. */
const SYNC_CALLBACKS = new Set([
	'map',
	'flatMap',
	'filter',
	'reduce',
	'reduceRight',
	'some',
	'every',
	'find',
	'findIndex',
	'findLast',
	'findLastIndex',
	'forEach'
]);

/** @param {any} node */
function isValueRead(node) {
	if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
		return false;
	}
	const prop = node.property;
	return node.computed
		? (prop.type === 'StringLiteral' || prop.type === 'Literal') && prop.value === 'value'
		: prop.type === 'Identifier' && prop.name === 'value';
}

/**
 * `useMemo(fn, [deps])` / `useCallback(fn, [deps])` with a plain callback and
 * a literal dependency list.
 * @param {any} call
 */
function isMemoizable(call) {
	const [fn, deps, extra] = call.arguments;
	return (
		!extra &&
		!!fn &&
		(fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression') &&
		!fn.async &&
		!fn.generator &&
		!!deps &&
		deps.type === 'ArrayExpression' &&
		deps.elements.every((/** @type {any} */ el) => el && el.type !== 'SpreadElement')
	);
}

/** @param {any} node */
function hasValueRead(node) {
	if (isValueRead(node)) return true;
	let found = false;
	eachChild(node, child => {
		found ||= hasValueRead(child);
	});
	return found;
}

/** @param {any} node */
function hasJSX(node) {
	if (node.type === 'JSXElement' || node.type === 'JSXFragment') return true;
	let found = false;
	eachChild(node, child => {
		found ||= hasJSX(child);
	});
	return found;
}

/** @param {any} node */
function isMemberLike(node) {
	return node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression';
}

/** @param {any} node */
function calleeName(node) {
	const callee = unwrap(node.callee);
	if (callee.type === 'Identifier') return callee.name;
	if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && !callee.computed) {
		return callee.property.name;
	}
	return '';
}

/** @param {any} node */
function isCall(node) {
	return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}

/**
 * Whether `fn` is the callback of `list.map(fn)` and friends, which runs
 * synchronously while the surrounding expression evaluates.
 * @param {any} fn
 * @param {any} parent
 */
function isSyncCallback(fn, parent) {
	if (!parent || !isCall(parent) || parent.arguments[0] !== fn) return false;
	const callee = unwrap(parent.callee);
	return (
		(callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') &&
		!callee.computed &&
		SYNC_CALLBACKS.has(callee.property.name)
	);
}

/**
 * Whether evaluating `node` again later, outside of render, is safe: no
 * writes, no hooks, no await/yield. Nested functions are skipped unless they
 * are synchronous array callbacks, which run as part of the evaluation.
 * @param {any} node
 * @param {any} [parent]
 * @returns {boolean}
 */
function isSafe(node, parent) {
	switch (node.type) {
		case 'AssignmentExpression':
		case 'UpdateExpression':
		case 'AwaitExpression':
		case 'YieldExpression':
			return false;
		case 'UnaryExpression':
			if (node.operator === 'delete') return false;
			break;
		case 'ClassBody':
			return true;
	}
	if (isCall(node) && HOOK_NAME.test(calleeName(node))) return false;
	if (isFunction(node) && !isSyncCallback(node, parent)) return true;
	let safe = true;
	eachChild(node, child => {
		if (safe && !isSafe(child, node)) safe = false;
	});
	return safe;
}

/**
 * Whether a JSX attribute on a host element may carry a signal binding.
 * @param {any} attr
 */
export function isBindableAttribute(attr) {
	return !UNBINDABLE_PROP.test(attrName(attr));
}

/**
 * Whether a JSXExpressionContainer sits where a signal can be bound: a child
 * of a host element or fragment, or a bindable host attribute.
 * @param {any} parent the container's parent
 * @param {any} opening the opening element, when `parent` is an attribute
 */
export function isBindablePosition(parent, opening) {
	if (parent.type === 'JSXFragment') return true;
	if (parent.type === 'JSXElement') return isHostName(parent.openingElement.name);
	// The only other container parent is an attribute.
	return isHostName(opening.name) && isBindableAttribute(parent);
}

/** @param {any} element */
function hasKey(element) {
	return element.openingElement.attributes.some(
		(/** @type {any} */ attr) => attr.type === 'JSXAttribute' && attrName(attr) === 'key'
	);
}

/**
 * Whether a function is a component by naming convention: a capitalized
 * function name or a capitalized binding it is assigned to (possibly through
 * a wrapper call such as `memo(...)`).
 * @param {any} fn
 * @param {any[]} ancestors
 */
function isComponent(fn, ancestors) {
	if (fn.id) return /^[A-Z]/.test(fn.id.name);
	// Skip wrapper calls and parentheses; the Program always ends the walk.
	let i = ancestors.length - 1;
	while (isCall(ancestors[i]) || ancestors[i].type === 'ParenthesizedExpression') i--;
	const node = ancestors[i];
	return (
		node.type === 'ExportDefaultDeclaration' ||
		(node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && /^[A-Z]/.test(node.id.name))
	);
}

/**
 * Collect the names a function scope declares up front: parameters, its own
 * name for function expressions, and hoisted `var`/function declarations.
 * @param {any} fn
 */
function functionScopeNames(fn) {
	const names = new Set();
	if (fn.type !== 'FunctionDeclaration' && fn.id) names.add(fn.id.name);
	for (const param of fn.params) patternNames(param, names);
	if (fn.body && fn.body.type === 'BlockStatement') {
		const visit = (/** @type {any} */ node) => {
			if (node.type === 'VariableDeclaration' && node.kind === 'var') {
				for (const decl of node.declarations) patternNames(decl.id, names);
			} else if (node.type === 'FunctionDeclaration') {
				names.add(node.id.name);
			}
			if (!isFunction(node) && node.type !== 'ClassBody') eachChild(node, visit);
		};
		eachChild(fn.body, visit);
	}
	return names;
}

/**
 * Names declared directly in a block by let/const/class/function.
 * @param {any[]} statements
 */
function blockScopeNames(statements) {
	const names = new Set();
	for (const stmt of statements) {
		if (stmt.type === 'VariableDeclaration' && stmt.kind !== 'var') {
			for (const decl of stmt.declarations) patternNames(decl.id, names);
		} else if ((stmt.type === 'ClassDeclaration' || stmt.type === 'FunctionDeclaration') && stmt.id) {
			names.add(stmt.id.name);
		}
	}
	return names;
}

/**
 * Whether an Identifier at `parent[key]` reads a binding (as opposed to a
 * property name, label, or meta property).
 * @param {any} parent
 * @param {string} key
 */
function isReference(parent, key) {
	switch (parent.type) {
		case 'MemberExpression':
		case 'OptionalMemberExpression':
		case 'ObjectProperty':
		case 'Property':
		case 'ObjectMethod':
		case 'ClassProperty':
		case 'ClassPrivateProperty':
		case 'ClassMethod':
		case 'MethodDefinition':
		case 'PropertyDefinition':
		case 'AccessorProperty':
			return key !== (parent.type.endsWith('MemberExpression') ? 'property' : 'key') || parent.computed;
		case 'LabeledStatement':
		case 'BreakStatement':
		case 'ContinueStatement':
		case 'MetaProperty':
		// Babel wraps `#name` in an Identifier; Oxc uses PrivateIdentifier.
		case 'PrivateName':
			return false;
	}
	return true;
}

/**
 * Walk the evaluated parts of a binding or assignment pattern: default
 * values, computed keys, and the objects of member targets.
 * @param {any} node
 * @param {any} parent
 * @param {string} key
 * @param {(expr: any, parent: any, key: string) => void} visitExpression
 */
function walkPattern(node, parent, key, visitExpression) {
	switch (node && node.type) {
		case 'ObjectPattern':
			for (const prop of node.properties) {
				if (prop.type === 'RestElement') {
					walkPattern(prop.argument, prop, 'argument', visitExpression);
				} else {
					if (prop.computed) visitExpression(prop.key, prop, 'key');
					walkPattern(prop.value, prop, 'value', visitExpression);
				}
			}
			break;
		case 'ArrayPattern':
			for (const el of node.elements) walkPattern(el, node, 'elements', visitExpression);
			break;
		case 'RestElement':
			walkPattern(node.argument, node, 'argument', visitExpression);
			break;
		case 'AssignmentPattern':
			walkPattern(node.left, node, 'left', visitExpression);
			visitExpression(node.right, node, 'right');
			break;
		case 'TSParameterProperty':
			walkPattern(node.parameter, node, 'parameter', visitExpression);
			break;
		case 'MemberExpression':
			// `[obj.a] = list` reads `obj`; `[sig.value] = list` only writes.
			if (isValueRead(node)) visitExpression(node.object, node, 'object');
			else visitExpression(node, parent, key);
	}
}

/**
 * @typedef {object} Wrap A node to wrap in `$hole(() => ...)` (or
 * `$derive(() => ...)` for derived constants).
 * @property {'hole' | 'element' | 'return' | 'derived'} kind
 * @property {any} node The expression to wrap.
 * @property {any} parent
 * @property {string} key Where `node` sits on `parent` (may be an array).
 */

/**
 * @typedef {object} Reference A reference to a converted binding.
 * @property {any} node The Identifier.
 * @property {any} parent
 * @property {string} key
 * @property {boolean} shorthand It is the value of a `{ x }` shorthand.
 */

/**
 * @typedef {object} Binding A `useState`/`useReducer` result or a derived
 * constant that becomes a signal/computed.
 * @property {'useState' | 'useReducer' | 'useMemo' | 'derived'} kind
 * @property {string} name
 * @property {any} declarator
 * @property {any} [call] The hook call, without TypeScript wrappers.
 * @property {Reference[]} references
 */

/**
 * @typedef {object} Diagnostic A render-time reactive read that stays in
 * render (and subscribes the component), with the reason it couldn't move.
 * @property {any} node
 * @property {string} reason
 * @property {number} line
 * @property {number} column
 */

/**
 * @typedef {{ binding: Binding } | { node: any }} Source A converted binding,
 * or an expression that evaluates to a signal.
 */

/**
 * @typedef {object} Plan
 * @property {{ node: any, parent: any, key: string }[]} hoists Static JSX.
 * @property {Wrap[]} wraps Reactive scopes, outermost first.
 * @property {Binding[]} bindings Converted state, memos and derived constants.
 * Each is renamed; `references` are the render-time reads, which become
 * `<renamed>.value`.
 * @property {{ fn: any, bindings: Binding[] }[]} snapshots Functions created
 * during render that read converted bindings: each starts with
 * `const name = <renamed>.value` so it sees one value per call, like the
 * render it came from, and its references stay as they are. Bindings are
 * objects from `bindings`, since names repeat across components.
 * @property {{ node: any, keep: any[], call: any, kind: string, sources: Source[] }[]} deps
 * Hook dependency arrays to rewrite to `keep`. Dependencies that are signals
 * now (converted state, or `sig.value`) move to `sources`: effects become
 * `$useEffect(fn, keep, sources)` and memos `$useMemo(fn, keep, sources)`,
 * which re-run when a source changes. Callbacks just drop them.
 * @property {Diagnostic[]} diagnostics Reads left in component renders.
 * @property {Block[]} blocks Host-only JSX rendered from DOM templates.
 * @property {{ name: string, reason: string, line: number, column: number }[]} keptState
 * `useState`/`useReducer` calls left as hooks, with the reason.
 * @property {{ reads: number, moved: number }} stats Render-time reactive
 * reads in components, and how many were moved out of render.
 */

/**
 * @typedef {object} Block A host element compiled to `$block([tpl, ...slots], key)`.
 * @property {any} node
 * @property {any} parent
 * @property {string} key
 * @property {any} keyNode The root's `key` value, if any.
 * @property {{ node: any, container: any, name: string | null, reactive: boolean }[]} slots
 * Reactive slots claimed signal reads and become functions.
 */

/**
 * @typedef {object} AnalyzeOptions
 * @property {boolean} [hoist=true]
 * @property {boolean} [hoistComponents=false]
 * @property {boolean} [signals=true]
 * @property {boolean} [hooks=false]
 * @property {boolean} [blocks=false] Needs `signals`.
 */

/**
 * Work out every transform for a module. The plugins only print this plan.
 *
 * Each render-time reactive read (a `.value` read, or a read of state that is
 * being converted) is claimed by the innermost safe scope around it that can
 * re-run on its own: a bindable JSX expression (`hole`), a JSX element in a
 * child position (`element`), a component's returned JSX (`return`) or a
 * derived constant (`derived`). Scopes that claim nothing are left alone.
 * State and derived constants only convert when every render-time read of
 * them is claimed; dropping one can unclaim others, so this iterates.
 *
 * @param {any} program
 * @param {string} code Source text, for diagnostic positions.
 * @param {AnalyzeOptions} [options]
 * @returns {Plan}
 */
export function analyze(program, code, options = {}) {
	const { hoist = true, hoistComponents = false, signals = true, hooks = false, blocks: useBlocks = false } = options;
	const scope = moduleScope(program);

	/** @type {Map<string, string>} */
	const hookLocals = new Map();
	if (signals && hooks) {
		for (const [local, binding] of scope.bindings) {
			if (
				binding.kind === 'import' &&
				HOOK_SOURCES.has(/** @type {string} */ (binding.source)) &&
				(binding.imported === 'useState' ||
					binding.imported === 'useReducer' ||
					binding.imported === 'useMemo' ||
					binding.imported === 'useCallback' ||
					binding.imported === 'useRef' ||
					binding.imported === 'useEffect' ||
					binding.imported === 'useLayoutEffect')
			) {
				hookLocals.set(local, binding.imported);
			}
		}
	}

	/** @type {Plan['hoists']} */
	const hoists = [];
	/** @type {any[]} */
	const blockList = [];
	/** @type {Map<any, any> | null} slot containers of the block being walked */
	let slotOf = null;
	/** @type {any[]} every candidate reactive scope */
	const scopes = [];
	/** @type {any[]} `.value` reads */
	const valueReads = [];
	/** @type {any[]} state and derived candidates */
	const candidates = [];
	/** @type {Map<any, any>} `useMemo`/`useCallback` dependency arrays */
	const depOwners = new Map();
	/** Bindings that never change: state setters (and `useRef` objects). */
	const STABLE = { stable: true };
	/**
	 * Functions created during render, keyed by function node: whether the
	 * function escapes, and the `const` or declaration holding it, if any.
	 * @type {Map<any, { escapes: boolean, binding: any }>}
	 */
	const closureInfo = new Map();
	/** Component functions whose render reads a ref's `.current`. */
	const readsRef = new Set();
	/** @type {{ owner: any, lexStart: number }[]} memo/callback bodies being walked */
	const ownerStack = [];
	/** @type {Map<any, any>} */
	const ownerOfFn = new Map();

	/** @type {any[]} candidate scopes enclosing the current node */
	let chain = [];
	/** @type {any} the function whose render the current node belongs to */
	let frame = null;
	/** @type {any} the innermost function, sync callbacks included */
	let fnNode = null;
	/** @type {Map<string, any>[]} lexical scopes, innermost last */
	const lexical = [];
	/** @type {any[]} */
	const ancestors = [];

	/**
	 * The hook call whose function argument contains the current node, if
	 * any: such closures can outlive the render they were created in.
	 * @param {any} fn the reading component
	 */
	const hookClosure = fn => {
		let call = null;
		for (let i = ancestors.indexOf(fn) + 1; i < ancestors.length; i++) {
			const node = ancestors[i];
			if (!call && isCall(node) && HOOK_NAME.test(calleeName(node))) call = node;
			else if (call && isFunction(node)) return call;
		}
		return null;
	};

	/**
	 * Record a component local read inside a memo/callback body: dropping a
	 * dependency is only safe when every such capture stays current.
	 * @param {any} node
	 */
	const capture = node => {
		let at = lexical.length - 1;
		while (at >= 0 && !lexical[at].has(node.name)) at--;
		let end = node;
		for (let i = ancestors.length - 1; i >= 0; i--) {
			const a = ancestors[i];
			if (!isMemberLike(a) || a.object !== end || a.computed) break;
			end = a;
		}
		for (const { owner, lexStart } of ownerStack) {
			if (at >= owner.frameLex && at < lexStart) {
				owner.captures.push({
					binding: lexical[at].get(node.name),
					path: code.slice(node.start, end.end)
				});
			}
		}
	};

	/**
	 * The outermost function created by `fn`'s render that contains `node`:
	 * that is where a converted value is snapshotted, so the closure sees
	 * one value per call the way it saw one value per render. `false` when
	 * there is no body to put it in (a class field, a parameter default).
	 * @param {any} fn
	 * @param {any} node
	 */
	const closureOf = (fn, node) => {
		for (let i = ancestors.indexOf(fn) + 1; i < ancestors.length; i++) {
			const f = ancestors[i];
			if (isFunction(f) && !isSyncCallback(f, ancestors[i - 1])) {
				return node.start >= f.body.start && f;
			}
		}
		return false;
	};

	/**
	 * Wrapped code reruns later, so a local declared outside a scope and
	 * written anywhere, or mutated unless it is a ref, could hold a different
	 * value by then: keep that scope's reads in render.
	 * @param {string} name
	 */
	const unwrapIfWritten = name => {
		if (!chain.length || !(scope.written.has(name) || scope.mutated.has(name))) return;
		let at = lexical.length - 1;
		while (at >= 0 && !lexical[at].has(name)) at--;
		if (at < 0 || (!scope.written.has(name) && (lexical[at].get(name) || {}).ref)) return;
		for (const s of chain) if (at < s.lex) s.safe = false;
	};

	/** @param {string} name */
	const resolve = name => {
		for (let i = lexical.length - 1; i >= 0; i--) {
			if (lexical[i].has(name)) return lexical[i].get(name);
		}
		return null;
	};

	/** @param {Set<string>} names @param {Map<string, any>} [bound] */
	const pushScope = (names, bound) => {
		const map = new Map();
		for (const name of names) map.set(name, (bound && bound.get(name)) || null);
		lexical.push(map);
	};

	/**
	 * Keep state as a hook because re-rendering on it does more than its
	 * reads show.
	 * @param {any} c @param {string} reason
	 */
	const block = (c, reason) => {
		c.live = false;
		c.blocked = c.blocked || reason;
	};

	/**
	 * Whether a function created during render is used somewhere it could be
	 * told apart from the one the next render would create. Calls, host
	 * element props and hook arguments (which the hook rules cover) are fine.
	 * So are component props for plain callbacks, which are new on every
	 * render anyway, unless they render (they return JSX, or the prop is a
	 * `render*` prop). A `useCallback` result is only fine in an `on*` or
	 * `ref` prop, since keeping its identity is what it is for. Render
	 * props, dependency lists and subscriptions all see it stop changing
	 * with converted state.
	 * @param {any} node the function, or an identifier that holds one
	 * @param {{ callback: boolean, jsx: boolean }} fn what the function is
	 */
	const escapes = (node, fn) => {
		let child = node;
		let i = ancestors.length - 1;
		for (; i >= 0; i--) {
			const p = ancestors[i];
			if (
				p.type === 'JSXExpressionContainer' ||
				p.type === 'LogicalExpression' ||
				(p.type === 'ConditionalExpression' && p.test !== child) ||
				/^TS(?:As|Satisfies|NonNull)Expression$/.test(p.type)
			) {
				child = p;
			} else break;
		}
		const p = ancestors[i];
		if (isCall(p)) return p.callee !== child && !HOOK_NAME.test(calleeName(p));
		if (p.type === 'JSXAttribute') {
			const name = attrName(p);
			if (isHostName(ancestors[i - 1].name) || /^on[A-Z]/.test(name) || name === 'ref') return false;
			return fn.callback || fn.jsx || /^render(?:[A-Z]|$)/.test(name);
		}
		return true;
	};

	/** Find candidates among a function body's top-level declarations. */
	const findCandidates = (/** @type {any} */ fn) => {
		const bound = new Map();
		if (!signals || !fn.body || fn.body.type !== 'BlockStatement') return bound;
		/** An effect without dependencies runs after every render. */
		let everyRender = false;
		for (const stmt of fn.body.body) {
			const call = stmt.type === 'ExpressionStatement' && unwrap(stmt.expression);
			const effect = call && isCall(call) && call.callee.type === 'Identifier' && hookLocals.get(call.callee.name);
			if ((effect === 'useEffect' || effect === 'useLayoutEffect') && isMemoizable(call)) {
				const owner = {
					call,
					frame: fn,
					frameLex: lexical.length - 1,
					captures: [],
					kind: effect,
					fn: call.arguments[0],
					deps: call.arguments[1],
					uses: new Set(),
					candidate: null
				};
				depOwners.set(owner.deps, owner);
				ownerOfFn.set(owner.fn, owner);
			}
			if ((effect === 'useEffect' || effect === 'useLayoutEffect') && call.arguments.length < 2) {
				everyRender = true;
			}
			if (stmt.type === 'FunctionDeclaration') {
				bound.set(stmt.id.name, { fn: true, callback: false, jsx: hasJSX(stmt), escapes: false });
			}
			if (stmt.type !== 'VariableDeclaration') continue;
			for (const decl of stmt.declarations) {
				const init = decl.init && unwrap(decl.init);
				if (!init) continue;
				const id = decl.id;
				const hook =
					stmt.kind !== 'var' && isCall(init) && init.callee.type === 'Identifier' && hookLocals.get(init.callee.name);
				if (
					(hook === 'useState' || hook === 'useReducer') &&
					id.type === 'ArrayPattern' &&
					id.elements[1] &&
					id.elements[1].type === 'Identifier'
				) {
					bound.set(id.elements[1].name, STABLE);
				}
				if (hook === 'useRef' && id.type === 'Identifier') {
					bound.set(id.name, { stable: true, ref: true, frame: fn });
				} else if (stmt.kind === 'const' && id.type === 'Identifier' && (isFunction(init) || hook === 'useCallback')) {
					bound.set(id.name, {
						fn: true,
						callback: hook === 'useCallback',
						jsx: hasJSX(init),
						escapes: false
					});
				}
				if (hook === 'useRef') {
					// Stable, handled above.
				} else if (
					(hook === 'useState' || hook === 'useReducer') &&
					id.type === 'ArrayPattern' &&
					id.elements.length >= 1 &&
					id.elements.length <= 2 &&
					id.elements.every((/** @type {any} */ el) => el && el.type === 'Identifier')
				) {
					const c = {
						kind: hook,
						name: id.elements[0].name,
						declarator: decl,
						call: init,
						frame: fn,
						refs: [],
						writable: false,
						live: true
					};
					candidates.push(c);
					bound.set(c.name, c);
				} else if ((hook === 'useMemo' || hook === 'useCallback') && id.type === 'Identifier' && isMemoizable(init)) {
					const owner = {
						call: init,
						frame: fn,
						frameLex: lexical.length - 1,
						captures: [],
						kind: hook,
						fn: init.arguments[0],
						deps: init.arguments[1],
						uses: new Set(),
						candidate: null
					};
					depOwners.set(owner.deps, owner);
					ownerOfFn.set(owner.fn, owner);
					// A memo whose callback reads `.value` would start tracking it.
					if (hook === 'useMemo' && !hasValueRead(owner.fn)) {
						const c = {
							kind: hook,
							name: id.name,
							declarator: decl,
							call: init,
							frame: fn,
							refs: [],
							writable: false,
							live: true,
							owner
						};
						owner.candidate = c;
						candidates.push(c);
						bound.set(c.name, c);
					}
				} else if (
					stmt.kind !== 'var' &&
					id.type === 'Identifier' &&
					!isFunction(init) &&
					init.type !== 'ClassExpression'
				) {
					const c = {
						kind: 'derived',
						name: id.name,
						declarator: decl,
						frame: fn,
						refs: [],
						writable: false,
						live: true,
						scope: null
					};
					candidates.push(c);
					bound.set(c.name, c);
				}
			}
		}
		// Skipping the render would skip that effect.
		if (everyRender) {
			for (const c of bound.values()) {
				if (c.kind === 'useState' || c.kind === 'useReducer') block(c, 'effect-every-render');
			}
		}
		return bound;
	};

	/**
	 * @param {any} node
	 * @param {any} parent
	 * @param {string} key
	 * @param {any} opening JSX opening element when inside its attributes
	 * @param {number} depth function nesting depth (for hoisting)
	 */
	const visit = (node, parent, key, opening, depth) => {
		// Type-only syntax never evaluates.
		if (
			node.type.startsWith('TS') &&
			!/^TS(?:As|Satisfies|NonNull|TypeAssertion|Instantiation)Expression$/.test(node.type)
		) {
			return;
		}

		if (node.type === 'JSXIdentifier') {
			// `<Comp />` and `<ns.Comp />` read a binding as the element type,
			// which can't go through `.value`. Attribute names and lowercase
			// tags are not references.
			const isType =
				(parent.type === 'JSXMemberExpression' && key === 'object') ||
				((parent.type === 'JSXOpeningElement' || parent.type === 'JSXClosingElement') && !isHostName(node));
			if (isType) unwrapIfWritten(node.name);
			const c = isType && resolve(node.name);
			if (c) c.writable = true;
			return;
		}

		if (node.type === 'Identifier') {
			if (!parent || !isReference(parent, key)) return;
			if (ownerStack.length) capture(node);
			unwrapIfWritten(node.name);
			const c = resolve(node.name);
			if (!c) return;
			if (c.fn) {
				if (escapes(node, c)) c.escapes = true;
				return;
			}
			if (c.ref) {
				const member = ancestors[ancestors.length - 2];
				if (
					frame === c.frame &&
					isMemberLike(parent) &&
					parent.object === node &&
					!parent.computed &&
					parent.property.name === 'current' &&
					!(member.type === 'AssignmentExpression' && member.left === parent && member.operator === '=')
				) {
					readsRef.add(c.frame);
				}
				return;
			}
			if (c === STABLE) return;
			if (
				(parent.type === 'AssignmentExpression' && key === 'left') ||
				parent.type === 'UpdateExpression' ||
				((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && key === 'left') ||
				(parent.type === 'UnaryExpression' && parent.operator === 'delete')
			) {
				c.writable = true;
				return;
			}
			c.refs.push({
				node,
				parent,
				key,
				shorthand: (parent.type === 'ObjectProperty' || parent.type === 'Property') && !!parent.shorthand,
				eager: frame === c.frame,
				dep: (parent.type === 'ArrayExpression' && depOwners.get(parent)) || null,
				hookClosure: hookClosure(c.frame),
				closure: frame === c.frame ? null : closureOf(c.frame, node),
				chain,
				ancestors: ancestors.slice()
			});
			return;
		}

		if (
			hoist &&
			depth > 0 &&
			!slotOf &&
			(node.type === 'JSXElement' || node.type === 'JSXFragment') &&
			isStaticJSX(node, { hoistComponents, scope })
		) {
			hoists.push({ node, parent, key });
			return;
		}

		if (useBlocks && signals && frame && !slotOf && node.type === 'JSXElement') {
			const shape = blockShape(node);
			if (shape) {
				const b = {
					node,
					parent,
					key,
					keyNode: shape.key,
					slots: shape.slots.map(s => ({ ...s, scope: null }))
				};
				blockList.push(b);
				slotOf = new Map(b.slots.map(s => [s.container, s]));
				visit(node, parent, key, opening, depth);
				slotOf = null;
				return;
			}
		}

		const savedChain = chain;
		const savedFrame = frame;
		const savedFn = fnNode;
		let scopes_ = 0;

		if (
			isValueRead(node) &&
			!(parent.type === 'AssignmentExpression' && key === 'left') &&
			parent.type !== 'UpdateExpression'
		) {
			let root = node.object;
			while (isMemberLike(root) && !root.computed) root = root.object;
			const bound = root.type === 'Identifier' && resolve(root.name);
			valueReads.push({
				node,
				frame,
				chain,
				ancestors: ancestors.slice(),
				// `[sig.value]` in a memo/effect dependency list can become a
				// tracked source when `sig` is a plain path.
				dep:
					parent.type === 'ArrayExpression' &&
					root.type === 'Identifier' &&
					(!bound || !!bound.stable) &&
					depOwners.get(parent)
			});
		}

		/** @param {any} s */
		const enter = s => {
			s.safe = isSafe(s.node, s.parent);
			s.lex = lexical.length;
			s.claims = 0;
			scopes.push(s);
			chain = [...chain, s];
		};

		const owner = isFunction(node) && ownerOfFn.get(node);
		if (owner) ownerStack.push({ owner, lexStart: lexical.length });

		if (isFunction(node)) {
			fnNode = node;
			depth++;
			if (!isSyncCallback(node, parent)) {
				if (frame) {
					const call = isCall(parent) && parent;
					const holder =
						node.type === 'FunctionDeclaration'
							? node.id
							: parent.type === 'VariableDeclarator'
								? parent.id
								: call &&
									  calleeName(call) === 'useCallback' &&
									  ancestors[ancestors.length - 2].type === 'VariableDeclarator'
									? ancestors[ancestors.length - 2].id
									: null;
					const binding = holder && holder.type === 'Identifier' && resolve(holder.name);
					closureInfo.set(node, {
						escapes: !(binding && binding.fn) && escapes(node, { callback: false, jsx: hasJSX(node) }),
						binding: binding && binding.fn ? binding : null
					});
				}
				frame = node;
				chain = [];
			}
			pushScope(functionScopeNames(node));
			scopes_++;
			if (frame === node) node._isComponent = isComponent(node, ancestors);
			if (
				signals &&
				node.type === 'ArrowFunctionExpression' &&
				node.body.type !== 'BlockStatement' &&
				frame === node &&
				node._isComponent
			) {
				// Visit params in the function scope, then the expression body as
				// a returned value.
				ancestors.push(node);
				for (const param of node.params) {
					walkPattern(param, node, 'params', (expr, p, k) => visit(expr, p, k, null, depth));
				}
				enter({ kind: 'return', node: node.body, parent: node, key: 'body' });
				visit(node.body, node, 'body', null, depth);
				ancestors.pop();
				lexical.length -= scopes_;
				chain = savedChain;
				frame = savedFrame;
				fnNode = savedFn;
				if (owner) ownerStack.pop();
				delete node._isComponent;
				return;
			}
		} else if (node.type === 'ClassBody') {
			frame = node;
			chain = [];
		} else if (node.type === 'ClassExpression' && node.id) {
			pushScope(new Set([node.id.name]));
			scopes_++;
		} else if (node.type === 'CatchClause' && node.param) {
			pushScope(patternNames(node.param, new Set()));
			scopes_++;
		} else if (
			(node.type === 'ForStatement' && node.init && node.init.type === 'VariableDeclaration') ||
			((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left.type === 'VariableDeclaration')
		) {
			const decl = node.init || node.left;
			const names = new Set();
			for (const d of decl.declarations) patternNames(d.id, names);
			pushScope(names);
			scopes_++;
		} else if (node.type === 'BlockStatement' || node.type === 'StaticBlock' || node.type === 'SwitchStatement') {
			const statements =
				node.type === 'SwitchStatement' ? node.cases.flatMap((/** @type {any} */ c) => c.consequent) : node.body;
			const isBody = isFunction(parent) && key === 'body';
			pushScope(blockScopeNames(statements), isBody ? findCandidates(parent) : undefined);
			scopes_++;
		}

		const slot = slotOf && slotOf.get(node);
		if (slot && node.type === 'JSXExpressionContainer') {
			// Inside a block only slots re-run on their own.
			enter((slot.scope = { kind: 'slot', node: node.expression, parent: node, key: 'expression' }));
		} else if (signals && frame && !slotOf) {
			if (
				node.type === 'JSXExpressionContainer' &&
				node.expression.type !== 'JSXEmptyExpression' &&
				isBindablePosition(parent, opening)
			) {
				enter({
					kind: 'hole',
					node: node.expression,
					parent: node,
					key: 'expression',
					text: parent.type !== 'JSXAttribute'
				});
			} else if (
				node.type === 'JSXElement' &&
				key === 'children' &&
				(parent.type === 'JSXFragment' || (parent.type === 'JSXElement' && isHostName(parent.openingElement.name))) &&
				!hasKey(node)
			) {
				enter({ kind: 'element', node, parent, key });
			} else if (node.type === 'ReturnStatement' && node.argument && fnNode === frame && frame._isComponent) {
				enter({ kind: 'return', node: node.argument, parent: node, key: 'argument' });
			} else if (node.type === 'VariableDeclarator' && node.init) {
				const c = node.id.type === 'Identifier' && resolve(node.id.name);
				if (c && c.kind === 'derived' && c.declarator === node) {
					c.scope = { kind: 'derived', node: node.init, parent: node, key: 'init', candidate: c };
				}
			}
		}

		ancestors.push(node);
		if (node.type === 'JSXOpeningElement') opening = node;

		if (node.type === 'VariableDeclarator') {
			walkPattern(node.id, node, 'id', (expr, p, k) => visit(expr, p, k, null, depth));
			const c = node.id.type === 'Identifier' && resolve(node.id.name);
			if (node.init) {
				if (c && c.kind === 'derived' && c.declarator === node) {
					const saved = chain;
					enter(c.scope);
					visit(node.init, node, 'init', null, depth);
					chain = saved;
				} else {
					visit(node.init, node, 'init', null, depth);
				}
			}
		} else if (node.type === 'AssignmentExpression' && node.left.type.endsWith('Pattern')) {
			for (const name of patternNames(node.left, new Set())) {
				const c = resolve(name);
				if (c) c.writable = true;
			}
			walkPattern(node.left, node, 'left', (expr, p, k) => visit(expr, p, k, null, depth));
			visit(node.right, node, 'right', null, depth);
		} else {
			eachChild(node, (child, childKey) => {
				if (isFunction(node) && childKey === 'params') {
					walkPattern(child, node, 'params', (expr, p, k) => visit(expr, p, k, null, depth));
				} else if (
					childKey === 'id' &&
					(isFunction(node) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression')
				) {
					// Declaration names are not reads.
				} else if (node.type === 'CatchClause' && childKey === 'param') {
					walkPattern(child, node, 'param', (expr, p, k) => visit(expr, p, k, null, depth));
				} else {
					visit(
						child,
						node,
						childKey,
						node.type === 'JSXOpeningElement' || node.type === 'JSXAttribute' ? opening : null,
						depth
					);
				}
			});
		}

		ancestors.pop();
		lexical.length -= scopes_;
		chain = savedChain;
		frame = savedFrame;
		fnNode = savedFn;
		if (owner) ownerStack.pop();
		if (isFunction(node)) delete node._isComponent;
	};

	visit(program, null, '', null, 0);

	// Claim reads with the innermost safe scope; drop candidates with an
	// unclaimed render-time read; repeat until stable.
	/** @param {any[]} c */
	const innermostSafe = c => {
		for (let i = c.length - 1; i >= 0; i--) {
			const s = c[i];
			if (s.safe && (s.kind !== 'derived' || s.candidate.live)) return s;
		}
		return null;
	};

	// Which candidates each memo/callback body references.
	for (const c of candidates) {
		for (const ref of c.refs) {
			for (const owner of depOwners.values()) {
				if (c.frame === owner.frame && ref.ancestors.includes(owner.fn)) owner.uses.add(c);
			}
		}
	}
	/**
	 * A converted dependency can leave the array when the callback reads it:
	 * the memo tracks it as a signal, and a callback reads `.value` when
	 * called.
	 * @param {any} ref @param {any} c
	 */
	/**
	 * Effects and converted memos can track dropped dependencies as signal
	 * sources. Effects re-run the latest render's callback, which is always
	 * fresh; a memo recomputes with the closure it was created with.
	 * @param {any} owner
	 */
	const tracks = owner =>
		owner.kind === 'useEffect' ||
		owner.kind === 'useLayoutEffect' ||
		(owner.kind === 'useMemo' && !!owner.candidate && owner.candidate.live && isFresh(owner));
	const droppable = (/** @type {any} */ ref, /** @type {any} */ c) => {
		const owner = ref.dep;
		if (!owner) return false;
		// Effects follow the latest render's signals, so recreated memos and
		// derived constants work too.
		if (owner.kind === 'useEffect' || owner.kind === 'useLayoutEffect') return true;
		// A memo or callback keeps its first closure: only state signals live
		// as long as the component.
		if (c.kind !== 'useState' && c.kind !== 'useReducer') return false;
		return (
			tracks(owner) ||
			// A callback reads the signal when called, so it only drops
			// dependencies it reads, and gives up recreating on them.
			(owner.kind === 'useCallback' && owner.uses.has(c) && isFresh(owner))
		);
	};
	/**
	 * Without the dropped dependencies the body is no longer recreated when
	 * they change, so everything else it captures must be current anyway:
	 * stable, converted state, or listed.
	 * @param {any} owner
	 */
	const isFresh = owner => {
		const listed = owner.deps.elements.map((/** @type {any} */ el) =>
			code.slice(el.start, isValueRead(el) ? el.object.end : el.end)
		);
		return owner.captures.every(
			(/** @type {any} */ { binding, path }) =>
				(binding && binding.stable) ||
				(binding && binding.live && (binding.kind === 'useState' || binding.kind === 'useReducer')) ||
				listed.some((/** @type {string} */ dep) => path === dep || path.startsWith(dep + '.'))
		);
	};
	/** @type {Map<any, any>} */
	const ownerOfCall = new Map();
	for (const owner of depOwners.values()) ownerOfCall.set(owner.call, owner);
	/**
	 * A closure handed to a hook can run after later renders. Converted, it
	 * would read the latest value where the original read its own render's,
	 * unless it is recreated whenever that value changes: a memo callback
	 * (run during render, or tracked when converted) or a callback listing it.
	 * @param {any} ref @param {any} c
	 */
	const escaping = (/** @type {any} */ ref) => {
		const info = ref.closure && closureInfo.get(ref.closure);
		return !!info && (info.escapes || (!!info.binding && info.binding.escapes));
	};
	const closureOk = (ref, c) => {
		if (ref.closure === false || escaping(ref)) return false;
		if (!ref.hookClosure) return true;
		const owner = ownerOfCall.get(ref.hookClosure);
		// An effect with dependencies runs the latest render's callback; a
		// memo callback runs during render or as a tracked computed; a
		// callback is kept, so it has to be recreated on the value.
		return !!owner && (owner.kind !== 'useCallback' || c.refs.some((/** @type {any} */ r) => r.dep === owner));
	};

	for (const c of candidates) {
		if (c.kind !== 'useState' && c.kind !== 'useReducer') continue;
		// State nobody reads exists to re-render: `setTick(t => t + 1)`.
		if (!c.refs.length) block(c, 'unread');
		// A render that reads a ref picks up whatever was written to it since,
		// which only works while every update re-renders.
		if (readsRef.has(c.frame)) block(c, 'render-reads-ref');
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const s of scopes) s.claims = 0;
		const claim = (/** @type {any} */ read) => {
			const s = innermostSafe(read.chain);
			if (s) s.claims++;
			return s;
		};
		for (const read of valueReads) {
			read.claimedBy = read.dep && tracks(read.dep) ? read.dep : claim(read);
		}
		for (const derived of [false, true]) {
			for (const c of candidates) {
				if (!c.live || (c.kind === 'derived') !== derived) continue;
				for (const ref of c.refs) {
					ref.claimedBy = !ref.eager ? null : droppable(ref, c) ? ref.dep : claim(ref);
				}
			}
		}
		for (const c of candidates) {
			if (!c.live) continue;
			const ok =
				!c.writable &&
				c.refs.every((/** @type {any} */ ref) => closureOk(ref, c)) &&
				c.refs.every((/** @type {any} */ ref) => !ref.eager || ref.claimedBy) &&
				(c.kind !== 'derived' || (!!c.scope && c.scope.safe && c.scope.claims > 0)) &&
				// Like React, a memo only follows what its dependencies list.
				(c.kind !== 'useMemo' ||
					[...c.owner.uses].every(
						(/** @type {any} */ used) => !used.live || used.refs.some((/** @type {any} */ ref) => ref.dep === c.owner)
					));
			if (!ok) {
				c.live = false;
				changed = true;
			}
		}
	}

	const lineStarts = [0];
	for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
	/** @param {number} offset */
	const position = offset => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return { line: lo + 1, column: offset - lineStarts[lo] };
	};

	/** @type {Diagnostic[]} */
	const diagnostics = [];
	let reads = 0;
	let moved = 0;
	// State reads count whether or not the state converted; memo and derived
	// reads only count once converted (their sources are counted already).
	const renderReads = [
		...valueReads,
		...candidates
			.filter(c => c.live || c.kind === 'useState' || c.kind === 'useReducer')
			.flatMap(c =>
				c.refs
					.filter((/** @type {any} */ ref) => ref.eager)
					.map((/** @type {any} */ ref) => ({ ...ref, frame: c.frame, quiet: !c.live }))
			)
	];
	for (const read of renderReads) {
		if (!read.frame || read.frame.type === 'ClassBody') continue;
		if (!isComponentFrame(read.frame, read.ancestors)) continue;
		reads++;
		if (read.claimedBy && !read.quiet) {
			moved++;
		} else if (!read.quiet) {
			diagnostics.push({
				node: read.node,
				reason: reasonFor(read),
				...position(read.node.start)
			});
		}
	}

	const keptState = [];
	for (const c of candidates) {
		if (c.live || c.kind === 'derived' || c.kind === 'useMemo') continue;
		const ref = c.refs.find((/** @type {any} */ r) => r.eager && !r.claimedBy);
		const closure = c.refs.find((/** @type {any} */ r) => !closureOk(r, c));
		keptState.push({
			name: c.name,
			reason: c.writable
				? 'reassigned'
				: c.blocked
					? c.blocked
					: ref
						? reasonFor(ref)
						: closure
							? closure.closure === false
								? 'outside-function-body'
								: escaping(closure)
									? 'escaping-closure'
									: 'hook-closure'
							: 'unclaimed',
			...position((ref || closure || { node: c.declarator }).node.start)
		});
	}

	const wraps = scopes
		.filter(s => s.claims > 0 && s.kind !== 'slot' && (s.kind !== 'derived' || s.candidate.live))
		// Scopes are entered in pre-order, so this is outermost first.
		.map(s => ({
			kind: s.kind,
			node: s.node,
			parent: s.parent,
			key: s.key,
			text: (s.kind === 'return' || !!s.text) && !s.node.type.startsWith('JSX')
		}));

	/** @type {Map<any, Binding>} */
	const bindings = new Map();
	for (const c of candidates) {
		if (!c.live) continue;
		bindings.set(c, {
			kind: c.kind,
			name: c.name,
			declarator: c.declarator,
			call: c.call,
			references: c.refs
				.filter((/** @type {any} */ r) => r.eager && (!r.dep || r.claimedBy !== r.dep))
				.map((/** @type {any} */ r) => ({
					node: r.node,
					parent: r.parent,
					key: r.key,
					shorthand: r.shorthand
				}))
		});
	}

	/** @type {Map<any, Set<Binding>>} closures and the converted bindings they read */
	const snapshots = new Map();
	for (const [c, binding] of bindings) {
		for (const ref of c.refs) {
			if (!ref.closure) continue;
			let read = snapshots.get(ref.closure);
			if (!read) snapshots.set(ref.closure, (read = new Set()));
			read.add(binding);
		}
	}

	/** @type {Plan['deps']} */
	const deps = [];
	for (const owner of depOwners.values()) {
		if (owner.candidate && !owner.candidate.live) continue;
		/** @type {Source[]} */
		const sources = [];
		/** @type {any[]} */
		const keep = [];
		for (const el of owner.deps.elements) {
			const c = candidates.find(
				c => c.live && c.refs.some((/** @type {any} */ r) => r.node === el && r.claimedBy === owner)
			);
			const read = !c && valueReads.find(read => read.node === el && read.claimedBy === owner);
			if (c) {
				sources.push({ binding: /** @type {Binding} */ (bindings.get(c)) });
			} else if (read) {
				sources.push({ node: el.object });
				// A memo keeps the signal itself listed, so a different signal
				// recreates it; effects follow the latest signals anyway.
				if (owner.kind === 'useMemo') keep.push(el.object);
			} else {
				keep.push(el);
			}
		}
		if (sources.length) {
			deps.push({
				node: owner.deps,
				keep,
				call: owner.call,
				kind: owner.kind,
				sources
			});
		}
	}

	return {
		hoists,
		blocks: blockList.map(({ node, parent, key, keyNode, slots }) => ({
			node,
			parent,
			key,
			keyNode,
			slots: slots.map((/** @type {any} */ s) => ({
				node: s.node,
				container: s.container,
				name: s.name,
				reactive: !!s.scope && s.scope.claims > 0
			}))
		})),
		wraps,
		bindings: [...bindings.values()],
		deps,
		snapshots: [...snapshots].map(([fn, read]) => ({ fn, bindings: [...read] })),
		diagnostics,
		keptState,
		stats: { reads, moved }
	};
}

/**
 * Diagnostics only cover component renders, which is what subscribing
 * re-renders. Frames are functions; `_isComponent` is gone after the walk,
 * so recompute from the recorded ancestors.
 * @param {any} fn
 * @param {any[]} ancestors
 */
function isComponentFrame(fn, ancestors) {
	return isComponent(fn, ancestors.slice(0, ancestors.indexOf(fn)));
}

/**
 * Explain why a render-time read stayed in render.
 * @param {any} read
 */
function reasonFor(read) {
	const ancestors = read.ancestors;
	const inFrame = ancestors.slice(ancestors.indexOf(read.frame) + 1);
	if (inFrame.some(node => isCall(node) && HOOK_NAME.test(calleeName(node)))) {
		return 'hook-argument';
	}
	if (read.chain.some((/** @type {any} */ s) => !s.safe)) return 'unsafe-expression';
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const node = ancestors[i];
		if (node === read.frame) break;
		if (node.type === 'JSXAttribute') {
			const name = attrName(node);
			if (name === 'key') return 'key';
			if (name === 'ref') return 'ref';
			if (/^on/i.test(name)) return 'event-handler';
		}
		if (node.type === 'JSXElement' && hasKey(node)) return 'keyed-element';
		if (node.type === 'JSXSpreadChild') return 'spread-child';
		if (node.type === 'VariableDeclarator') return 'local-binding';
		if (node.type === 'ReturnStatement') return 'returned-value';
		if (
			node.type === 'IfStatement' ||
			node.type === 'SwitchStatement' ||
			node.type === 'ForStatement' ||
			node.type === 'ForInStatement' ||
			node.type === 'ForOfStatement' ||
			node.type === 'WhileStatement' ||
			node.type === 'DoWhileStatement'
		) {
			return 'control-flow';
		}
		if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
			return 'jsx-position';
		}
	}
	return 'statement';
}
