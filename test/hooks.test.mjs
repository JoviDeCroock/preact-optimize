import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { h, render } from 'preact';
import { equivalent, load } from './harness.mjs';

const HOOKS = { hooks: true };

const click = (m, root, selector = 'button') => root.querySelector(selector).dispatchEvent(new Event('click'));

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

	test('effects, component props, derived and spread reads all move', async () => {
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
		// Every read can move: `a` becomes an effect source, `b` moves with
		// the <Child> element, `c` with the derived `label`, `d` with the
		// spread <span>.
		await transformed(code, { a: true, b: true, c: true, d: true });
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
			[
				m => m.stats.set(1),
				m => m.stats.setOther('abcd'),
				m => m.stats.set(2),
				(m, root) => render(null, root),
				m => m.stats.set(3)
			],
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

describe('effects, memos and callbacks', () => {
	const code = `import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
		export const stats = { renders: 0, passive: [], layout: [], cleanups: [] };
		export function App() {
			stats.renders++;
			const [n, setN] = useState(0);
			const [label, setLabel] = useState('a');
			const out = useRef();
			const doubled = useMemo(() => n * 2, [n]);
			const inc = useCallback(() => setN(n + 1), [n]);
			useEffect(() => {
				stats.passive.push(n + label);
				return () => stats.cleanups.push(n);
			}, [n, label]);
			useLayoutEffect(() => {
				stats.layout.push(out.current.textContent);
			}, [doubled]);
			return <div>
				<output ref={out}>{n}/{doubled}</output>
				<button class="inc" onClick={inc}>+</button>
				<button class="label" onClick={() => setLabel(label + 'a')}>{label}</button>
			</div>;
		}`;

	test('state behind memo, callback and effect dependencies converts', async () => {
		await transformed(code, { n: true, label: true, doubled: true });
		for (const via of ['babel', 'rolldown']) {
			const { code: out } = await load(code, via, HOOKS);
			assert.match(out, /\$useEffect\)?\(/, via);
			assert.match(out, /\$useLayoutEffect\)?\(/, via);
			assert.match(out, /\$useMemo\)?\(/, via);
		}
		const runs = await equivalent(
			code,
			[
				(m, root) => click(m, root, '.inc'),
				(m, root) => click(m, root, '.inc'),
				(m, root) => click(m, root, '.label'),
				(m, root) => {
					click(m, root, '.inc');
					click(m, root, '.label');
				}
			],
			HOOKS
		);
		for (const via of ['babel', 'rolldown']) {
			const { renders, ...effects } = runs[via].stats;
			const { renders: _, ...expected } = runs.none.stats;
			assert.deepEqual(effects, expected, via);
			assert.equal(renders, 1, via);
		}
		assert.deepEqual(runs.none.stats.layout, ['0/0', '1/2', '2/4', '3/6']);
	});

	test('act() flushes converted updates and effects before it returns', async () => {
		const { act } = await import('preact/test-utils');
		const results = {};
		for (const via of ['none', 'babel', 'rolldown']) {
			const { module } = await load(code, via, HOOKS);
			const root = document.createElement('div');
			const html = [];
			act(() => render(h(module.App, null), root));
			html.push(root.innerHTML);
			act(() => click(module, root, '.inc'));
			html.push(root.innerHTML);
			act(() => {
				click(module, root, '.inc');
				click(module, root, '.label');
			});
			html.push(root.innerHTML);
			act(() => render(null, root));
			const { renders, ...effects } = module.stats;
			results[via] = { html, effects };
		}
		assert.deepEqual(results.babel, results.none);
		assert.deepEqual(results.rolldown, results.none);
	});
});

describe('review regressions', () => {
	test('converted state adds no hook state to the component', async () => {
		const code = `import { useEffect, useState } from 'preact/hooks';
			export const seen = {};
			export function App() {
				const [n, setN] = useState(0);
				useEffect(() => { seen.effect = n; }, [n]);
				return <button onClick={() => setN(n + 1)}>{n}</button>;
			}`;
		const { options } = await import('preact');
		for (const via of ['babel', 'rolldown']) {
			const { module } = await load(code, via, HOOKS);
			let component;
			const prev = options.diffed;
			options.diffed = vnode => {
				if (vnode.type === module.App) component = vnode.__c;
				if (prev) prev(vnode);
			};
			const root = document.createElement('div');
			render(h(module.App, null), root);
			options.diffed = prev;
			// No preact/hooks shouldComponentUpdate wrapper, and @preact/signals
			// doesn't see hook state (its HAS_HOOK_STATE flag, 1 << 1).
			assert.equal(Object.hasOwn(component, 'shouldComponentUpdate'), false, via);
			assert.equal(component._updateFlags & 2, 0, via);
			render(null, root);
		}
	});

	test('state with the same name in two components stays separate', async () => {
		const code = `import { useState } from 'preact/hooks';
			function A() {
				const [n, setN] = useState(0);
				return <button class="a" onClick={() => setN(n + 1)}>{n}</button>;
			}
			function B() {
				const [n, setN] = useState(10);
				return <button class="b" onClick={() => setN(n + 1)}>{n}</button>;
			}
			export const App = () => <div><A /><B /></div>;`;
		await transformed(code, { n: true });
		await equivalent(code, [(m, root) => click(m, root, '.a'), (m, root) => click(m, root, '.b')], HOOKS);
	});

	test('dispatch goes through the latest reducer', async () => {
		const code = `import { useReducer, useState } from 'preact/hooks';
			function Counter({ step }) {
				const [n, dispatch] = useReducer(s => s + step, 0);
				return <button class="inc" onClick={() => dispatch()}>{n}</button>;
			}
			export function App() {
				const [step, setStep] = useState(1);
				return <div><i class="step" onClick={() => setStep(10)} /><Counter step={step} /></div>;
			}`;
		await transformed(code, { n: true });
		await equivalent(
			code,
			[(m, root) => click(m, root, '.inc'), (m, root) => click(m, root, '.step'), (m, root) => click(m, root, '.inc')],
			HOOKS
		);
	});

	test('setting NaN again is no update', async () => {
		const code = `import { useEffect, useState } from 'preact/hooks';
			export const stats = { runs: 0 };
			export function App() {
				const [n, setN] = useState(0);
				useEffect(() => {
					stats.runs++;
				}, [n]);
				return <button onClick={() => setN(NaN)}>{Number.isNaN(n) ? 'nan' : n}</button>;
			}`;
		await transformed(code, { n: true });
		const runs = await equivalent(code, [click, click, click], HOOKS);
		for (const via of ['babel', 'rolldown']) assert.equal(runs[via].stats.runs, 2, via);
		assert.equal(runs.none.stats.runs, 2);
	});

	test('an effect without dependencies keeps its state as hooks', async () => {
		const code = `import { useLayoutEffect, useRef, useState } from 'preact/hooks';
			export function App() {
				const [q, setQ] = useState(0);
				const el = useRef();
				const out = useRef();
				useLayoutEffect(() => {
					out.current.textContent = el.current.textContent;
				});
				return <div><button ref={el} onClick={() => setQ(q + 1)}>{q}</button><output ref={out} /></div>;
			}`;
		await transformed(code, { q: false });
		await equivalent(code, [click], HOOKS);
		const reports = [];
		await load(code, 'babel', { ...HOOKS, report: (_, r) => reports.push(r) });
		assert.deepEqual(
			reports[0].keptState.map(k => k.reason),
			['effect-every-render']
		);
	});

	test('`.value` dependencies that are not signals stay dependencies', async () => {
		const code = `import { useEffect, useMemo, useState } from 'preact/hooks';
			export const stats = { runs: [] };
			const fixed = { value: 3 };
			function Child({ field }) {
				const doubled = useMemo(() => field.value * 2 + fixed.value, [field.value, fixed.value]);
				useEffect(() => {
					stats.runs.push(field.value);
				}, [field.value]);
				return <p>{doubled}</p>;
			}
			export function App() {
				const [n, setN] = useState(0);
				return <div><button onClick={() => setN(n + 1)}>{n}</button><Child field={{ value: n }} /></div>;
			}`;
		const runs = await equivalent(code, [click, click], HOOKS);
		for (const via of ['babel', 'rolldown']) {
			assert.deepEqual(runs[via].stats.runs, runs.none.stats.runs, via);
		}
		assert.deepEqual(runs.none.stats.runs, [0, 1, 2]);
	});

	test('parenthesized arrow bodies get their snapshot', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const seen = [];
			export function App() {
				const [n, setN] = useState(0);
				const pack = () => ({ n });
				return <button onClick={() => (seen.push(pack().n), setN(n + 1))}>{n}</button>;
			}`;
		await transformed(code, { n: true });
		const runs = await equivalent(code, [click, click], HOOKS);
		for (const via of ['babel', 'rolldown']) {
			assert.deepEqual(runs[via].module.seen, runs.none.module.seen, via);
		}
	});

	test('TypeScript wrappers around the hook call', async () => {
		const code = `import { useState } from 'preact/hooks';
			export function App() {
				const [n, setN] = useState(0) as [number, (n: number) => void];
				const [m, setM] = useState<number>(5)!;
				return <button onClick={() => { setN(n + 1); setM(m + 1); }}>{n}/{m}</button>;
			}`;
		for (const via of ['babel', 'rolldown']) {
			const { code: out } = await load(code, via, HOOKS, 'tsx');
			assert.match(out, /_n\.value/, via);
			assert.match(out, /_m\.value/, via);
		}
		await equivalent(code, [click, click], HOOKS, 'tsx');
	});

	test('generated names never collide with state names', async () => {
		const code = `import { useState } from 'preact/hooks';
			export function App() {
				const [$hole, setHole] = useState(0);
				const [h1, setH1] = useState(0);
				return <div><b>static</b><button onClick={() => { setHole($hole + 1); setH1(h1 + 2); }}>{$hole}/{h1}</button></div>;
			}`;
		await equivalent(code, [click, click], HOOKS);
	});
});

describe('re-renders that do more than their reads show', () => {
	test('unread state is a re-render trigger', async () => {
		const code = `import { useState } from 'preact/hooks';
			const store = { count: 0 };
			export function App() {
				const [tick, setTick] = useState(0);
				return <button onClick={() => { store.count++; setTick(t => t + 1); }}>{store.count}</button>;
			}`;
		await transformed(code, { tick: false });
		await equivalent(code, [click, click], HOOKS);
	});

	test('a render that reads a ref keeps its state', async () => {
		const code = `import { useRef, useState } from 'preact/hooks';
			export function App() {
				const [value, setValue] = useState('');
				const last = useRef('none');
				const renders = useRef(0);
				renders.current++;
				return <button onClick={() => { last.current = 'edited ' + value; setValue(value + 'x'); }}>
					{value}|{last.current}|{renders.current}
				</button>;
			}`;
		await transformed(code, { value: false });
		await equivalent(code, [click, click], HOOKS);
		const reports = [];
		await load(code, 'babel', { ...HOOKS, report: (_, r) => reports.push(r) });
		assert.deepEqual(
			reports[0].keptState.map(k => k.reason),
			['render-reads-ref']
		);
	});

	test('writing a ref during render is fine', async () => {
		const code = `import { useRef, useState } from 'preact/hooks';
			export function App({ label = 'n' }) {
				const [n, setN] = useState(0);
				const latest = useRef();
				latest.current = label;
				return <button onClick={() => setN(n + 1)}>{n}</button>;
			}`;
		await transformed(code, { n: true });
	});

	test('a callback listed as an effect dependency keeps its state', async () => {
		const code = `import { useCallback, useEffect, useState } from 'preact/hooks';
			export const log = [];
			function Child({ load }) {
				useEffect(() => { log.push('child ' + load()); }, [load]);
				return null;
			}
			export function App() {
				const [query, setQuery] = useState('a');
				const load = useCallback(() => 'q=' + query, [query]);
				useEffect(() => { log.push('parent ' + load()); }, [load]);
				return <div><button onClick={() => setQuery(query + 'b')}>{query}</button><Child load={load} /></div>;
			}`;
		await transformed(code, { query: false });
		const runs = await equivalent(code, [click], HOOKS);
		for (const via of ['babel', 'rolldown']) assert.deepEqual(runs[via].module.log, runs.none.module.log, via);
	});

	test('render props keep their state', async () => {
		const code = `import { useMemo, useState } from 'preact/hooks';
			// Stands in for a library component the plugin never sees.
			function List({ items, renderItem }) {
				return <ul>{items.map(renderItem)}</ul>;
			}
			const items = [{ id: 1 }, { id: 2 }];
			export function App() {
				const [sel, setSel] = useState(1);
				const renderRow = it => <li class={it.id === sel ? 'on' : 'off'}>{it.id}</li>;
				return <div>
					<button onClick={() => setSel(2)}>{sel}</button>
					<List items={items} renderItem={it => <li class={it.id === sel ? 'on' : 'off'}>{it.id}</li>} />
					<List items={items} renderItem={renderRow} />
				</div>;
			}`;
		await transformed(code, { sel: false });
		await equivalent(code, [click], HOOKS);
		const reports = [];
		await load(code, 'babel', { ...HOOKS, report: (_, r) => reports.push(r) });
		assert.deepEqual(
			reports[0].keptState.map(k => k.reason),
			['escaping-closure']
		);
	});

	test('event props and plain handlers still convert', async () => {
		const code = `import { useState } from 'preact/hooks';
			function Button({ onPress, children }) {
				return <button onClick={onPress}>{children}</button>;
			}
			export function App() {
				const [n, setN] = useState(0);
				const reset = () => setN(0);
				function inc() { setN(n + 1); }
				return <div>
					<Button onPress={() => setN(n + 2)}>{n}</Button>
					<i onClick={inc} />
					<b onClick={() => reset()} />
				</div>;
			}`;
		await transformed(code, { n: true });
		await equivalent(code, [click, (m, root) => click(m, root, 'i'), (m, root) => click(m, root, 'b')], HOOKS);
	});

	test('a child setting its own state and its parent’s renders once', async () => {
		const code = `import { useLayoutEffect, useState } from 'preact/hooks';
			export const seen = [];
			function Stepper({ total, onTotal }) {
				const [step, setStep] = useState(1);
				useLayoutEffect(() => { seen.push(step + '/' + total); });
				return <button onClick={() => { setStep(step + 1); onTotal(total + step + 1); }}>{step}</button>;
			}
			export function App() {
				const [total, setTotal] = useState(1);
				return <Stepper total={total} onTotal={setTotal} />;
			}`;
		await transformed(code, { total: true });
		const runs = await equivalent(code, [click, click], HOOKS);
		for (const via of ['babel', 'rolldown']) assert.deepEqual(runs[via].module.seen, runs.none.module.seen, via);
	});
});
