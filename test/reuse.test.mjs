import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { h, render } from 'preact';
import { parseSync } from '@babel/core';
import { parseAst } from 'rolldown/parseAst';
import { analyze } from '../packages/runtime/src/compiler.js';
import { equivalent, load, settle } from './harness.mjs';

const PARSERS = {
	babel: code => parseSync(code, { babelrc: false, configFile: false, parserOpts: { plugins: ['jsx'] } }).program,
	rolldown: code => parseAst(code, { lang: 'jsx' })
};

/** Compiled output for both plugins. */
async function compiled(code, opts) {
	const out = {};
	for (const via of ['babel', 'rolldown']) out[via] = (await load(code, via, opts)).code;
	return out;
}

/**
 * Each wrapped scope's inputs per parser, in source order: names joined with
 * `, ` (converted bindings as `$name`, read through their signal), or `null`
 * when the scope can't be reused.
 */
function depsOf(code, opts = {}) {
	const result = {};
	for (const [via, parse] of Object.entries(PARSERS)) {
		const plan = analyze(parse(code), code, opts);
		result[via] = plan.wraps
			.slice()
			.sort((a, b) => a.node.start - b.node.start)
			.map(w => w.deps && w.deps.map(d => (d.binding ? '$' : '') + d.name + (d.prop ? '.' + d.prop : '')).join(', '));
	}
	return result;
}

const PRELUDE = `import { signal } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const count = signal(1);
	export const stats = { evals: 0 };
	const track = v => (stats.evals++, v);`;

