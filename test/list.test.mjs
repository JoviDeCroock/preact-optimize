import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { h, hydrate, render } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { parseSync } from '@babel/core';
import { parseAst } from 'rolldown/parseAst';
import { analyze } from '../packages/runtime/src/compiler.js';
import { canonical, container, equivalent, load, settle } from './harness.mjs';

const MODES = [{ blocks: true }, { blocks: true, hooks: true }];

/** The lists each parser's plan finds, as `pure` flags. */
function lists(code, options = { blocks: true, hooks: true }) {
	const babel = parseSync(code, {
		filename: 'a.jsx',
		babelrc: false,
		configFile: false,
		parserOpts: { plugins: ['jsx'] }
	});
	const oxc = parseAst(code, { lang: 'jsx' });
	const a = analyze(babel.program, code, options).lists.map(l => l.pure);
	const b = analyze(oxc, code, options).lists.map(l => l.pure);
	assert.deepEqual(b, a, 'parsers disagree');
	return a;
}

/** A table of rows driven from outside, like js-framework-benchmark. */
const TABLE = `import { useState } from 'preact/hooks';
export const stats = { calls: 0 };
const count = id => (stats.calls++, id);
export function App() {
	const [data, setData] = useState([1, 2, 3, 4, 5].map(id => ({ id, label: 'l' + id })));
	const [selected, setSelected] = useState(0);
	const remove = id => setData(prev => prev.filter(d => d.id !== id));
	stats.set = setData;
	stats.select = setSelected;
	return (
		<table>
			<tbody class="rows">
				{data.map(row => {
					const id = count(row.id);
					return (
						<tr key={id} class={selected === id ? 'danger' : ''}>
							<td>{id}</td>
							<td><a class="select" onClick={() => setSelected(id)}>{row.label}</a></td>
							<td><a class="remove" onClick={() => remove(id)}>x</a></td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}`;

const click = selector => (m, root) =>
	root.querySelector(selector).dispatchEvent(new Event('click', { bubbles: true }));
const set = fn => m => m.stats.set(fn);
const item = (id, label = 'l' + id) => ({ id, label });

describe('list shapes', () => {
	const app = body => `export function App({ items, other, props }) { return ${body}; }`;
	const row = '<li key={x.id}>{x.a}<b>{x.b}</b></li>';
	const cases = {
		'the only child': [`<ul>{items.map(x => ${row})}</ul>`, 1],
		'lines of whitespace around it': [`<ul>\n  {items.map(x => ${row})}\n</ul>`, 1],
		'declarations before the return': [`<ul>{items.map(x => { const a = x.a; let b = a; return ${row}; })}</ul>`, 1],
		'a comment next to it': [`<ul>{/* c */}{items.map(x => ${row})}</ul>`, 1],
		'other props on the element': [`<ul class={other} key="k">{items.map(x => ${row})}</ul>`, 1],
		'a space next to it': [`<ul> {items.map(x => ${row})}</ul>`, 0],
		'a sibling': [`<ul>{items.map(x => ${row})}<li /></ul>`, 0],
		'two maps': [`<ul>{items.map(x => ${row})}{items.map(x => ${row})}</ul>`, 0],
		'a spread': [`<ul {...props}>{items.map(x => ${row})}</ul>`, 0],
		'a children prop': [`<ul children={other}>{items.map(x => ${row})}</ul>`, 0],
		innerHTML: [`<ul innerHTML={other}>{items.map(x => ${row})}</ul>`, 0],
		'a component': [`<List>{items.map(x => ${row})}</List>`, 0],
		'an SVG parent': [`<svg><g>{items.map(x => ${row})}</g></svg>`, 0],
		'a MathML parent': [`<math><mrow>{items.map(x => ${row})}</mrow></math>`, 0],
		'not map': [`<ul>{items.filter(x => ${row})}</ul>`, 0],
		'a computed map': [`<ul>{items['map'](x => ${row})}</ul>`, 0],
		'an optional map': [`<ul>{items?.map(x => ${row})}</ul>`, 0],
		'a map call': [`<ul>{map(x => ${row})}</ul>`, 0],
		'a this argument': [`<ul>{items.map(x => ${row}, other)}</ul>`, 0],
		'a function expression': [`<ul>{items.map(function (x) { return ${row}; })}</ul>`, 0],
		'an async row': [`<ul>{items.map(async x => ${row})}</ul>`, 0],
		'an index parameter': [`<ul>{items.map((x, i) => ${row})}</ul>`, 0],
		'a destructured parameter': [`<ul>{items.map(({ id }) => <li key={id}>{id}<b /></li>)}</ul>`, 0],
		'a statement before the return': [`<ul>{items.map(x => { other(x); return ${row}; })}</ul>`, 0],
		'a var': [`<ul>{items.map(x => { var a = x; return ${row}; })}</ul>`, 0],
		'no return': [`<ul>{items.map(x => { const a = x; })}</ul>`, 0],
		'an empty return': [`<ul>{items.map(x => { return; })}</ul>`, 0],
		'a conditional row': [`<ul>{items.map(x => x.a ? ${row} : null)}</ul>`, 0],
		'an unkeyed row': [`<ul>{items.map(x => <li>{x.a}<b /></li>)}</ul>`, 0],
		'a row that is not a block': [`<ul>{items.map(x => <li key={x.id}><Comp /></li>)}</ul>`, 0],
		'a static row': [`<ul>{items.map(x => <li key="k">a<b /></li>)}</ul>`, 0]
	};
	for (const [name, [body, expected]] of Object.entries(cases)) {
		test(name, () => assert.equal(lists(app(body)).length, expected));
	}
	test('only with blocks', () => {
		assert.deepEqual(lists(app(`<ul>{items.map(x => ${row})}</ul>`), { hooks: true }), []);
	});
});

