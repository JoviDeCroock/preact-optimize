// Regressions from the 2026-10-21 review council: each case renders the
// same through the untransformed code and every plugin.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';
import { canonical, compile, container, equivalent, load, settle } from './harness.mjs';

describe('block values', () => {
	const P = `import { signal } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const stats = {};`;
	const O = { blocks: true };

	test('B1: value={null} after a string value', async () => {
		const code = `${P}
	export function App() {
	  const [v, setV] = useState('x');
	  stats.set = setV;
	  return <div><input value={v} /><span>{String(v)}</span></div>;
	}`;
		const runs = await equivalent(code, [m => m.stats.set(null)], O);
		for (const via of ['babel', 'rolldown'])
			assert.equal(runs[via].root.querySelector('input').value, runs.none.root.querySelector('input').value, via);
	});

	test('B2: progress value 0', async () => {
		const code = `${P}
	export function App() {
	  const [v, setV] = useState(0);
	  stats.set = setV;
	  return <div><progress value={v} max={10} /><span>{v}</span></div>;
	}`;
		const runs = await equivalent(code, [m => m.stats.set(0)], O);
		for (const via of ['babel', 'rolldown']) assert.equal(runs[via].root.innerHTML, runs.none.root.innerHTML, via);
	});

	test('B2b: progress value removed', async () => {
		const code = `${P}
	export function App() {
	  const [v, setV] = useState(3);
	  stats.set = setV;
	  return <div><progress value={v} max={10} /><span>{String(v)}</span></div>;
	}`;
		await equivalent(code, [m => m.stats.set(null), m => m.stats.set(0)], O);
	});

	test('B2c: a static prop that starts with o is no listener', async () => {
		const code = `${P}
	export function App() {
	  const [v, setV] = useState('a');
	  stats.set = setV;
	  return <details open><summary>{v}</summary><p>x</p></details>;
	}`;
		const runs = await equivalent(code, [m => m.stats.set('b')], O);
		for (const via of ['babel', 'rolldown']) assert.equal(runs[via].root.firstChild.open, true, via);
	});

	test('B3: function as text child', async () => {
		const code = `${P}
	const f = () => 1;
	export function App() {
	  const [v] = useState(f);
	  return <div><b>{v}</b><i>{v === f ? 'a' : 'b'}</i></div>;
	}`;
		await equivalent(code, [], O);
	});

	test('B3b: function value in text slot', async () => {
		const code = `${P}
	function Inner({ fn }) { return <div><b>{fn}</b><i>x</i></div>; }
	export function App() { return <Inner fn={() => 1} />; }`;
		await equivalent(code, [], O);
	});

	test('B4: checked={null}', async () => {
		const code = `${P}
	export function App() {
	  const [v, setV] = useState(true);
	  stats.set = setV;
	  return <div><input type="checkbox" checked={v} /><span>{String(v)}</span></div>;
	}`;
		const runs = await equivalent(code, [m => m.stats.set(null)], O);
		for (const via of ['babel', 'rolldown'])
			assert.equal(runs[via].root.querySelector('input').checked, runs.none.root.querySelector('input').checked, via);
	});
});