describe('reusing scope computeds across renders', () => {
	test('a hole whose inputs are unchanged keeps its computed', async () => {
		const code = `${PRELUDE}
			export function App() {
				const [tick, setTick] = useState(0);
				stats.rerender = () => setTick(t => t + 1);
				return <p data-tick={tick}>{track(count.value)}</p>;
			}`;
		const runs = await equivalent(
			code,
			[m => m.stats.rerender(), m => m.stats.rerender(), m => (m.count.value = 2), m => m.stats.rerender()],
			{}
		);
		// Untransformed: once per render. Reused: once, plus once for the write.
		assert.equal(runs.none.stats.evals, 5);
		assert.equal(runs.babel.stats.evals, 2);
		assert.equal(runs.rolldown.stats.evals, 2);
	});

	test('changed inputs make a new computed, including a property changed in place', async () => {
		const code = `${PRELUDE}
			export function App() {
				const [n, setN] = useState(0);
				const [box] = useState(() => ({ k: 'a' }));
				stats.set = setN;
				stats.box = box;
				return <p title={track(count.value + n)}>{track(count.value + box.k)}</p>;
			}`;
		const runs = await equivalent(
			code,
			[
				m => m.stats.set(1),
				m => m.stats.set(1),
				m => {
					// Mutated in place, then re-rendered: has to be read again.
					m.stats.box.k = 'b';
					m.stats.set(2);
				}
			],
			{}
		);
		assert.equal(runs.babel.html.at(-1), '<p title="3">1b</p>');
		// Three renders of two holes; `box.k` is unchanged on the second.
		assert.equal(runs.none.stats.evals, 6);
		assert.equal(runs.babel.stats.evals, 5);
		assert.equal(runs.rolldown.stats.evals, 5);
	});

	test('holes in .map() reuse by position, and stay correct when items move', async () => {
		const code = `${PRELUDE}
			export function App() {
				const [items, setItems] = useState([1, 2, 3]);
				stats.set = setItems;
				return <ul>{items.map(i => <li key={i}>{track(i * count.value)}</li>)}</ul>;
			}`;
		const runs = await equivalent(
			code,
			[
				m => m.stats.set(items => [...items]),
				m => m.stats.set(items => [...items].reverse()),
				m => (m.count.value = 10),
				m => m.stats.set(items => items.slice(1))
			],
			{}
		);
		// Mount 3, same list 0, reversed 2 (the middle stays), write 3, slice 2.
		assert.equal(runs.babel.stats.evals, 10);
		assert.equal(runs.rolldown.stats.evals, 10);
	});

	test('derived values and the holes reading them are reused together', async () => {
		const code = `${PRELUDE}
			export function App() {
				const [tick, setTick] = useState(0);
				stats.rerender = () => setTick(t => t + 1);
				const doubled = track(count.value * 2);
				return <p data-tick={tick}>{doubled}</p>;
			}`;
		const deps = depsOf(code);
		assert.deepEqual(deps.babel, ['track, count', '$doubled']);
		assert.deepEqual(deps.rolldown, ['track, count', '$doubled']);
		const runs = await equivalent(code, [m => m.stats.rerender(), m => (m.count.value = 3)], {});
		assert.equal(runs.babel.stats.evals, 2);
		assert.equal(runs.rolldown.stats.evals, 2);
	});

	test('converted state is an input through its signal', async () => {
		const code = `${PRELUDE}
			export function App({ step }) {
				const [n, setN] = useState(0);
				return <p onClick={() => setN(n + step)}>{track(n + count.value)}</p>;
			}`;
		const deps = depsOf(code, { hooks: true });
		assert.deepEqual(deps.babel, ['track, $n, count']);
		assert.deepEqual(deps.rolldown, ['track, $n, count']);
	});

	test('a closure created inside a scope reads state through its signal', async () => {
		const code = `${PRELUDE}
			export function App() {
				const [n, setN] = useState(1);
				return <div>{count.value > 0 && <button onClick={() => setN(n + 1)}>+</button>}<i>{n}</i></div>;
			}`;
		const deps = depsOf(code, { hooks: true });
		assert.deepEqual(deps.babel, ['count, $n', '$n']);
		assert.deepEqual(deps.rolldown, deps.babel);
		const click = (m, root) => root.querySelector('button').dispatchEvent(new Event('click'));
		await equivalent(code, [click, click, m => (m.count.value = 2), click], { hooks: true });
	});

	test('a scope inside a render helper takes its parameters as inputs', async () => {
		const code = `${PRELUDE}
			export function App() {
				const [n, setN] = useState(1);
				const row = i => <li>{track(i * n * count.value)}</li>;
				return <ul onClick={() => setN(n + 1)}>{row(1)}{row(2)}</ul>;
			}`;
		const deps = depsOf(code, { hooks: true });
		assert.deepEqual(deps.babel, ['track, i, n, count']);
		assert.deepEqual(deps.rolldown, deps.babel);
		const click = (m, root) => root.querySelector('ul').dispatchEvent(new Event('click'));
		await equivalent(code, [click, m => (m.count.value = 2), click], { hooks: true });
	});

	test('inside a closure that snapshots state, the snapshot is the input', async () => {
		const code = `${PRELUDE}
			function List({ render }) { return <ul>{[1, 2].map(render)}</ul>; }
			export function App() {
				const [n, setN] = useState(1);
				stats.set = setN;
				return <div>
					<List render={i => <li key={i}>{i * n * count.value}</li>} />
					<button onClick={() => setN(n + 1)}>{n}</button>
				</div>;
			}`;
		for (const [via, text] of Object.entries(await compiled(code, { hooks: true }))) {
			assert.match(
				text.replace(/\s+/g, ' '),
				/\$hole\(\(\) => i \* n \* count\.value, \[ ?i, n, count ?\], _k\[\d\]\)/,
				via
			);
		}
		await equivalent(code, [m => m.stats.set(2), m => (m.count.value = 3), m => m.stats.set(5)], { hooks: true });
	});

	test('a region holding a vnode is not reused, so its signal props stay bound', async () => {
		const code = `${PRELUDE}
			export const p = signal(0);
			function Inner(props) {
				const [a, setA] = useState(0);
				const total = count.value + a;
				const later = () => total;
				return <section>
					<b onClick={later}>{props.p}</b>
					<button onClick={() => setA(a + 1)}>go</button>
					{count.value > 0 && <i data-total={total}>x</i>}
				</section>;
			}
			export function App() { return <Inner p={p.value} />; }`;
		const click = (m, root) => root.querySelector('button').dispatchEvent(new Event('click'));
		const runs = await equivalent(code, [m => (m.p.value = 1), click, click], { hooks: true });
		assert.match(runs.babel.html.at(-1), /data-total="3"/);
	});

	test('properties read from an object are the inputs, unless a method is called', async () => {
		const code = `${PRELUDE}
			class Item { constructor(n) { this.n = n; } label() { return 'n' + this.n; } }
			const items = [new Item(1), new Item(2)];
			export function Row(props) {
				const [tick, setTick] = useState(0);
				stats.rerender = () => setTick(t => t + 1);
				const item = items[tick % 2];
				return <p data-tick={tick} title={track(props.title + count.value)}>
					{track(item.label() + count.value)}{new Item(props.n).n + count.value}{props.title.length + count.value}
				</p>;
			}
			export function App() { return <Row title="t" n={1} />; }`;
		const deps = depsOf(code);
		const expected = ['track, props.title, count', 'track, item, count', 'Item, props.n, count', 'props.title, count'];
		assert.deepEqual(deps.babel, expected);
		assert.deepEqual(deps.rolldown, expected);
		const runs = await equivalent(
			code,
			[m => m.stats.rerender(), m => m.stats.rerender(), m => (m.count.value = 2)],
			{}
		);
		// The title hole evaluates on mount and for the write. The item hole
		// takes `item` as a whole, an object, so it evaluates every render,
		// and for the write.
		assert.equal(runs.babel.stats.evals, 2 + 4);
		assert.equal(runs.rolldown.stats.evals, 2 + 4);
	});

	test('scopes that read outside their inputs are not reused', async () => {
		const code = `import { signal } from '@preact/signals';
			import { useRef } from 'preact/hooks';
			import { Component } from 'preact';
			const count = signal(1);
			function Child() { return null; }
			export class Klass extends Component {
				render() { return <p>{this.props.a + count.value}</p>; }
			}
			export function App({ a }) {
				const ref = useRef(0);
				return <div ref={ref}>
					{Date.now() + count.value}
					{Math.random() + count.value}
					{Math.max(a, count.value)}
					{ref.current + count.value}
					<i onClick={() => ref.current++}>{count.value}</i>
					{count.value && <Child a={a} />}
					{arguments.length + count.value}
				</div>;
			}`;
		const deps = depsOf(code);
		// `ref` is an object input, which the runtime never reuses with.
		// Without hooks a ref is any object: its `.current` is the input.
		const expected = [null, null, null, 'a, count', 'ref.current, count', 'count', null, null];
		assert.deepEqual(deps.babel, expected);
		assert.deepEqual(deps.rolldown, expected);
		// With hooks the analysis knows refs: never an input, unless `.current`
		// is read while evaluating.
		const withHooks = depsOf(code, { hooks: true });
		assert.deepEqual(withHooks.babel.slice(4, 6), [null, 'count']);
		assert.deepEqual(withHooks.rolldown.slice(4, 6), [null, 'count']);
		// Component elements are reusable once `hoistComponents` opts into memo().
		const hoisted = depsOf(code, { hoistComponents: true });
		assert.equal(hoisted.babel[6], 'count, Child, a');
		assert.equal(hoisted.rolldown[6], 'count, Child, a');
	});

	test('outside a render, a hole is just a computed', async () => {
		const { $hole, $sites } = await import('../packages/runtime/src/signals.js');
		const { signal } = await import('@preact/signals');
		const [site] = $sites(1);
		const s = signal(1);
		const a = $hole(() => s.value, [s], site);
		const b = $hole(() => s.value, [s], site);
		assert.notEqual(a, b);
		assert.equal(b.value, 1);
	});

	test('a commit ends the render a scope can be reused in', async () => {
		const code = `${PRELUDE}
			export const outer = signal(true);
			export function App() {
				return <div>{outer.value && <p>{track(count.value)}</p>}</div>;
			}`;
		for (const via of ['babel', 'rolldown']) {
			const { module } = await load(code, via, {});
			const root = document.createElement('div');
			render(h(module.App, null), root);
			module.outer.value = false;
			await settle();
			module.outer.value = true;
			await settle();
			module.count.value = 2;
			await settle();
			assert.equal(root.innerHTML, '<div><p>2</p></div>', via);
			render(null, root);
		}
	});
});
