// AST analysis shared by the Babel and Rolldown plugins. Everything here
// accepts both Babel's AST and ESTree (oxc): the JSX node shapes are shared
// and the literal/property differences are handled explicitly. Keeping the
// analysis in one place is what keeps the two plugins' output equivalent.

/** Event handlers, refs and keys never become signal bindings. `style` is
 * excluded because `@preact/signals` assigns bound values to `dom.style`
 * wholesale, which breaks object styles. */
const UNBINDABLE_PROP = /^(?:on|key$|ref$|children$|style$|dangerouslySetInnerHTML$)/i;

const HOOK_NAME = /^use[A-Z0-9]/;

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
	return (stmt.type === 'ExportNamedDeclaration' ||
		stmt.type === 'ExportDefaultDeclaration') &&
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
 */

/**
 * @param {any} program
 * @returns {ModuleScope}
 */
export function moduleScope(program) {
	/** @type {Map<string, ModuleBinding>} */
	const bindings = new Map();
	const unsafe = new Set();

	for (const raw of program.body) {
		const stmt = declarationOf(raw);
		if (stmt.type === 'ImportDeclaration') {
			if (stmt.importKind === 'type' || stmt.importKind === 'typeof') continue;
			for (const spec of stmt.specifiers) {
				if (spec.importKind === 'type') continue;
				const imported =
					spec.type === 'ImportSpecifier'
						? spec.imported.name ?? spec.imported.value
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
		} else if (
			(stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') &&
			stmt.id
		) {
			bindings.set(stmt.id.name, {
				kind: stmt.type === 'FunctionDeclaration' ? 'function' : 'class'
			});
		}
	}

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
				break;
			case 'UpdateExpression':
				patternNames(node.argument, unsafe);
				break;
		}
		if (isFunction(node)) {
			for (const param of node.params) patternNames(param, unsafe);
		}
		eachChild(node, child => visit(child, false));
	};
	for (const stmt of program.body) visit(declarationOf(stmt), true);

	for (const name of unsafe) bindings.delete(name);
	return { bindings };
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
	if (!asChild) return true;
	return (
		binding.kind === 'const' &&
		!!binding.init &&
		(isStaticValue(binding.init, undefined, true) ||
			isSignalFactory(binding.init, scope))
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

	if (
		node.type === 'UnaryExpression' &&
		(node.operator === '-' || node.operator === '+' || node.operator === '!')
	) {
		return isPrimitiveLiteral(unwrap(node.argument));
	}

	if (asChild) return false;

	if (node.type === 'ArrayExpression') {
		return node.elements.every(el => el && isStaticValue(el, scope));
	}

	if (node.type === 'ObjectExpression') {
		return node.properties.every(
			prop =>
				(prop.type === 'ObjectProperty' ||
					(prop.type === 'Property' && prop.kind === 'init' && !prop.method)) &&
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
	return (
		name.type === 'JSXIdentifier' &&
		(/^[a-z]/.test(name.name) || name.name.includes('-'))
	);
}

/**
 * The identifier a component tag name resolves through (`Foo` for `<Foo>` and
 * `<Foo.Bar>`), or `null` for host and `this.*` tags.
 * @param {any} name
 * @returns {string | null}
 */
export function componentRoot(name) {
	while (name.type === 'JSXMemberExpression') name = name.object;
	return name.type === 'JSXIdentifier' && name.name !== 'this' && !isHostName(name)
		? name.name
		: null;
}

/** @param {any} attr */
function attrName(attr) {
	return attr.name.type === 'JSXNamespacedName'
		? attr.name.namespace.name + ':' + attr.name.name.name
		: attr.name.name;
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
			if (value.type === 'JSXExpressionContainer') {
				if (!isStaticValue(value.expression, opts.scope)) return false;
			} else if (value.type === 'JSXElement' || value.type === 'JSXFragment') {
				if (!isStaticJSX(value, opts)) return false;
			} else if (!isPrimitiveLiteral(value)) {
				return false;
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
				return (
					child.expression.type === 'JSXEmptyExpression' ||
					isStaticValue(child.expression, opts.scope, true)
				);
			case 'JSXElement':
			case 'JSXFragment':
				return isStaticJSX(child, opts);
		}
		return false;
	});
}

/**
 * Call `fn` for every AST node under `node` (inclusive) that executes as part
 * of evaluating it, i.e. without descending into nested functions/classes.
 * Returning `false` from `fn` stops the walk.
 * @param {any} node
 * @param {(node: any) => boolean | void} fn
 * @returns {boolean} `false` if the walk was stopped
 */
function walkEager(node, fn) {
	if (fn(node) === false) return false;
	if (isFunction(node) || node.type === 'ClassBody') return true;
	let ok = true;
	eachChild(node, child => {
		if (ok && walkEager(child, fn) === false) ok = false;
	});
	return ok;
}

/** @param {any} node */
function isValueRead(node) {
	if (
		node.type !== 'MemberExpression' &&
		node.type !== 'OptionalMemberExpression'
	) {
		return false;
	}
	const prop = node.property;
	return node.computed
		? (prop.type === 'StringLiteral' || prop.type === 'Literal') &&
				prop.value === 'value'
		: prop.type === 'Identifier' && prop.name === 'value';
}

/** @param {any} node */
function isHookCall(node) {
	if (
		node.type !== 'CallExpression' &&
		node.type !== 'OptionalCallExpression'
	) {
		return false;
	}
	const callee = unwrap(node.callee);
	const name =
		callee.type === 'Identifier'
			? callee.name
			: (callee.type === 'MemberExpression' ||
						callee.type === 'OptionalMemberExpression') &&
				  !callee.computed
				? callee.property.name
				: '';
	return HOOK_NAME.test(name);
}

/**
 * Whether a JSX expression should be moved into its own reactive scope: it
 * reads `.value` while rendering, and is safe to re-run later outside of the
 * component's render (no writes, no hooks, no await/yield).
 * @param {any} expression
 * @param {(node: any) => boolean} [isReactive] Extra nodes that count as
 * signal reads (state that the hooks transform turns into signals).
 */
export function isSignalHole(expression, isReactive) {
	if (expression.type === 'JSXEmptyExpression') return false;
	let reads = false;
	const safe = walkEager(expression, node => {
		if (
			node.type === 'AssignmentExpression' ||
			node.type === 'UpdateExpression' ||
			node.type === 'AwaitExpression' ||
			node.type === 'YieldExpression' ||
			(node.type === 'UnaryExpression' && node.operator === 'delete') ||
			isHookCall(node)
		) {
			return false;
		}
		if (isValueRead(node) || (isReactive && isReactive(node))) reads = true;
	});
	return safe && reads;
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
 * @param {any} [opening] the opening element, when `parent` is an attribute
 */
export function isBindablePosition(parent, opening) {
	if (parent.type === 'JSXFragment') return true;
	if (parent.type === 'JSXElement') return isHostName(parent.openingElement.name);
	if (parent.type === 'JSXAttribute') {
		return !!opening && isHostName(opening.name) && isBindableAttribute(parent);
	}
	return false;
}

/**
 * @typedef {object} StateReference
 * @property {any} node The Identifier.
 * @property {any} parent
 * @property {string} key Where `node` sits on `parent` (may be an array).
 * @property {boolean} shorthand It is the value of a `{ x }` shorthand
 * property and needs expanding to `{ x: ... }`.
 */

/**
 * @typedef {object} StateHook
 * @property {any} declarator `const [x, setX] = useState(...)`
 * @property {'useState' | 'useReducer'} hook
 * @property {string} name The state binding (`x`).
 * @property {StateReference[]} references
 */

/**
 * Find `useState`/`useReducer` state that only feeds bindable JSX holes and
 * closures, so it can live in a signal without the component re-rendering.
 *
 * A state variable qualifies when it is declared as `const [x, setX] =
 * useState(...)` at the top of a function body, is never written to, and
 * every read that happens while rendering sits inside a JSX expression that
 * becomes a signal hole. Reads in closures (handlers, effects, `.map`
 * callbacks) are fine: they read `.value`, which tracks whatever runs them.
 *
 * @param {any} program
 * @param {ModuleScope} scope
 * @returns {StateHook[]}
 */
export function findStateHooks(program, scope) {
	/** @type {Map<string, 'useState' | 'useReducer'>} */
	const hookLocals = new Map();
	for (const [local, binding] of scope.bindings) {
		if (
			binding.kind === 'import' &&
			HOOK_SOURCES.has(binding.source) &&
			(binding.imported === 'useState' || binding.imported === 'useReducer')
		) {
			hookLocals.set(local, binding.imported);
		}
	}
	if (!hookLocals.size) return [];

	/** @type {StateHook[]} */
	const result = [];
	const visit = (/** @type {any} */ node) => {
		if (isFunction(node) && node.body && node.body.type === 'BlockStatement') {
			result.push(...analyzeFunction(node, hookLocals));
		}
		eachChild(node, visit);
	};
	visit(program);
	return result;
}

/**
 * @param {any} fn
 * @param {Map<string, 'useState' | 'useReducer'>} hookLocals
 * @returns {StateHook[]}
 */
function analyzeFunction(fn, hookLocals) {
	/** @type {Map<string, StateHook & { eager: { node: any, holes: any[] }[], writable: boolean }>} */
	const candidates = new Map();
	for (const stmt of fn.body.body) {
		if (stmt.type !== 'VariableDeclaration') continue;
		for (const decl of stmt.declarations) {
			const init = decl.init && unwrap(decl.init);
			const id = decl.id;
			if (
				!init ||
				init.type !== 'CallExpression' ||
				init.callee.type !== 'Identifier' ||
				!hookLocals.has(init.callee.name) ||
				id.type !== 'ArrayPattern' ||
				id.elements.length < 1 ||
				id.elements.length > 2 ||
				!id.elements.every(el => el && el.type === 'Identifier')
			) {
				continue;
			}
			candidates.set(id.elements[0].name, {
				declarator: decl,
				hook: hookLocals.get(init.callee.name),
				name: id.elements[0].name,
				references: [],
				eager: [],
				writable: false
			});
		}
	}
	if (!candidates.size) return [];

	collectReferences(fn, candidates);

	// Every render-time read must be covered by a hole. A hole only counts if
	// it is one, which may depend on other state qualifying: iterate until
	// nothing else drops out.
	const live = new Set();
	for (const c of candidates.values()) {
		if (!c.writable) for (const ref of c.references) live.add(ref.node);
	}
	const isReactive = (/** @type {any} */ node) => live.has(node);
	const isHole = (/** @type {any} */ container) =>
		isSignalHole(container.expression, isReactive);

	let changed = true;
	while (changed) {
		changed = false;
		for (const c of candidates.values()) {
			if (c.writable) continue;
			if (c.eager.every(read => read.holes.some(isHole))) continue;
			c.writable = true;
			for (const ref of c.references) live.delete(ref.node);
			changed = true;
		}
	}

	return [...candidates.values()]
		.filter(c => !c.writable)
		.map(({ declarator, hook, name, references }) => ({
			declarator,
			hook,
			name,
			references
		}));
}

/**
 * Scope-aware reference collection for the candidate names inside `fn`.
 * Fills each candidate's `references` and, for reads that run during render
 * (not inside a nested function), `eager` with the bindable containers that
 * enclose the read. Writes mark the candidate as unusable (`writable`).
 * @param {any} fn
 * @param {Map<string, any>} candidates
 */
function collectReferences(fn, candidates) {
	/** @param {any} node */
	const declarator = node =>
		[...candidates.values()].some(c => c.declarator === node);

	/**
	 * @param {any} node
	 * @param {any} parent
	 * @param {string} key
	 * @param {Set<string>} shadowed names declared by an inner scope
	 * @param {boolean} eager not inside a nested function
	 * @param {any[]} holes enclosing bindable containers (eager path only)
	 * @param {any} opening the opening element when inside its attributes
	 */
	const walk = (node, parent, key, shadowed, eager, holes, opening) => {
		if (node.type === 'Identifier') {
			if (!isReference(node, parent, key)) return;
			const c = candidates.get(node.name);
			if (!c || shadowed.has(node.name)) return;
			if (isWriteTarget(parent, key)) {
				c.writable = true;
				return;
			}
			c.references.push({
				node,
				parent,
				key,
				shorthand:
					(parent.type === 'ObjectProperty' || parent.type === 'Property') &&
					!!parent.shorthand
			});
			if (eager) c.eager.push({ node, holes });
			return;
		}

		// Type-only syntax never evaluates.
		if (/^TS/.test(node.type) && !/^TS(?:As|Satisfies|NonNull|TypeAssertion|Instantiation)Expression$|^TSParameterProperty$|^TSExportAssignment$/.test(node.type)) {
			return;
		}

		let scope = shadowed;
		const declare = (/** @type {Set<string>} */ names) => {
			for (const name of names) {
				if (candidates.has(name)) {
					if (scope === shadowed) scope = new Set(shadowed);
					scope.add(name);
				}
			}
		};

		if (isFunction(node)) {
			if (node !== fn) {
				eager = false;
				holes = [];
				const names = new Set();
				if (node.type !== 'FunctionDeclaration' && node.id) names.add(node.id.name);
				for (const param of node.params) patternNames(param, names);
				if (node.body && node.body.type === 'BlockStatement') {
					hoistedNames(node.body, names);
				}
				declare(names);
			}
		} else if (node.type === 'ClassBody') {
			eager = false;
			holes = [];
		} else if (node.type === 'ClassExpression' && node.id) {
			declare(new Set([node.id.name]));
		} else if (node.type === 'CatchClause' && node.param) {
			declare(patternNames(node.param, new Set()));
		}

		// Block-scoped declarations apply to the whole block; the component
		// body itself only declares the candidates and their siblings.
		const statements =
			node.type === 'BlockStatement' || node.type === 'StaticBlock'
				? node.body
				: node.type === 'SwitchStatement'
					? node.cases.flatMap((/** @type {any} */ c) => c.consequent)
					: null;
		if (statements && node !== fn.body) {
			const names = new Set();
			for (const stmt of statements) {
				if (stmt.type === 'VariableDeclaration' && stmt.kind !== 'var') {
					for (const decl of stmt.declarations) patternNames(decl.id, names);
				} else if (
					(stmt.type === 'ClassDeclaration' || stmt.type === 'FunctionDeclaration') &&
					stmt.id
				) {
					names.add(stmt.id.name);
				}
			}
			declare(names);
		}
		if (
			(node.type === 'ForStatement' ||
				node.type === 'ForInStatement' ||
				node.type === 'ForOfStatement') &&
			(node.init || node.left) &&
			(node.init || node.left).type === 'VariableDeclaration'
		) {
			const names = new Set();
			for (const decl of (node.init || node.left).declarations) {
				patternNames(decl.id, names);
			}
			declare(names);
		}

		// Destructuring assignment: `({ a: x } = obj)`, `[x] = arr`.
		if (node.type === 'AssignmentExpression' && /Pattern$/.test(node.left.type)) {
			for (const name of patternNames(node.left, new Set())) {
				const c = candidates.get(name);
				if (c && !scope.has(name)) c.writable = true;
			}
		}

		if (node.type === 'JSXExpressionContainer' && eager) {
			if (isBindablePosition(parent, opening)) holes = [...holes, node];
		}
		if (node.type === 'JSXOpeningElement') opening = node;

		eachChild(node, (child, childKey) => {
			// Declarations: walk default values and computed keys, not names.
			if (
				(node.type === 'VariableDeclarator' && childKey === 'id') ||
				(isFunction(node) && childKey === 'params')
			) {
				if (node.type === 'VariableDeclarator' && declarator(node)) return;
				walkPattern(child, (expr, k, p) =>
					walk(expr, p, k, scope, isFunction(node) ? false : eager, isFunction(node) ? [] : holes, null)
				);
				return;
			}
			if (
				(node.type === 'FunctionDeclaration' ||
					node.type === 'FunctionExpression' ||
					node.type === 'ClassDeclaration' ||
					node.type === 'ClassExpression') &&
				childKey === 'id'
			) {
				return;
			}
			if (node.type === 'CatchClause' && childKey === 'param') {
				walkPattern(child, (expr, k, p) => walk(expr, p, k, scope, eager, holes, null));
				return;
			}
			walk(child, node, childKey, scope, eager, holes, node.type === 'JSXOpeningElement' || node.type === 'JSXAttribute' ? opening : null);
		});
	};

	walk(fn, null, '', new Set(), true, [], null);
}

/**
 * Walk the evaluated parts of a binding pattern: default values and computed
 * keys. Names themselves are declarations, not references.
 * @param {any} node
 * @param {(expr: any, key: string, parent: any) => void} fn
 */
function walkPattern(node, fn) {
	if (!node) return;
	switch (node.type) {
		case 'ObjectPattern':
			for (const prop of node.properties) {
				if (prop.type === 'RestElement') {
					walkPattern(prop.argument, fn);
				} else {
					if (prop.computed) fn(prop.key, 'key', prop);
					walkPattern(prop.value, fn);
				}
			}
			break;
		case 'ArrayPattern':
			for (const el of node.elements) walkPattern(el, fn);
			break;
		case 'RestElement':
			walkPattern(node.argument, fn);
			break;
		case 'AssignmentPattern':
			walkPattern(node.left, fn);
			fn(node.right, 'right', node);
			break;
		case 'TSParameterProperty':
			walkPattern(node.parameter, fn);
			break;
		case 'Identifier':
			break;
		default:
			// Assignment targets like `obj.prop` in for-of heads.
			fn(node, 'left', null);
	}
}

/**
 * `var` and function declarations hoisted to a function's scope.
 * @param {any} body
 * @param {Set<string>} names
 */
function hoistedNames(body, names) {
	const visit = (/** @type {any} */ node) => {
		if (node.type === 'VariableDeclaration' && node.kind === 'var') {
			for (const decl of node.declarations) patternNames(decl.id, names);
		} else if (node.type === 'FunctionDeclaration' && node.id) {
			names.add(node.id.name);
		}
		if (isFunction(node) || node.type === 'ClassBody') return;
		eachChild(node, visit);
	};
	eachChild(body, visit);
}

/**
 * Whether an Identifier at `parent[key]` reads a binding (as opposed to a
 * property name, label, or declaration).
 * @param {any} node
 * @param {any} parent
 * @param {string} key
 */
function isReference(node, parent, key) {
	if (!parent) return true;
	switch (parent.type) {
		case 'MemberExpression':
		case 'OptionalMemberExpression':
			return key !== 'property' || parent.computed;
		case 'ObjectProperty':
		case 'Property':
		case 'ClassProperty':
		case 'ClassPrivateProperty':
		case 'ClassMethod':
		case 'ObjectMethod':
		case 'MethodDefinition':
		case 'PropertyDefinition':
		case 'AccessorProperty':
			return key !== 'key' || parent.computed;
		case 'LabeledStatement':
		case 'BreakStatement':
		case 'ContinueStatement':
			return false;
		case 'MetaProperty':
			return false;
		case 'ImportSpecifier':
		case 'ExportSpecifier':
		case 'ImportDefaultSpecifier':
		case 'ImportNamespaceSpecifier':
			return false;
	}
	return true;
}

/** @param {any} parent @param {string} key */
function isWriteTarget(parent, key) {
	return (
		(parent.type === 'AssignmentExpression' && key === 'left') ||
		parent.type === 'UpdateExpression' ||
		((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') &&
			key === 'left') ||
		parent.type === 'ArrayPattern' ||
		parent.type === 'ObjectPattern' ||
		parent.type === 'RestElement' ||
		(parent.type === 'AssignmentPattern' && key === 'left') ||
		(parent.type === 'UnaryExpression' && parent.operator === 'delete')
	);
}
