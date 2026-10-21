import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { render } from 'preact';
import { equivalent, load } from './harness.mjs';

const HOOKS = { hooks: true };

const click = (m, root, selector = "button") =>
	root.querySelector(selector).dispatchEvent(new Event('click'));

/** Assert which state names were (or weren't) turned into signals. */
async function transformed(code, expected) {
	for (const via of ['babel', 'rolldown']) {
		const { code: out } = await load(code, via, HOOKS);
		for (const [name, yes] of Object.entries(expected)) {
			const re = new RegExp(`\\b_+${name}\\d*\\.value`);
			assert.equal(re.test(out), yes, `${via}: ${name} ${yes ? 'not ' : ''}transformed\n${out}`);
		}
	}
}

describe('useState → signal', () => {
	test('counter updates without re-rendering', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				const [n, setN] = useState(0);
				return <button onClick={() => setN(n + 1)}>clicked {n}</button>;
			}`;
		await transformed(code, { n: true });
		const runs = await equivalent(code, [click, click, click], HOOKS);
		assert.equal(runs.none.html.at(-1), '<button>clicked 3</button>');
		assert.equal(runs.none.stats.renders, 4);
		assert.equal(runs.babel.stats.renders, 1);
		assert.equal(runs.rolldown.stats.renders, 1);
	});

	test('closures see the committed value until the update flushes', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = { seen: [] };
			export function App() {
				const [n, setN] = useState(0);
				return <button onClick={() => {
					setN(n + 1);
					setN(n + 1);
					stats.seen.push(n);
				}}>{n}</button>;
			}`;
		await transformed(code, { n: true });
		const runs = await equivalent(code, [click, click], HOOKS);
		assert.equal(runs.none.html.at(-1), '<button>2</button>');
		for (const via of ['none', 'babel', 'rolldown']) {
			assert.deepEqual(runs[via].stats.seen, [0, 1], via);
		}
	});

	test('updater functions compose against the pending value', async () => {
		const runs = await equivalent(
			`import { useState } from 'preact/hooks';
			export const stats = {};
			export function App() {
				const [n, setN] = useState(() => 10);
				return <button onClick={() => { setN(c => c + 1); setN(c => c * 2); }}>{n}</button>;
			}`,
			[click, click],
			HOOKS
		);
		assert.equal(runs.none.html.at(-1), '<button>46</button>');
	});

	test('several states in one handler commit together', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = { renders: 0, snapshots: [] };
			export function App() {
				stats.renders++;
				const [a, setA] = useState(0);
				const [b, setB] = useState(0);
				return <button
					title={a + b}
					onClick={() => { setA(a + 1); setB(b + 2); }}
				>{a}:{b}</button>;
			}`;
		await transformed(code, { a: true, b: true });
		const runs = await equivalent(code, [click, click], HOOKS);
		assert.equal(runs.none.html.at(-1), '<button title="6">2:4</button>');
		assert.equal(runs.babel.stats.renders, 1);
	});

	test('controlled input', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				const [text, setText] = useState('');
				return <div>
					<input value={text} onInput={e => setText(e.currentTarget.value.toUpperCase())} />
					<p>{text.length ? text : 'empty'}</p>
				</div>;
			}`;
		await transformed(code, { text: true });
		const type = value => (m, root) => {
			const input = root.querySelector('input');
			input.value = value;
			input.dispatchEvent(new InputEvent('input'));
		};
		const runs = await equivalent(code, [type('ab'), type('abc'), type('')], HOOKS);
		for (const via of ['none', 'babel', 'rolldown']) {
			assert.equal(runs[via].root.querySelector('input').value, '', via);
		}
		assert.deepEqual(
			runs.none.html.map(html => html.match(/<p>(.*)<\/p>/)[1]),
			['empty', 'AB', 'ABC', 'empty']
		);
		assert.equal(runs.none.stats.renders, 4);
		assert.equal(runs.babel.stats.renders, 1);
		assert.equal(runs.rolldown.stats.renders, 1);
	});

	test('useReducer', async () => {
		const code = `import { useReducer } from 'preact/hooks';
			export const stats = { renders: 0 };
			const reducer = (s, a) => a === 'inc' ? { count: s.count + 1 } : s;
			export function App() {
				stats.renders++;
				const [state, dispatch] = useReducer(reducer, 1, n => ({ count: n }));
				return <button onClick={() => dispatch('inc')}>{state.count}</button>;
			}`;
		await transformed(code, { state: true });
		const runs = await equivalent(code, [click, click], HOOKS);
		assert.equal(runs.none.html.at(-1), '<button>3</button>');
		assert.equal(runs.babel.stats.renders, 1);
	});

	test('state passed to components inside a hole re-renders them', async () => {
		const runs = await equivalent(
			`import { useState } from 'preact/hooks';
			export const stats = { renders: 0, child: 0 };
			function Child({ count }) { stats.child++; return <b>{count}</b>; }
			export function App() {
				stats.renders++;
				const [n, setN] = useState(0);
				return <div><button onClick={() => setN(n + 1)}>+</button>{n > 0 && <Child count={n} />}</div>;
			}`,
			[click, click],
			HOOKS
		);
		assert.equal(runs.none.html.at(-1), '<div><button>+</button><b>2</b></div>');
		assert.equal(runs.babel.stats.renders, 1);
		assert.equal(runs.babel.stats.child, 2);
	});

	test('render-time reads keep the hook', async () => {
		const code = `import { useState, useEffect } from 'preact/hooks';
			export const stats = { effects: [] };
			function Child(props) { return <i>{props.n}</i>; }
			export function App() {
				const [a, setA] = useState(0);
				const [b, setB] = useState(0);
				const [c, setC] = useState(0);
				const [d, setD] = useState(0);
				useEffect(() => { stats.effects.push(a); }, [a]);
				const label = 'c=' + c;
				return <button onClick={() => { setA(a + 1); setB(b + 1); setC(c + 1); setD(d + 1); }}>
					<Child n={b} />{label}<span {...{ title: d }} />
				</button>;
			}`;
		await transformed(code, { a: false, b: false, c: false, d: false });
		const runs = await equivalent(code, [click, click], HOOKS);
		for (const via of ['babel', 'rolldown']) {
			assert.deepEqual(runs[via].stats.effects, runs.none.stats.effects, via);
		}
	});

	test('closures called while rendering still subscribe the component', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				const [n, setN] = useState(1);
				const format = () => 'n=' + n;
				return <button title={format()} onClick={() => setN(n * 3)}>{[1, 2].map(i => i * n).join(',')}</button>;
			}`;
		await transformed(code, { n: true });
		const runs = await equivalent(code, [click, click], HOOKS);
		assert.equal(runs.none.html.at(-1), '<button title="n=9">9,18</button>');
	});

	test('shadowed names and shorthand properties', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = { logged: [] };
			export function App() {
				const [n, setN] = useState(0);
				const [items] = useState([10, 20]);
				return <div>
					<ul>{items.map(n => <li key={n}>{n}</li>)}</ul>
					<button onClick={() => { stats.logged.push({ n }); setN(n + 1); }}>{n}</button>
				</div>;
			}`;
		await transformed(code, { n: true, items: true });
		const runs = await equivalent(code, [click, click], HOOKS);
		assert.equal(runs.none.html.at(-1), '<div><ul><li>10</li><li>20</li></ul><button>2</button></div>');
		for (const via of ['none', 'babel', 'rolldown']) {
			assert.deepEqual(runs[via].stats.logged, [{ n: 0 }, { n: 1 }], via);
		}
	});

	test('custom hooks and writable bindings are left alone', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = {};
			function useCounter() {
				const [count, setCount] = useState(0);
				return [count, () => setCount(count + 1)];
			}
			export function App() {
				let [m, setM] = useState(0);
				if (m > 5) m = 5;
				const [count, inc] = useCounter();
				return <button onClick={() => { inc(); setM(m + 1); }}>{count}/{m}</button>;
			}`;
		await transformed(code, { count: false, m: false });
		await equivalent(code, [click, click], HOOKS);
	});

	test('state outlives renders it does not cause', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = { set: null, setOther: null, renders: 0 };
			export function App() {
				stats.renders++;
				const [n, setN] = useState(0);
				const [other, setOther] = useState('x');
				stats.set = setN;
				stats.setOther = setOther;
				return <p data-other={other.length > 3 ? 'long' : other}>{n}</p>;
			}`;
		const runs = await equivalent(
			code,
			[m => m.stats.set(1), m => m.stats.setOther('abcd'), m => m.stats.set(2), (m, root) => render(null, root), m => m.stats.set(3)],
			HOOKS
		);
		assert.equal(runs.babel.stats.renders, 1);
	});

	test('compat imports', async () => {
		const code = `import { useState } from 'preact/compat';
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				const [n, setN] = useState(0);
				return <button onClick={() => setN(n + 1)}>{n}</button>;
			}`;
		await transformed(code, { n: true });
		const runs = await equivalent(code, [click], HOOKS);
		assert.equal(runs.rolldown.stats.renders, 1);
	});

	test('off by default', async () => {
		for (const via of ['babel', 'rolldown']) {
			const { code } = await load(
				`import { useState } from 'preact/hooks';
				export function App() { const [n, setN] = useState(0); return <b onClick={() => setN(1)}>{n}</b>; }`,
				via
			);
			assert.match(code, /useState\)?\(0\)/, via);
		}
	});
});