describe('pure rows', () => {
	/** `pure` for a row with these reads, inside an `App` with this setup. */
	const pure = (setup, reads, top = '') =>
		lists(`import { useState, useRef, useMemo } from 'preact/hooks';
			import { signal } from '@preact/signals';
			${top}
			export function App({ prop }) {
				${setup}
				return <ul>{[1, 2].map(x => <li key={x}>{${reads}}<b /></li>)}</ul>;
			}`)[0];
	const cases = {
		'only the item': ['', 'x', '', true],
		'module constants and functions': ['', 'K + f(x) + String(x)', 'const K = 1; function f(v) { return v; }', true],
		imports: ['', 'signal', '', true],
		'a setter': ['const [s, setS] = useState(0);', 'setS', '', true],
		'converted state in a slot': ['const [s, setS] = useState(0);', 'x === s', '', true],
		'a module signal in a slot': ['', 'x + sig.value', 'const sig = signal(0);', true],
		'a function reading a setter': ['const [s, setS] = useState(0); const pick = v => setS(v);', 'pick', '', true],
		'functions calling each other': [
			'const [s, setS] = useState(0); function a(v) { return v && b(v - 1); } function b(v) { return a(v) || setS; }',
			'a',
			'',
			true
		],
		'a prop': ['', 'prop', '', false],
		'state that stays a hook': ['const [s, setS] = useState(0); const [t] = useState(s);', 'x === s', '', false],
		'a ref': ['const r = useRef(0);', 'r', '', false],
		'a local': ['const local = prop + 1;', 'local', '', false],
		'a function reading a prop': ['const get = () => prop;', 'get', '', false],
		'a mutated module object': [
			'',
			'cache[x]',
			'const cache = {}; export const put = (k, v) => (cache[k] = v);',
			false
		],
		'a reassigned module binding': ['', 'n', 'let n = 0; export const bump = () => n++;', false],
		'an unknown global': ['', 'Math.random()', '', false],
		this: ['', 'this', '', false],
		arguments: ['', 'arguments', '', false]
	};
	for (const [name, [setup, reads, top, expected]] of Object.entries(cases)) {
		test(name, () => assert.equal(pure(setup, reads, top), expected));
	}
	test('a signal read outside its slots', () => {
		assert.deepEqual(
			lists(`import { signal } from '@preact/signals';
				const sig = signal(0);
				export function App() {
					return <ul>{[1, 2].map(x => { const v = sig.value; return <li key={x}>{v}<b /></li>; })}</ul>;
				}`),
			[false]
		);
	});
	test('a handler reading a signal is not a render-time read', () => {
		assert.deepEqual(
			lists(`import { signal } from '@preact/signals';
				const sig = signal(0);
				const log = v => v;
				export function App() {
					return <ul>{[1, 2].map(x => <li key={x} onClick={() => log(sig.value)}>{x}<b /></li>)}</ul>;
				}`),
			[true]
		);
	});
});

