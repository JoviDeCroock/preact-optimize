// Unit tests for the shared analysis. Every snippet is analyzed from both a
// Babel AST and an Oxc (ESTree) AST: the two plans must be identical, and
// each case pins down what gets hoisted, wrapped, converted or reported.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseSync } from '@babel/core';
import { parseAst } from 'rolldown/parseAst';
import { analyze, isStaticValue, moduleScope, patternNames } from '../packages/runtime/src/compiler.js';

const PARSERS = {
	babel: (code, ts) =>
		parseSync(code, {
			filename: ts ? 'x.tsx' : 'x.jsx',
			babelrc: false,
			configFile: false,
			parserOpts: { plugins: ts ? ['jsx', 'typescript'] : ['jsx'] }
		}).program,
	oxc: (code, ts) => parseAst(code, { lang: ts ? 'tsx' : 'jsx' })
};

/** Summarize a plan as source text so ASTs from both parsers compare. */
function summarize(plan, code) {
	const text = node => code.slice(node.start, node.end).replace(/\s+/g, ' ');
	return {
		hoists: plan.hoists.map(h => text(h.node)),
		wraps: plan.wraps.map(w => `${w.kind}: ${text(w.node)}`),
		bindings: plan.bindings.map(
			b => `${b.kind} ${b.name} (${b.references.map(r => text(r.node) + (r.shorthand ? '*' : '')).join(', ')})`
		),
		deps: plan.deps.map(
			d =>
				`${d.kind} [${d.keep.map(text).join(', ')}] <- ${d.sources
					.map(s => ('binding' in s ? s.binding.name : text(s.node)))
					.join(', ')}`
		),
		diagnostics: plan.diagnostics.map(d => `${d.reason} ${text(d.node)} @${d.line}:${d.column}`),
		keptState: plan.keptState.map(k => `${k.name}: ${k.reason}`),
		stats: plan.stats
	};
}

/**
 * Analyze with both parsers, check they agree, and return the summary.
 * @param {string} code
 * @param {object} [options]
 * @param {boolean} [ts]
 */
function plan(code, options = {}, ts = false) {
	const out = {};
	for (const [name, parse] of Object.entries(PARSERS)) {
		out[name] = summarize(analyze(parse(code, ts), code, options), code);
	}
	assert.deepEqual(out.oxc, out.babel, 'parsers disagree');
	return out.babel;
}

const SIGNALS = `import { signal, computed } from '@preact/signals';
const s = signal(0);
`;
const HOOKS = { hooks: true };