describe('block templates', () => {
	const P = `import { signal } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const sig = signal('s');
	export const stats = {};`;
	const O = { blocks: true };

	test('T1: two block templates, same root tag, conditional', async () => {
		const code = `${P}
	export function App() {
	  const [a, setA] = useState(true);
	  const [x, setX] = useState('x');
	  stats.flip = () => setA(v => !v);
	  stats.set = setX;
	  return a
	    ? <div class="a" title={x}><p>{x}</p><p>one</p></div>
	    : <div id="b" data-x={x}><span>{x}</span><span>two</span></div>;
	}`;
		await equivalent(code, [m => m.stats.flip(), m => m.stats.set('y'), m => m.stats.flip(), m => m.stats.flip()], O);
	});

	test('T2: text slot becomes a vnode and back (fallback)', async () => {
		const code = `${P}
	export function App() {
	  const [x, setX] = useState('x');
	  stats.set = setX;
	  return <div class="r" title={typeof x}><p>{x}</p><p>one</p></div>;
	}`;
		await equivalent(
			code,
			[m => m.stats.set('y'), m => m.stats.set(['a', 'b']), m => m.stats.set('z'), m => m.stats.set(null)],
			O
		);
	});

	test('T3: block <-> plain same tag', async () => {
		const code = `${P}
	export function App() {
	  const [a, setA] = useState(true);
	  const [x, setX] = useState('x');
	  stats.flip = () => setA(v => !v);
	  return a
	    ? <ul class="a"><li>{x}</li><li>one</li></ul>
	    : <ul class="a">{[1,2].map(i => <li key={i}>{i}</li>)}</ul>;
	}`;
		await equivalent(code, [m => m.stats.flip(), m => m.stats.flip(), m => m.stats.flip()], O);
	});

	test('T4: reactive text slot gets vnode from signal', async () => {
		const code = `${P}
	export function App() {
	  return <div class="r"><p>{sig.value}</p><p>one</p></div>;
	}`;
		await equivalent(
			code,
			[m => (m.sig.value = 'q'), m => (m.sig.value = ['a', 'b']), m => (m.sig.value = 'z'), m => (m.sig.value = 0)],
			O
		);
	});

	test('T5: attribute removed between renders (style object, class undefined)', async () => {
		const code = `${P}
	export function App() {
	  const [a, setA] = useState(true);
	  stats.flip = () => setA(v => !v);
	  return <div class={a ? 'on' : undefined} style={a ? { color: 'red', top: 1 } : { color: 'blue' }} aria-hidden={a ? false : undefined}><p>{String(a)}</p><p>one</p></div>;
	}`;
		await equivalent(code, [m => m.stats.flip(), m => m.stats.flip()], O);
	});

	test('T6: listener toggled, event count', async () => {
		const code = `${P}
	export function App() {
	  const [n, setN] = useState(0);
	  stats.n = n;
	  return <div><button onClick={n < 2 ? () => setN(n + 1) : null}>{n}</button><p>x</p></div>;
	}`;
		await equivalent(
			code,
			[
				(m, r) => r.querySelector('button').click(),
				(m, r) => r.querySelector('button').click(),
				(m, r) => r.querySelector('button').click()
			],
			O
		);
	});

	test('T7: keyed list of blocks reorder', async () => {
		const code = `${P}
	export function App() {
	  const [rows, setRows] = useState([1,2,3]);
	  stats.set = setRows;
	  return <table><tbody>{rows.map(id => <tr key={id}><td>{id}</td><td>{'r' + id}</td></tr>)}</tbody></table>;
	}`;
		await equivalent(code, [m => m.stats.set([3, 1, 2]), m => m.stats.set([2]), m => m.stats.set([4, 2, 5])], O);
	});
});

describe('block errors and lazy slots', () => {
	const P = `import { signal } from '@preact/signals';
	import { Component } from 'preact';
	import { useState } from 'preact/hooks';
	export const sig = signal('s');
	export const stats = { runs: 0 };
	const track = v => (stats.runs++, v);`;
	const O = { blocks: true };

	test('L1: block before a throwing sibling inside error boundary', async () => {
		const code = `${P}
	class Boundary extends Component {
	  state = { err: null };
	  static getDerivedStateFromError(err) { return { err: String(err) }; }
	  render() { return this.state.err ? <p>error</p> : this.props.children; }
	}
	function Boom() { throw new Error('x'); }
	function Row() { return <div class="r"><p>{track(sig.value)}</p><p>one</p></div>; }
	export function App() {
	  return <Boundary><Row /><Boom /></Boundary>;
	}`;
		const runs = await equivalent(
			code,
			[
				m => {
					m.stats.runs = 0;
					m.sig.value = 'q';
				},
				m => (m.sig.value = 'w')
			],
			O
		);
		for (const via of ['babel', 'rolldown']) assert.equal(runs[via].stats.runs, runs.none.stats.runs, via);
	});

	test('L2: slot read via var loop', async () => {
		const code = `${P}
	export function App() {
	  const out = [];
	  for (var i = 0; i < 2; i++) out.push(<li key={i} class="x"><b>{sig.value}</b><i>{i}</i></li>);
	  return <ul>{out}</ul>;
	}`;
		await equivalent(code, [m => (m.sig.value = 'q')], O);
	});

	test('L3: slot with mixed reactive closure var', async () => {
		const code = `${P}
	export function App() {
	  const out = [];
	  for (var i = 0; i < 2; i++) out.push(<li key={i} class="x"><b>{sig.value + i}</b><i>z</i></li>);
	  return <ul>{out}</ul>;
	}`;
		await equivalent(code, [m => (m.sig.value = 'q')], O);
	});
});