describe('lists', () => {
	const steps = [
		m => m.stats.select(2),
		set(d => d.map((r, i) => (i % 2 ? r : item(r.id, r.label + '!')))),
		set(d => [d[4], d[1], d[2], d[3], d[0]]),
		set(d => [...d].reverse()),
		set(d => [...d, item(6), item(7)]),
		click('.remove'),
		click('tr:nth-child(2) .select'),
		set(d => [item(0), ...d.slice(2)]),
		set(d => d.slice(1).concat(d[0])),
		set([]),
		set([item(9), item(8)]),
		set(d => [...d, ...d.map(r => item(r.id + 100))])
	];

	for (const options of MODES) {
		test(`patches, moves and removes rows like Preact (${JSON.stringify(options)})`, async () => {
			const runs = await equivalent(TABLE, steps, options);
			assert.ok(runs.babel.module.stats.calls <= runs.none.module.stats.calls);
		});
	}

	test('a pure row is only rendered for a new item', async () => {
		const runs = await equivalent(TABLE, steps, MODES[1]);
		// Only items new to the list render their row.
		assert.equal(runs.none.module.stats.calls, 60);
		assert.equal(runs.babel.module.stats.calls, 15);
		assert.equal(runs.rolldown.module.stats.calls, 15);
	});

	test('shuffles', async () => {
		// The same orders for every variant: ids, kept rows reuse their item.
		let seed = 7;
		const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		let ids = [1, 2, 3, 4, 5];
		const orders = Array.from({ length: 30 }, () => {
			ids = ids.filter(() => random() > 0.2);
			for (let i = ids.length; i > 1; i--) {
				const j = Math.floor(random() * i);
				[ids[i - 1], ids[j]] = [ids[j], ids[i - 1]];
			}
			for (let i = 0; i < 3; i++)
				ids.splice(Math.floor(random() * (ids.length + 1)), 0, 1000 + Math.floor(random() * 50));
			return (ids = ids.filter((id, i) => ids.indexOf(id) === i));
		});
		const steps = orders.map(order => set(d => order.map(id => d.find(r => r.id === id) || item(id))));
		for (const options of MODES) await equivalent(TABLE, steps, options);
	});

	test('duplicate keys and items', async () => {
		const a = item(1);
		for (const options of MODES) {
			await equivalent(
				TABLE,
				[set([a, a, item(2)]), set([item(2), a, a, a]), set([a]), set([item(1), item(1)]), set([])],
				options
			);
		}
	});

	test('primitive items and missing keys', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = {};
			export function App() {
				const [items, setItems] = useState([1, 2, 3]);
				stats.set = setItems;
				return <ul>{items.map(x => <li key={x == 2 ? undefined : x}>{x}<i /></li>)}</ul>;
			}`;
		for (const options of MODES) {
			await equivalent(code, [set([3, 2, 1]), set([2, 2, 4]), set([1, 2])], options);
		}
	});

	test('items that map but are not an array', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = {};
			const of = (...list) => ({ map: fn => list.map(fn) });
			export function App() {
				const [items, setItems] = useState(of(1, 2));
				stats.set = setItems;
				stats.of = of;
				return <ul>{items.map(x => <li key={x}>{x}<i /></li>)}</ul>;
			}`;
		for (const options of MODES) {
			await equivalent(code, [m => m.stats.set(m.stats.of(2, 1, 3))], options);
		}
	});

	test('a row whose text becomes a vnode renders through Preact from then on', async () => {
		const code = `import { useState } from 'preact/hooks';
			import { h } from 'preact';
			export const stats = { h };
			export function App() {
				const [items, setItems] = useState([{ id: 1, label: 'a' }]);
				stats.set = setItems;
				return <ul>{items.map(x => <li key={x.id}>{x.label}<i /></li>)}</ul>;
			}`;
		for (const options of MODES) {
			await equivalent(
				code,
				[
					m => m.stats.set(d => [...d, { id: 2, label: m.stats.h('b', null, 'vnode') }]),
					m => m.stats.set(d => [...d, { id: 3, label: 'c' }]),
					m => m.stats.set(d => d.slice(1))
				],
				options
			);
		}
	});

	test('a signal in row text becoming a vnode', async () => {
		const code = `import { useState } from 'preact/hooks';
			import { h } from 'preact';
			import { signal } from '@preact/signals';
			export const label = signal('a');
			export const stats = { h };
			export function App() {
				const [items, setItems] = useState([1, 2]);
				stats.set = setItems;
				return <ul>{items.map(x => <li key={x}>{label.value}<i>{x}</i></li>)}</ul>;
			}`;
		for (const options of MODES) {
			await equivalent(
				code,
				[m => (m.label.value = 'b'), m => (m.label.value = m.stats.h('b', null, 'v')), m => m.stats.set([2, 3])],
				options
			);
		}
	});

	test('a list inside a hole follows converted state without rendering', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				const [items, setItems] = useState([1, 2]);
				stats.set = setItems;
				return <div><ul class="list">{items.map(x => <li key={x}>{x}<i /></li>)}</ul></div>;
			}`;
		const runs = await equivalent(code, [set([2, 1, 3]), set([])], MODES[1]);
		assert.equal(runs.none.module.stats.renders, 3);
		assert.equal(runs.babel.module.stats.renders, 1);
		assert.equal(runs.rolldown.module.stats.renders, 1);
	});

	test('errors from a row reach the error boundary', async () => {
		const code = `import { useState } from 'preact/hooks';
			import { Component } from 'preact';
			export const stats = {};
			class Boundary extends Component {
				state = { error: null };
				componentDidCatch(error) { this.setState({ error: error.message }); }
				render() { return this.state.error ? <p>{this.state.error}</p> : this.props.children; }
			}
			function List() {
				const [items, setItems] = useState([{ id: 1, n: 'a' }]);
				stats.set = setItems;
				return <ul>{items.map(x => <li key={x.id}>{x.n.toUpperCase()}<i /></li>)}</ul>;
			}
			export function App() { return <Boundary><List /></Boundary>; }`;
		for (const options of MODES) {
			await equivalent(code, [set(d => [...d, { id: 2 }])], options);
		}
	});

	test('rows stop listening when the list unmounts or clears', async () => {
		for (const options of MODES) {
			for (const via of ['babel', 'rolldown']) {
				const { module } = await load(TABLE, via, options);
				const root = container();
				render(h(module.App, null), root);
				const kept = root.querySelector('.select');
				render(null, root);
				kept.dispatchEvent(new Event('click', { bubbles: true }));
				assert.equal(kept.__pl, undefined, via);

				render(h(module.App, null), root);
				const removed = root.querySelector('.select');
				module.stats.set([]);
				await settle();
				assert.equal(removed.__pl, undefined, via);
				render(null, root);
			}
		}
	});

	test('switching between a list and plain children', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = {};
			export function App() {
				const [items, setItems] = useState([1, 2]);
				stats.set = setItems;
				return items.length > 2
					? <ul>{items.map(x => <li key={x}>{x}<i /></li>)}</ul>
					: <ul><li>plain</li>{items.length}</ul>;
			}`;
		for (const options of MODES) {
			await equivalent(code, [set([1, 2, 3]), set([1, 2]), set([3, 2, 1])], options);
		}
	});

	test('hydrates and renders on the server like the original JSX', async () => {
		for (const options of MODES) {
			const { module: plain } = await load(TABLE, 'none', options);
			const html = renderToString(h(plain.App, null));
			for (const via of ['babel', 'rolldown']) {
				const { module } = await load(TABLE, via, options);
				assert.equal(renderToString(h(module.App, null)), html, via);
				const root = container();
				root.innerHTML = html;
				const parsed = root.innerHTML;
				hydrate(h(module.App, null), root);
				await settle();
				assert.equal(canonical(root.innerHTML), canonical(parsed), via);
				root.querySelector('.select').dispatchEvent(new Event('click', { bubbles: true }));
				await settle();
				assert.equal(root.querySelector('tr').className, 'danger', via);
				render(null, root);
			}
		}
	});

	test('in another realm', async () => {
		const other = new JSDOM('<!doctype html><body></body>').window.document;
		const seen = [];
		for (const via of ['none', 'babel']) {
			const { module } = await load(TABLE, via, MODES[1]);
			const root = other.createElement('div');
			other.body.appendChild(root);
			render(h(module.App, null), root);
			module.stats.set(d => [...d].reverse());
			await settle();
			seen.push(canonical(root.innerHTML));
			render(null, root);
		}
		assert.equal(seen[1], seen[0]);
	});
});
