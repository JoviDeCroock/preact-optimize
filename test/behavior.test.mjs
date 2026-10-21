import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { h, render } from 'preact';
import { VARIANTS, container, equivalent, load } from './harness.mjs';

describe('signal holes', () => {
	test('text read binds to the text node without re-rendering', async () => {
		const runs = await equivalent(
			`import { signal } from '@preact/signals';
			export const count = signal(0);
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				return <p>Count: {count.value}</p>;
			}`,
			[m => (m.count.value = 1), m => (m.count.value = 2)]
		);
		assert.equal(runs.none.stats.renders, 3);
		assert.equal(runs.babel.stats.renders, 1);
		assert.equal(runs.rolldown.stats.renders, 1);
		assert.equal(runs.babel.html.at(-1), '<p>Count: 2</p>');
	});

	test('attribute read binds to the attribute', async () => {
		const runs = await equivalent(
			`import { signal } from '@preact/signals';
			export const count = signal(0);
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				return <p class={count.value % 2 ? 'odd' : 'even'} data-n={count.value}>x</p>;
			}`,
			[m => (m.count.value = 1), m => (m.count.value = 2)]
		);
		assert.equal(runs.none.stats.renders, 3);
		assert.equal(runs.babel.stats.renders, 1);
		assert.equal(runs.rolldown.stats.renders, 1);
	});

	test('vnode-valued holes re-render only the hole', async () => {
		const runs = await equivalent(
			`import { signal } from '@preact/signals';
			export const show = signal(false);
			export const msg = signal('a');
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				return <div>{show.value ? <b>{msg.value}</b> : <i>off</i>}</div>;
			}`,
			[m => (m.show.value = true), m => (m.msg.value = 'b'), m => (m.show.value = false), m => (m.show.value = true)]
		);
		assert.equal(runs.none.stats.renders, 5);
		assert.equal(runs.babel.stats.renders, 1);
		assert.equal(runs.rolldown.stats.renders, 1);
	});

	test('lists are re-diffed inside the hole only', async () => {
		const runs = await equivalent(
			`import { signal } from '@preact/signals';
			export const todos = signal([{ id: 1, text: 'a' }]);
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				return <ul>{todos.value.map(t => <li key={t.id}>{t.text}</li>)}</ul>;
			}`,
			[
				m => (m.todos.value = [...m.todos.value, { id: 2, text: 'b' }]),
				m => (m.todos.value = m.todos.value.slice().reverse()),
				m => (m.todos.value = [])
			]
		);
		assert.equal(runs.none.stats.renders, 4);
		assert.equal(runs.babel.stats.renders, 1);
		assert.equal(runs.rolldown.stats.renders, 1);
	});

	test('holes mixing props and signals pick up new props', async () => {
		await equivalent(
			`import { signal } from '@preact/signals';
			import { useState } from 'preact/hooks';
			export const count = signal(0);
			export const stats = { setPrefix: null };
			function Label(props) {
				return <span title={props.prefix + count.value}>{props.prefix + count.value}</span>;
			}
			export function App() {
				const [prefix, setPrefix] = useState('a');
				stats.setPrefix = setPrefix;
				return <Label prefix={prefix} />;
			}`,
			[m => (m.count.value = 1), m => m.stats.setPrefix('b'), m => (m.count.value = 2)]
		);
	});

	test('.value on plain objects keeps working', async () => {
		await equivalent(
			`import { useState } from 'preact/hooks';
			export const stats = { set: null };
			export function App() {
				const [field, set] = useState({ value: 'a' });
				stats.set = set;
				return <input value={field.value} title={field.value} />;
			}`,
			[m => m.stats.set({ value: 'b' }), m => m.stats.set({ value: 'c' })]
		);
	});

	test('nested holes', async () => {
		const runs = await equivalent(
			`import { signal } from '@preact/signals';
			export const show = signal(true);
			export const msg = signal('a');
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				return <div>{show.value && <p>{msg.value}</p>}</div>;
			}`,
			[m => (m.msg.value = 'b'), m => (m.show.value = false), m => (m.msg.value = 'c'), m => (m.show.value = true)]
		);
		assert.equal(runs.babel.stats.renders, 1);
		assert.equal(runs.rolldown.stats.renders, 1);
	});

	test('input value binding and event handlers', async () => {
		const runs = await equivalent(
			`import { signal } from '@preact/signals';
			export const text = signal('a');
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				return <input value={text.value} onInput={e => (text.value = e.currentTarget.value)} />;
			}`,
			[
				(m, root) => {
					const input = root.querySelector('input');
					input.value = 'typed';
					input.dispatchEvent(new InputEvent('input'));
				},
				m => (m.text.value = 'set')
			]
		);
		for (const via of ['none', 'babel', 'rolldown']) {
			assert.equal(runs[via].root.querySelector('input').value, 'set', via);
		}
		assert.equal(runs.babel.stats.renders, 1);
	});

	test('fragments and component children', async () => {
		const runs = await equivalent(
			`import { signal } from '@preact/signals';
			export const count = signal(0);
			export const stats = { renders: 0, seen: [] };
			function Child(props) {
				stats.seen.push(typeof props.children);
				return <b>{props.children}</b>;
			}
			export function App() {
				stats.renders++;
				return <>{count.value}<Child>{count.value}</Child></>;
			}`,
			[m => (m.count.value = 1)]
		);
		// Component children are left alone: Child still sees a number.
		assert.deepEqual(runs.babel.stats.seen, ['number', 'number']);
		assert.deepEqual(runs.rolldown.stats.seen, ['number', 'number']);
	});

	test('unmounting disposes hole subscriptions', async () => {
		const runs = await equivalent(
			`import { signal } from '@preact/signals';
			export const count = signal(0);
			export const stats = {};
			export function App() {
				return <p class={'c' + count.value}>{count.value}</p>;
			}`,
			[(m, root) => render(null, root), m => (m.count.value = 5)]
		);
		for (const via of VARIANTS) {
			// `_targets` (mangled `t`) is the head of the subscriber list.
			assert.equal(runs[via].module.count.t, undefined, via);
		}
	});
});