describe('block listeners and inputs', () => {
	const P = `import { signal } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const mode = signal('a');
	export const text = signal('hi');
	export const stats = { log: [] };
	const fa = () => stats.log.push('a');
	const fb = () => stats.log.push('b');`;
	const O = { blocks: true, hooks: true };

	test('E1: on* slot reading a signal at render', async () => {
		const code = `${P}
	export function App() {
	  return <div><button onClick={mode.value === 'a' ? fa : fb}>{mode.value}</button><p>x</p></div>;
	}`;
		await equivalent(
			code,
			[
				(m, r) => r.querySelector('button').click(),
				m => (m.mode.value = 'b'),
				(m, r) => r.querySelector('button').click(),
				(m, r) => (r.querySelector('p').textContent = m.stats.log.join())
			],
			O
		);
	});

	test('E2: controlled input from signal, user types, signal unchanged', async () => {
		const code = `${P}
	export function App() {
	  return <div><input value={text.value} onInput={e => { if (e.currentTarget.value.length < 4) text.value = e.currentTarget.value; }} /><p>{text.value}</p></div>;
	}`;
		const type = v => (m, r) => {
			const i = r.querySelector('input');
			i.value = v;
			i.dispatchEvent(new InputEvent('input', { bubbles: true }));
			r.querySelector('p').title = i.value;
		};
		await equivalent(code, [type('hey'), type('heyyy'), m => (m.text.value = 'x')], O);
	});

	test('E3: controlled input from useState with rejecting handler', async () => {
		const code = `${P}
	export function App() {
	  const [v, setV] = useState('hi');
	  return <div><input value={v} onInput={e => { if (e.currentTarget.value.length < 4) setV(e.currentTarget.value); else setV(v); }} /><p>{v}</p></div>;
	}`;
		const type = v => (m, r) => {
			const i = r.querySelector('input');
			i.value = v;
			i.dispatchEvent(new InputEvent('input', { bubbles: true }));
		};
		const read = (m, r) => {
			r.querySelector('p').title = r.querySelector('input').value;
		};
		await equivalent(code, [type('hey'), read, type('heyyy'), read], O);
	});
});

describe('block first-render errors', () => {
	const P = `import { signal } from '@preact/signals';
	import { Component } from 'preact';
	export const user = signal(null);
	export const stats = {};
	class Boundary extends Component {
	  state = { err: null };
	  static getDerivedStateFromError(err) { return { err: err.constructor.name }; }
	  render() { return this.state.err ? <p>caught {this.state.err}</p> : this.props.children; }
	}`;

	test('X1: reactive attribute slot throws on first render', async () => {
		const code = `${P}
	function Card() { return <div class="card" title={user.value.name}><p>a</p><p>b</p></div>; }
	export function App() { return <Boundary><Card /></Boundary>; }`;
		await equivalent(code, [], { blocks: true });
	});
	test('X1-noblocks', async () => {
		const code = `${P}
	function Card() { return <div class="card" title={user.value.name}><p>a</p><p>b</p></div>; }
	export function App() { return <Boundary><Card /></Boundary>; }`;
		await equivalent(code, [], {});
	});
});

describe('converted memo dependencies', () => {
	const P = `import { signal } from '@preact/signals';
	import { useState, useMemo, useCallback, useEffect } from 'preact/hooks';
	export const stats = {};`;
	const O = { hooks: true };

	test('H1: useMemo with an unlisted prop, then converted dep changes', async () => {
		const code = `${P}
	function C({ prefix }) {
	  const [x, setX] = useState(0);
	  stats.setX = setX;
	  const label = useMemo(() => prefix + x, [x]);
	  return <p>{label}</p>;
	}
	export function App() {
	  const [p, setP] = useState('a');
	  stats.setP = setP;
	  return <div data-p={p}><C prefix={p} /></div>;
	}`;
		await equivalent(code, [m => m.stats.setP('b'), m => m.stats.setX(1)], O);
	});

	test('H2: useMemo with render-created fn not listed', async () => {
		const code = `${P}
	function C({ digits }) {
	  const [x, setX] = useState(1.2345);
	  stats.setX = setX;
	  const fmt = v => v.toFixed(digits);
	  const shown = useMemo(() => fmt(x), [x]);
	  return <p>{shown}</p>;
	}
	export function App() {
	  const [d, setD] = useState(1);
	  stats.setD = setD;
	  return <div data-d={d}><C digits={d} /></div>;
	}`;
		await equivalent(code, [m => m.stats.setD(3), m => m.stats.setX(2.71828)], O);
	});
});