describe('hoisting', () => {
	test('literal kinds', () => {
		const { hoists } = plan(`function App() {
			return <div>
				<p a={1} b={-1} c={'s'} d={null} e={true} f={10n} g={\`t\`} h={!0} />
				<p r={/x/} />
				<p t={\`a\${x}\`} />
				<p o={{ a: 1, 'b': 2, 3: [4, 'five'] }} />
				<p o={{ [k]: 1 }} />
				<p o={{ a }} />
				<p o={{ m() {} }} />
				<p o={{ get x() { return 1; } }} />
				<p o={[1, , 2]} />
				<p o={[1, ...x]} />
				<p o={typeof x} />
				<p {...x} />
				<p ref={x} />
				<p a="x" b>text<b>{/* empty */}</b></p>
				<p>{[1]}</p>
				<p a=<b /> />
				<p a=<b c={x} /> />
			</div>;
		}`);
		assert.deepEqual(hoists, [
			`<p a={1} b={-1} c={'s'} d={null} e={true} f={10n} g={\`t\`} h={!0} />`,
			`<p o={{ a: 1, 'b': 2, 3: [4, 'five'] }} />`,
			`<p a="x" b>text<b>{/* empty */}</b></p>`,
			`<p a=<b /> />`
		]);
	});

	test('module constants', () => {
		const { hoists } = plan(`${SIGNALS}import def, * as ns from 'x';
			import { 'quoted name' as q } from 'y';
			const N = 1, LIST = ['a'], OBJ = { a: 1 };
			let L = 1;
			var V = 2;
			const { D } = x;
			const C2 = computed(() => 1);
			class K {}
			function f() {}
			const MUT = 1; export function g() { MUT2 = 2; }
			let MUT2 = 1;
			function App() {
				return <div>
					<p>{N}</p>
					<p>{LIST}</p>
					<p a={LIST} b={OBJ} c={K} d={f} e={def} f2={ns} g={q} />
					<p a={V} />
					<p a={L} />
					<p a={D} />
					<p>{s}</p>
					<p>{C2}</p>
					<use xlink:href="#a" />
					<p>{OBJ}</p>
					<p a={MUT2} />
					<p a={Missing} />
				</div>;
			}`);
		assert.deepEqual(hoists, [
			'<p>{N}</p>',
			'<p a={LIST} b={OBJ} c={K} d={f} e={def} f2={ns} g={q} />',
			'<p a={D} />',
			'<p>{s}</p>',
			'<p>{C2}</p>',
			'<use xlink:href="#a" />'
		]);
	});

	test('shadowed or reassigned module bindings stay dynamic', () => {
		const { hoists } = plan(`const A = 1, B = 2, C = 3, D = 4, E = 5, F = 6, G = 7, H = 8;
			function f(A) { try {} catch (B) {} }
			const g = function C() {};
			const h = class D {};
			function i() { E++; [F] = []; }
			function j() { var G; class H {} }
			function App() {
				return <p a={A} b={B} c={C} d={D} e={E} f={F} g={G} h={H} />;
			}`);
		assert.deepEqual(hoists, []);
	});

	test('components', () => {
		const code = `import { memo } from 'preact/compat';
			import * as UI from './ui';
			const Card = () => <i />;
			let Late = () => <i />;
			function App() {
				return <div>
					<Card title="x" />
					<UI.Button />
					<Late />
					<Unknown />
					<this.props.as />
					<x-el a="1" />
					<svg:rect />
				</div>;
			}`;
		assert.deepEqual(plan(code).hoists, ['<i />', '<i />', '<x-el a="1" />', '<svg:rect />']);
		assert.deepEqual(plan(code, { hoistComponents: true }).hoists, [
			'<i />',
			'<i />',
			'<Card title="x" />',
			'<UI.Button />',
			'<x-el a="1" />',
			'<svg:rect />'
		]);
		assert.deepEqual(plan(code, { hoist: false }).hoists, []);
	});

	test('type-only syntax and expression wrappers', () => {
		const { hoists, wraps } = plan(
			`${SIGNALS}import type { T } from 't';
			import { type U, V } from 'v';
			enum E { A }
			function App(props: { a: T }) {
				const x = props as unknown as T;
				return <div>
					<p a={1 as number} b={(2 satisfies number)} c={V!} />
					{(s.value as number)}
					{s.value!}
					<p a={(s satisfies T).value} />
				</div>;
			}`,
			{},
			true
		);
		assert.deepEqual(hoists, ['<p a={1 as number} b={(2 satisfies number)} c={V!} />']);
		assert.deepEqual(wraps, ['hole: s.value as number', 'hole: s.value!', 'hole: (s satisfies T).value']);
	});
});