describe('static hoisting', () => {
	test('static subtrees are reused and keep their DOM', async () => {
		const runs = await equivalent(
			`import { useState } from 'preact/hooks';
			export const stats = { set: null };
			export function App() {
				const [n, set] = useState(0);
				stats.set = set;
				return <div><header class="h"><h1>Title</h1><p style={{ color: 'red' }}>sub</p></header><span>{n}</span></div>;
			}`,
			[m => m.stats.set(1), m => m.stats.set(2)]
		);
		for (const via of VARIANTS) {
			assert.match(runs[via].html.at(-1), /<span>2<\/span>/);
		}
	});

	test('hoisted vnodes are shared across instances without pinning DOM', async () => {
		const { module, code } = await load(
			`export const stats = {};
			export function Item() { return <li class="item">static</li>; }
			export function App() { return <ul><Item /><Item /><Item /></ul>; }`,
			'babel'
		);
		assert.match(code, /\$static/);
		const root = container();
		render(h(module.App, null), root);
		assert.equal(
			root.innerHTML,
			'<ul><li class="item">static</li><li class="item">static</li><li class="item">static</li></ul>'
		);
		// The shared vnode itself is never mounted: `_dom` (mangled `__e`) stays unset.
		const shared = module.Item();
		assert.equal(shared.__e, null);
		assert.equal(shared.__, null);
	});

	test('hoistComponents skips re-rendering static component elements', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = { child: 0, set: null };
			function Child(props) { stats.child++; return <b>{props.label}</b>; }
			export function App() {
				const [n, set] = useState(0);
				stats.set = set;
				return <div><Child label="x" /><i>{n}</i></div>;
			}`;
		const steps = [m => m.stats.set(1), m => m.stats.set(2)];
		const plain = await equivalent(code, steps);
		const hoisted = await equivalent(code, steps, { hoistComponents: true });
		assert.equal(plain.babel.stats.child, 3);
		assert.equal(hoisted.none.stats.child, 3);
		assert.equal(hoisted.babel.stats.child, 1);
		assert.equal(hoisted.rolldown.stats.child, 1);
	});

	test('hoisted component referenced before its declaration (TDZ)', async () => {
		await equivalent(
			`export const stats = {};
			export function App() { return <div><Late /></div>; }
			const Late = () => <b>late</b>;`,
			[],
			{ hoistComponents: true }
		);
	});

	test('locally shadowed components are not hoisted', async () => {
		const code = `export const stats = { child: 0 };
			function Child() { return <b>outer</b>; }
			export function App() {
				const Child = () => { stats.child++; return <b>inner</b>; };
				return <div><Child /></div>;
			}`;
		for (const via of ['babel', 'rolldown']) {
			const { code: out } = await load(code, via, { hoistComponents: true });
			assert.doesNotMatch(out, /\$static\(\s*_?jsx\(Child/, via);
		}
		await equivalent(code, [], { hoistComponents: true });
	});
});