describe('block realms', () => {
	test('blocks rendered into another realm (iframe/popup document)', async () => {
		const other = new JSDOM('<!doctype html><body></body>').window.document;
		const seen = [];
		const code = `import { useState } from 'preact/hooks';
	export function App() { const [x] = useState('hi'); return <div class="r"><p>{x}</p><p>two</p></div>; }`;
		for (const via of ['none', 'babel']) {
			const { module } = await load(code, via, { blocks: true });
			const root = other.createElement('div');
			other.body.appendChild(root);
			render(h(module.App, null), root);
			await settle();
			seen.push(root.innerHTML);
			render(null, root);
		}
		assert.equal(seen[0], '<div class="r"><p>hi</p><p>two</p></div>');
		assert.equal(seen[1], seen[0]);
	});
});

describe('eager guards', () => {
	const P = `import { signal } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const flag = signal(false);
	export const count = signal(1);
	export const stats = {};`;

	test('A: short-circuit guarded property read evaluated eagerly as dep', async () => {
		const code = `${P}
	function Inner({ row }) { return <p>{flag.value && row.id}</p>; }
	export function App() { return <Inner row={null} />; }`;
		await equivalent(code, [m => (m.flag.value = false)], {});
	});

	test('B: hole closes over a reassigned local (var in loop)', async () => {
		const code = `${P}
	export function App() {
	  const out = [];
	  for (var i = 0; i < 2; i++) out.push(<li>{count.value + i}</li>);
	  return <ul>{out}</ul>;
	}`;
		await equivalent(code, [m => (m.count.value = 5)], {});
	});

	test('C: hole closes over a let reassigned after the JSX', async () => {
		const code = `${P}
	export function App() {
	  let label = 'a';
	  const p = <p>{count.value + label}</p>;
	  label = 'b';
	  return <div>{p}<span>{label}</span></div>;
	}`;
		await equivalent(code, [m => (m.count.value = 5)], {});
	});

	test('D: optional chained guard', async () => {
		const code = `${P}
	function Inner({ row }) { return <p>{flag.value ? row.id : 'none'}</p>; }
	export function App() { return <Inner row={undefined} />; }`;
		await equivalent(code, [m => (m.flag.value = false)], {});
	});
});

describe('reassigned locals', () => {
	const P = `import { signal } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const flag = signal(false);
	export const count = signal(1);
	export const items = signal([1,2]);
	export const stats = {};`;

	test('E: hooks converted loading guard + null data', async () => {
		const code = `${P}
	export function App() {
	  const [loading, setLoading] = useState(true);
	  const [data, setData] = useState(null);
	  stats.load = () => { setData({ title: 'hi' }); setLoading(false); };
	  return <div>{loading ? 'loading' : data.title}</div>;
	}`;
		await equivalent(code, [m => m.stats.load()], { hooks: true });
	});

	test('F: TDZ via closure in hole referencing later const', async () => {
		const code = `${P}
	export function App() {
	  const list = <ul>{items.value.map(i => <li onClick={() => select(i)}>{i}</li>)}</ul>;
	  const select = i => (stats.sel = i);
	  return list;
	}`;
		await equivalent(code, [], {});
	});

	test('G: running total captured by hole inside map', async () => {
		const code = `${P}
	export function App() {
	  let total = 0;
	  const rows = [1, 2, 3].map(n => { total += n; return <li>{flag.value ? total : n}</li>; });
	  return <ul>{rows}</ul>;
	}`;
		await equivalent(code, [m => (m.flag.value = true)], {});
	});

	test('H: getter with side effects evaluated as dep', async () => {
		const code = `${P}
	let n = 0;
	const obj = { get next() { return ++n; } };
	export function App() {
	  return <p>{count.value}:{flag.value ? 'x' : obj.next}</p>;
	}`;
		await equivalent(code, [m => (m.flag.value = true), m => (m.flag.value = false)], {});
	});
});