describe('signal holes', () => {
	test('bindable and unbindable positions', () => {
		const { wraps, diagnostics } = plan(`${SIGNALS}function Child() { return null; }
			function App() {
				return <div class={s.value} style={s.value} key={s.value} ref={s.value} onClick={s.value} children={s.value} dangerouslySetInnerHTML={s.value}>
					<Child a={s.value} />
					{s.value}
					<>{s.value}</>
					<x-el a={s.value} />
					{/* comment */}
				</div>;
			}`);
		assert.deepEqual(wraps, [
			'return: <div class={s.value} style={s.value} key={s.value} ref={s.value} onClick={s.value} children={s.value} dangerouslySetInnerHTML={s.value}> <Child a={s.value} /> {s.value} <>{s.value}</> <x-el a={s.value} /> {/* comment */} </div>',
			'hole: s.value',
			'element: <Child a={s.value} />',
			'hole: s.value',
			'hole: s.value',
			'hole: s.value'
		]);
		assert.deepEqual(diagnostics, []);
	});

	test('reasons for reads that stay in render', () => {
		const { diagnostics, stats } = plan(`${SIGNALS}import { useMemo } from 'preact/hooks';
			function Child() { return null; }
			function App() {
				let x = 0;
				if (s.value) x = 1;
				switch (s.value) {}
				for (let i = 0; i < s.value; i++) {}
				for (const k in s.value) {}
				for (const k of s.value) {}
				while (s.value) {}
				do {} while (s.value);
				const m = useMemo(() => 1, [s.value + 1]);
				let y = s.value;
				y++;
				s.value;
				s.value = 2;
				s.value++;
				log(<li key={s.value} />, <Child key="k" a={s.value} />, <a ref={s.value} onClick={s.value} />);
				return <ul>
					{(x = s.value)}
					{list.map(item => <li key={s.value}>{item}</li>)}
					<li key={item}>{s.value}</li>
					<Child>{(s.value, (y = 1))}</Child>
				</ul>;
			}`);
		assert.deepEqual(
			diagnostics.map(d => d.split(' @')[0]),
			[
				'control-flow s.value',
				'control-flow s.value',
				'control-flow s.value',
				'control-flow s.value',
				'control-flow s.value',
				'control-flow s.value',
				'control-flow s.value',
				'hook-argument s.value',
				'local-binding s.value',
				'statement s.value',
				'key s.value',
				'keyed-element s.value',
				'ref s.value',
				'event-handler s.value',
				'unsafe-expression s.value',
				'unsafe-expression s.value'
			]
		);
		// The keyed list and the keyed <li> child still move into holes.
		assert.deepEqual(stats, { reads: 18, moved: 2 });
	});

	test('a bare use() is a hook call', () => {
		const { wraps, diagnostics } = plan(`${SIGNALS}import { use } from 'preact/hooks';
			function App() { return <p>{use(s.value)}{user(s.value)}</p>; }`);
		assert.deepEqual(wraps, ['hole: user(s.value)']);
		assert.deepEqual(
			diagnostics.map(d => d.split(' @')[0]),
			['hook-argument s.value']
		);
	});

	test('spread children', () => {
		const code = `${SIGNALS}function Child() { return null; }
			function App() {
				log(<Child>{...s.value}</Child>);
				return <Child>{...s.value}</Child>;
			}`;
		// Oxc rejects JSX spread children; Babel parses them.
		const babel = summarize(analyze(PARSERS.babel(code), code), code);
		assert.deepEqual(
			babel.diagnostics.map(d => d.split(' ')[0]),
			['spread-child']
		);
		assert.deepEqual(babel.stats, { reads: 2, moved: 1 });

		const spread = 'function App() { return <div><p>{...[1]}</p></div>; }';
		assert.deepEqual(analyze(PARSERS.babel(spread), spread).hoists, []);
	});

	test('namespaced attributes bind', () => {
		const { wraps } = plan(`${SIGNALS}function App() { return <svg><use xlink:href={s.value} /></svg>; }`);
		assert.deepEqual(wraps, ['hole: s.value']);
	});

	test('classes and functions inside holes', () => {
		const { wraps } = plan(`${SIGNALS}function App() {
			return <p>{s.value ? class { x = s.value; } : function () { return s.value; }}</p>;
		}`);
		assert.deepEqual(wraps, ['hole: s.value ? class { x = s.value; } : function () { return s.value; }']);
	});

	test('non-components only count when they render', () => {
		const { stats, wraps } = plan(`${SIGNALS}const helper = () => <p>{s.value}</p>;
			function renderRow() { return <td>{s.value}</td>; }
			export default () => <b>{s.value}</b>;
			const Memo = memo(function () { return <i>{s.value}</i>; });
			const Wrapped = (forwardRef)((props) => <u>{s.value}</u>);
			const Paren = ((props) => <q>{s.value}</q>);
			const Obj = { method() { return <s>{s.value}</s>; } };
			s.value;
			class Comp extends Component { render() { return <em>{s.value}</em>; } }`);
		assert.deepEqual(stats, { reads: 4, moved: 4 });
		assert.ok(wraps.includes('hole: s.value'));
	});

	test('module-level reads are not wrapped', () => {
		const { wraps, stats } = plan(`${SIGNALS}export const el = <p>{s.value}</p>;`);
		assert.deepEqual(wraps, []);
		assert.deepEqual(stats, { reads: 0, moved: 0 });
	});

	test('arrow components with expression bodies', () => {
		const { wraps } = plan(`${SIGNALS}export const A = ({ x = s.value }) => s.value ? <p /> : null;
			export const B = () => <p>{s.value}</p>;`);
		assert.deepEqual(wraps, ['return: s.value ? <p /> : null', 'hole: s.value']);
	});

	test('derived constants', () => {
		const { wraps, bindings, diagnostics } = plan(`${SIGNALS}function App() {
			const a = s.value * 2;
			const b = a + 1;
			let c = s.value;
			const d = s.value, e = () => s.value, f = class {};
			const [g] = [s.value];
			const unused = s.value;
			return <p title={b}>{a}{c}{d}{e()}{g}</p>;
		}`);
		assert.deepEqual(bindings, [
			'derived a (a, a)',
			'derived b (b)',
			'derived c (c)',
			'derived d (d)',
			// Never read, but its read no longer subscribes the component.
			'derived unused ()'
		]);
		assert.deepEqual(wraps, [
			'derived: s.value * 2',
			'derived: a + 1',
			'derived: s.value',
			'derived: s.value',
			'derived: s.value',
			'hole: b',
			'hole: a',
			'hole: c',
			'hole: d'
		]);
		assert.deepEqual(
			diagnostics.map(d => d.split(' ')[0]),
			['local-binding']
		);
	});
});