describe('in-place mutation', () => {
	const P = `import { signal } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const user = signal({ name: 'a' });
	export const todos = signal(['x']);
	export const stats = {};`;

	test('I: signal value mutated in place, then unrelated re-render', async () => {
		const code = `${P}
	export function App() {
	  const [t, setT] = useState(0);
	  stats.bump = () => setT(t => t + 1);
	  return <p data-t={t}>{user.value.name}</p>;
	}`;
		await equivalent(
			code,
			[
				m => {
					m.user.value.name = 'b';
					m.stats.bump();
				}
			],
			{}
		);
	});

	test('J: signal array pushed in place, then re-render (length)', async () => {
		const code = `${P}
	export function App() {
	  const [t, setT] = useState(0);
	  stats.bump = () => setT(t => t + 1);
	  return <p data-t={t}>{todos.value.length} items</p>;
	}`;
		await equivalent(
			code,
			[
				m => {
					m.todos.value.push('y');
					m.stats.bump();
				}
			],
			{}
		);
	});
});

describe('converted guards', () => {
	const P = `import { signal } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const flag = signal(false);
	export const stats = {};`;

	test('K2: converted object state mutated in place, re-render from an unconverted hook', async () => {
		const code = `${P}
	export function App() {
	  const [form] = useState(() => ({ name: 'a' }));
	  const [t, setT] = useState(0);
	  stats.form = form;
	  stats.bump = () => setT(t => t + 1);
	  if (t > 5) return null;
	  return <p>{form.name}{t}</p>;
	}`;
		await equivalent(
			code,
			[
				m => {
					m.stats.form.name = 'b';
					m.stats.bump();
				}
			],
			{ hooks: true }
		);
	});

	test('L: render-prop helper called in render, snapshot of converted state', async () => {
		const code = `${P}
	export function App() {
	  const [sel, setSel] = useState(1);
	  stats.set = setSel;
	  const renderRow = id => <li>{sel === id ? 'sel' : 'no'}</li>;
	  return <ul>{renderRow(1)}{renderRow(2)}</ul>;
	}`;
		await equivalent(code, [m => m.stats.set(2)], { hooks: true });
	});

	test('M: TDZ rolldown too + function hoisting', async () => {
		const code = `${P}
	export const items = signal([1]);
	export function App() {
	  const list = <ul>{items.value.map(i => <li onClick={() => select(i)}>{i}</li>)}</ul>;
	  const select = i => (stats.sel = i);
	  return list;
	}`;
		await equivalent(code, [], {});
	});
});

describe('render-prop snapshots', () => {
	const P = `import { signal } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const stats = {};`;

	test('E2: hooks: converted loading flag guards an unconverted null object', async () => {
		const code = `${P}
	function Debug({ d }) { return null; }
	export function App() {
	  const [loading, setLoading] = useState(true);
	  const [data, setData] = useState(null);
	  stats.load = () => { setData({ title: 'hi' }); setLoading(false); };
	  return <div><button onClick={() => setLoading(!loading)}>t</button><h1>{loading ? 'Loading' : data.title}</h1><Debug d={data} /></div>;
	}`;
		await equivalent(code, [m => m.stats.load()], { hooks: true });
	});
});

describe('nullable props', () => {
	test('A-hooks: converted open flag guards a nullable prop', async () => {
		const code = `import { useState } from 'preact/hooks';
	function Popover({ item }) {
	  const [open, setOpen] = useState(false);
	  return <div><button onClick={() => setOpen(!open)}>toggle</button><p>{open ? item.name : 'closed'}</p></div>;
	}
	export function App() { return <Popover item={null} />; }`;
		await equivalent(code, [], { hooks: true });
	});
});

describe('peek and untracked', () => {
	const P = `import { signal, untracked } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const count = signal(1);
	export const other = signal('a');
	export const stats = {};`;
	test('P1: peek() inside a reused hole', async () => {
		const code = `${P}
	export function App() {
	  const [t, setT] = useState(0);
	  stats.bump = () => setT(t => t + 1);
	  return <p data-t={t}>{count.value + other.peek()}</p>;
	}`;
		await equivalent(
			code,
			[
				m => {
					m.other.value = 'b';
					m.stats.bump();
				}
			],
			{}
		);
	});
	test('P2: untracked() inside a reused hole', async () => {
		const code = `${P}
	export function App() {
	  const [t, setT] = useState(0);
	  stats.bump = () => setT(t => t + 1);
	  return <p data-t={t}>{count.value + untracked(() => other.value)}</p>;
	}`;
		await equivalent(
			code,
			[
				m => {
					m.other.value = 'b';
					m.stats.bump();
				}
			],
			{}
		);
	});
});

describe('hole syntax', () => {
	const P = `import { signal } from '@preact/signals';
	import { useState } from 'preact/hooks';
	export const sig = signal(2);
	export const stats = {};`;
	const cases = {
		iifeVar: `{(() => { for (var q = 0; q < 1; q++); return sig.value + q; })()}`,
		fnDecl: `{(() => { return g(sig.value); function g(v) { return v * 2; } })()}`,
		catchParam: `{(() => { try { throw sig.value; } catch (err) { return err; } })()}`,
		namedFnExpr: `{(function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); })(sig.value)}`,
		classExpr: `{new (class K { v() { return sig.value + (K ? 1 : 0); } })().v()}`,
		labeled: `{(() => { outer: for (const a of [1]) { break outer; } return sig.value; })()}`,
		argumentsUse: `{(function () { return arguments[0] + sig.value; })(1)}`,
		destructDefault: `{(({ a = sig.value } = {}) => a)()}`,
		importMeta: `{typeof sig.value}`
	};
	for (const [name, expr] of Object.entries(cases)) {
		test(name, async () => {
			const code = `${P}
	export function App() { return <p>{'x'}{${expr.slice(1, -1)}}</p>; }`;
			await equivalent(code, [m => (m.sig.value = 3)], {});
		});
	}
});

describe('codex review', () => {
	/** Run steps against every variant; `probe(root, module)` returns what to compare. */
	async function compare(code, steps, options, probe = root => canonical(root.innerHTML)) {
		const out = {};
		for (const via of ['none', 'babel', 'rolldown']) {
			const { module } = await load(code, via, options);
			const root = container();
			const seen = [];
			try {
				for (const step of steps) {
					await step(module, root, props => render(h(module.App, props), root));
					await settle();
					seen.push(probe(root, module));
				}
			} catch (e) {
				seen.push('THROW ' + e.message);
			}
			render(null, root);
			out[via] = seen;
		}
		assert.deepEqual(out.babel, out.none, 'babel');
		assert.deepEqual(out.rolldown, out.none, 'rolldown');
	}

	test('1 guarded property read', () =>
		compare(
			`import {signal} from '@preact/signals';
			const s = signal(0);
			export function App({show=false, row=null}) { return <p>{show && row.name + s.value}</p>; }`,
			[(m, r, rr) => rr({})],
			{}
		));

	test('2 hoisted leaf with signal attribute', () =>
		compare(
			`import {signal} from '@preact/signals';
			export const s = signal('a');
			export function App({tick}) { return <div data-t={tick}><p title={s}>x</p></div>; }`,
			[(m, r, rr) => rr({ tick: 0 }), (m, r, rr) => rr({ tick: 1 }), m => (m.s.value = 'b')],
			{}
		));

	test('3 property reuse keeps an obsolete object', () => {
		let A;
		return compare(
			`import {signal} from '@preact/signals';
			export const s = signal(0);
			export function App({row}) { return <p>{s.value + row.name}</p>; }`,
			[
				(m, r, rr) => rr({ row: (A = { name: 'a' }) }),
				(m, r, rr) => rr({ row: { name: 'a' } }),
				m => ((A.name = 'OLD'), (m.s.value = 1))
			],
			{}
		);
	});

	test('4 duplicate dynamic attributes', () =>
		compare(
			`import {signal} from '@preact/signals';
			export const s = signal(0);
			export function App({a='a', b='b'}) { return <p title={a} title={b}>{s.value}<i/></p>; }`,
			[(m, r, rr) => rr({}), m => (m.s.value = 1)],
			{ blocks: true }
		));

	test('5 textContent with children', () =>
		compare(
			`export function App({n='x'}) { return <div textContent="prefix"><b>{n}</b></div>; }`,
			[(m, r, rr) => rr({})],
			{ blocks: true }
		));

	test('6 null value keeps typed input', () =>
		compare(
			`export function App({v='a'}) { return <p><input value={v}/><input type="checkbox" checked={v}/>{v}</p>; }`,
			[(m, r, rr) => rr({}), (m, r) => (r.querySelector('input').value = 'typed'), (m, r, rr) => rr({ v: null })],
			{ blocks: true },
			root => [...root.querySelectorAll('input')].map(i => i.value + ':' + i.checked).join()
		));

	test('7 static media property', () =>
		compare(
			`export function App({n=1}) { return <div><video volume={0}/>{n}</div>; }`,
			[(m, r, rr) => rr({})],
			{ blocks: true },
			root => root.querySelector('video').volume
		));

	test('8 progress value 0', () =>
		compare(`export function App({n=1}) { return <div><progress value={0}/>{n}</div>; }`, [(m, r, rr) => rr({})], {
			blocks: true
		}));

	test('9 MathML integration point namespace', () =>
		compare(
			`export function App({n='x'}) { return <div><math><mrow><mi><span>{n}</span></mi><mo>+</mo></mrow></math></div>; }`,
			[(m, r, rr) => rr({})],
			{ blocks: true },
			root => root.querySelector('span').namespaceURI
		));

	test('10 function child', () =>
		compare(`export function App({n=()=>null}) { return <p>{n}<i/></p>; }`, [(m, r, rr) => rr({})], { blocks: true }));

	test('11 listeners after unmount', () =>
		compare(
			`export const stats = { n: 0 };
			export function App() { return <p><button onClick={() => stats.n++}>click</button>{stats.n}</p>; }`,
			[
				(m, r, rr) => rr({}),
				(m, r) => {
					const b = r.querySelector('button');
					render(null, r);
					b.click();
				}
			],
			{ blocks: true },
			(root, m) => m.stats.n
		));
});