describe('scopes', () => {
	test('shadowing, labels, meta properties and classes', () => {
		const { bindings, keptState } = plan(
			`import { useState } from 'preact/hooks';
			function App(props) {
				const [a] = useState(0);
				const [b] = useState(0);
				const [c] = useState(0);
				const [d] = useState(0);
				const [e] = useState(0);
				const [f] = useState(0);
				const [g] = useState(0);
				a: for (;;) { break a; }
				b: for (;;) { continue b; }
				const o = { a: 1, [b]: 2, c() {}, d };
				class K { e = 1; #f = 2; static { let g; g; } [g] = 3; f() { return new.target; } }
				const meta = import.meta;
				const h = function c() { return c; };
				try {} catch ({ e }) { e; }
				for (const f of []) f;
				for (let i = 0, a = 1; i < a; i++) {}
				switch (0) { case 0: let d = 1; d; }
				{ const a = 2; a; }
				return <p>{a}{b}{c}{d}{e}{f}{g}{o}</p>;
			}`,
			HOOKS
		);
		// Labels, keys, members, meta properties, private names and shadowed
		// names are not references; the computed key and the shorthand are.
		assert.deepEqual(bindings, [
			'useState a (a)',
			'useState b (b, b)',
			'useState c (c)',
			'useState d (d*, d)',
			'useState e (e)',
			'useState f (f)',
			'derived o (o)'
		]);
		// A computed class key has no function body to snapshot `g` in.
		assert.deepEqual(keptState, ['g: outside-function-body']);
	});

	test('writes keep state', () => {
		const { keptState } = plan(
			`import { useState, useReducer } from 'preact/hooks';
			function App() {
				const [a] = useState(0);
				const [b] = useState(0);
				const [c] = useState(0);
				const [d] = useState(0);
				const [e] = useReducer(r, 0);
				const [f] = useState(0);
				const [g] = useState(0);
				const [h] = useState(0);
				var [v] = useState(0);
				const [i, j, k] = useState(0);
				const { l } = useState(0);
				// A lowercase tag is a string, not a reference.
				const [m] = useState(0);
				const n = useState(0);
				const [[o]] = useState(0);
				const onClick = () => { a = 1; b++; [c] = [1]; ({ d } = {}); delete e.x; for (f of []); for (g in {}); };
				return <p onClick={onClick}>{a}{b}{c}{d}{e}{f}{g}{h}{v}{i}{l}{n}{o}<m /></p>;
			}`,
			HOOKS
		);
		assert.deepEqual(keptState, [
			'a: reassigned',
			'b: reassigned',
			'c: reassigned',
			'd: reassigned',
			'f: reassigned',
			'g: reassigned',
			'm: unread'
		]);
	});

	test('assignment and binding patterns', () => {
		const { keptState, diagnostics, bindings } = plan(
			`${SIGNALS}import { useState } from 'preact/hooks';
			function App() {
				const [a] = useState({});
				const [b] = useState(0);
				const [...rest] = list;
				const { x = s.value, ...others } = props;
				const onClick = () => {
					[a.x, ...a.y] = [1];
					({ k: a.z } = {});
					[s.value] = [1];
					({ v: s.value } = {});
				};
				return <p onClick={onClick}>{a}{b}{rest}{x}{others}</p>;
			}`,
			HOOKS
		);
		assert.deepEqual(keptState, []);
		assert.deepEqual(
			diagnostics.map(d => d.split(' @')[0]),
			['local-binding s.value']
		);
		// Reads inside the handler use a snapshot taken when it runs.
		assert.deepEqual(bindings.slice(0, 1), ['useState a (a)']);
	});

	test('parameters, defaults and TypeScript parameter properties', () => {
		const { diagnostics, bindings, keptState } = plan(
			`${SIGNALS}import { useState } from 'preact/hooks';
			class Store { constructor(private x = s.value) {} }
			function App({ a = s.value, ...rest }: any, [b]: any = [s.value]) {
				const [st] = useState(0);
				const f = ({ [st]: k }) => k;
				return <p>{st}</p>;
			}`,
			HOOKS,
			true
		);
		assert.deepEqual(
			diagnostics.map(d => d.split(' ')[0]),
			['statement', 'statement']
		);
		// A parameter default runs before any snapshot in the body could.
		assert.deepEqual(bindings, []);
		assert.deepEqual(keptState, ['st: outside-function-body']);
	});

	test('candidate used as a JSX tag stays put', () => {
		const { bindings, keptState } = plan(
			`import { useState } from 'preact/hooks';
			function App() {
				const [Comp] = useState(() => 'b');
				const [ns] = useState({});
				const tag = useState(0)[0];
				return <div><Comp /><ns.Item /><a:b /></div>;
			}`,
			HOOKS
		);
		assert.deepEqual(bindings, []);
		assert.deepEqual(keptState, ['Comp: reassigned', 'ns: reassigned']);
	});
});

describe('hooks', () => {
	test('memo, callback and effect dependencies', () => {
		const out = plan(
			`${SIGNALS}import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
			function App(props) {
				const [a, setA] = useState(0);
				const [b] = useState(0);
				const ref = useRef();
				const m = useMemo(() => a + props.x, [a, props.x]);
				const cb = useCallback(() => setA(a + 1), [a]);
				useEffect(() => { ref.current = b; }, [b, s.value]);
				useLayoutEffect(() => {}, [a]);
				return <p onClick={cb}>{m}</p>;
			}`,
			HOOKS
		);
		assert.deepEqual(out.deps, [
			'useMemo [props.x] <- a',
			'useCallback [] <- a',
			'useEffect [] <- b, s',
			'useLayoutEffect [] <- a'
		]);
		assert.deepEqual(out.keptState, []);
		assert.deepEqual(out.diagnostics, []);
	});

	test('what keeps a memo or callback dependency', () => {
		const out = plan(
			`${SIGNALS}import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
			function App(props) {
				const [a, setA] = useState(0);
				const [b] = useState(0);
				const [c] = useState(0);
				const [d] = useState(0);
				const [e] = useState(0);
				const stale = useCallback(() => b, []);
				const extra = useCallback(() => 1, [c]);
				const unlisted = useCallback(() => d + props.x, [d]);
				const reads = useMemo(() => s.value + e, [e]);
				const spread = useMemo(() => e, [...list]);
				const notLiteral = useMemo(() => e, deps);
				const asyncFn = useCallback(async () => e, [e]);
				const gen = useMemo(function* () { yield e; }, [e]);
				const noArgs = useMemo();
				const extraArg = useMemo(() => e, [e], 1);
				const f = props.x + 1;
				const derivedDep = useCallback(() => f, [f]);
				useEffect(() => { e; }, deps);
				return <p>{a}{b}{c}{d}{e}{stale}{extra}{unlisted}{reads}{spread}{notLiteral}{asyncFn}{gen}{noArgs}{extraArg}{derivedDep}</p>;
			}`,
			HOOKS
		);
		assert.deepEqual(out.keptState, [
			// Rendered as a value, the callback escapes as well as going stale.
			'b: escaping-closure',
			'c: hook-argument',
			'd: hook-argument',
			'e: hook-argument'
		]);
	});

	test('memos convert only with exhaustive dependencies', () => {
		const out = plan(
			`import { useMemo, useState } from 'preact/hooks';
			function App() {
				const [a] = useState(0);
				const [b] = useState(0);
				const ok = useMemo(function () { return a * 2; }, [a]);
				const missing = useMemo(() => a + b, [b]);
				const local = useMemo(() => { const t = a; return t; }, [a]);
				return <p>{ok}{missing}{local}</p>;
			}`,
			HOOKS
		);
		// `missing` stays a memo, so `b` stays listed and stays a hook.
		assert.deepEqual(
			out.bindings.map(b => b.split(' (')[0]),
			['useState a', 'useMemo ok', 'useMemo local']
		);
		assert.deepEqual(out.keptState, ['b: hook-argument']);
	});
});