describe('follow-ups', () => {
	const P = `import { signal } from '@preact/signals';
	import { useRef, useState, useEffect } from 'preact/hooks';
	export const num = signal(0);
	export const sig = signal('s');
	export const stats = {};`;
	const ALL = [{}, { hooks: true }, { blocks: true }, { hooks: true, hoistComponents: true, blocks: true }];

	test('NaN and 0n in a text hole render like Preact', async () => {
		const code = `${P}
	export function App() { return <div><p>{sig.value}</p><i>{num.value}</i></div>; }`;
		const steps = [
			m => (m.num.value = NaN),
			m => (m.num.value = 0n),
			m => (m.sig.value = h('b', null, 'vn')),
			m => (m.num.value = NaN)
		];
		for (const options of ALL) await equivalent(code, steps, options);
	});

	test('NaN returned from a component renders like Preact', async () => {
		const code = `${P}
	function N() { return num.value; }
	export function App() { return <div><N /></div>; }`;
		for (const options of ALL) await equivalent(code, [m => (m.num.value = NaN), m => (m.num.value = 1n)], options);
	});

	test('a property written after the JSX stays a render-time read', async () => {
		const code = `${P}
	export function App({ n = 1 }) {
	  const o = { v: n };
	  const el = <p>{o.v + num.value}</p>;
	  o.v = 999;
	  return el;
	}`;
		for (const options of ALL) await equivalent(code, [m => (m.num.value = 1)], options);
	});

	test('a running total read by holes inside a map', async () => {
		const code = `${P}
	export function App() {
	  let total = 0;
	  return <ul>{[1, 2, 3].map(x => { total += x; return <li>{total + num.value}</li>; })}</ul>;
	}`;
		for (const options of ALL) await equivalent(code, [m => (m.num.value = 10)], options);
	});

	test('mutating a ref does not keep the state its element reads', async () => {
		const code = `${P}
	export function App() {
	  const [name, setName] = useState('a');
	  const el = useRef();
	  stats.set = setName;
	  useEffect(() => { el.current.dataset.seen = 'yes'; }, []);
	  return <input ref={el} value={name} onInput={e => setName(e.currentTarget.value)} />;
	}`;
		const reports = {};
		await compile(code, 'babel', { hooks: true, report: (_, report) => (reports.babel = report) });
		assert.deepEqual(reports.babel.keptState, []);
		await equivalent(code, [m => m.stats.set('b')], { hooks: true });
	});
});