describe('render skipping', () => {
	/** Kept state per name for one state read by a function in each position. */
	const kept = (body, ts = false) => {
		const { keptState } = plan(
			`import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
			function App({ on }) {
				const [x, setX] = useState(0);
				${body}
			}`,
			HOOKS,
			ts
		);
		return keptState.join();
	};

	test('functions in safe positions convert', () => {
		assert.equal(kept('const f = () => x; f(); return <p onClick={() => f()}>{x}</p>;'), '');
		assert.equal(kept('return <Comp onPick={() => x} ref={() => x} fn={() => x} title={on ? () => x : null} />;'), '');
		assert.equal(kept('function f() { return x; } return <Comp action={on && f} />;'), '');
		assert.equal(
			kept('const f = () => x; return <Comp fn={f as any} other={f!} third={f satisfies Function} />;', true),
			''
		);
		assert.equal(kept('const cb = useCallback(() => x, [x]); return <Comp onPick={cb} />;'), '');
		assert.equal(kept('const r = useRef(); r.current = 1; return <p>{x}</p>;'), '');
	});

	test('escaping functions keep their state', () => {
		for (const body of [
			'return <Comp renderRow={() => x} />;',
			'return <Comp render={() => String(x)} />;',
			'return <Comp row={() => <i>{x}</i>} />;',
			'return <Comp>{() => x}</Comp>;',
			'const f = () => x; return <Comp items={[f]} />;',
			'const f = () => x; useEffect(() => {}, [f]); return null;',
			'const f = () => x; setTimeout(f); return null;',
			'const cb = useCallback(() => x, [x]); return <Comp load={cb} />;',
			'return <Comp key={on ? 1 : 2} cell={on ? () => <b>{x}</b> : null} />;'
		]) {
			assert.equal(kept(body), 'x: escaping-closure', body);
		}
	});

	test('re-renders with side jobs keep their state', () => {
		assert.equal(
			kept('const r = useRef(0); r.current++; return <p onClick={() => setX(x + 1)}>{x}</p>;'),
			'x: render-reads-ref'
		);
		assert.equal(kept('const r = useRef(); return <p>{x}{r.current}</p>;'), 'x: render-reads-ref');
		assert.equal(kept('const r = useRef(); return <p onClick={() => r.current}>{x}{r[0]}</p>;'), '');
		assert.equal(kept('useEffect(() => {}); return <p>{x}</p>;'), 'x: effect-every-render');
		assert.equal(kept('return <p onClick={() => setX(1)} />;'), 'x: unread');
	});
});

describe('helpers', () => {
	test('patternNames', () => {
		const program = PARSERS.babel('const [a, , ...b] = x, { c, d: [e], ...f } = y, { g = 1 } = z;');
		const names = new Set();
		for (const decl of program.body[0].declarations) patternNames(decl.id, names);
		assert.deepEqual([...names], ['a', 'b', 'c', 'e', 'f', 'g']);
		assert.deepEqual([...patternNames(null, new Set())], []);
	});

	test('isStaticValue without a scope', () => {
		const expr = code => PARSERS.oxc(`(${code})`).body[0].expression;
		assert.equal(isStaticValue(expr('1')), true);
		assert.equal(isStaticValue(expr('x')), false);
		assert.equal(isStaticValue(expr('[1, {a: "b"}]')), true);
		assert.equal(isStaticValue(expr('-x')), false);
		assert.equal(isStaticValue(null), false);
	});

	test('moduleScope', () => {
		const scope = moduleScope(
			PARSERS.babel(
				`import type T from 't';
			export const a = 1;
			export default function f() {}
			export class C {}
			let b;
			b = 2;`,
				true
			)
		);
		assert.deepEqual([...scope.bindings.keys()], ['a', 'f', 'C']);
	});
});
