import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { h, hydrate, options, render } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { parseSync } from '@babel/core';
import { parseAst } from 'rolldown/parseAst';
import { analyze } from '../packages/runtime/src/compiler.js';
import { canonical, container, equivalent, load, settle } from './harness.mjs';

const BLOCKS = { blocks: true, hooks: true };

const click =
	(selector = 'button') =>
	(m, root) =>
		root.querySelector(selector).dispatchEvent(new Event('click', { bubbles: true }));

/** Compiled output for both plugins. */
async function compiled(code, opts = BLOCKS) {
	const out = {};
	for (const via of ['babel', 'rolldown']) out[via] = (await load(code, via, opts)).code;
	return out;
}

/** How many `$block(` calls each plugin printed. */
async function blockCount(code, opts) {
	const out = await compiled(code, opts);
	return Object.values(out).map(c => (c.match(/\$block\(\[/g) || []).length);
}

describe('blocks', () => {
	test('a keyed list of rows patches slots and reacts to selection', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				const [rows, setRows] = useState([{ id: 1, label: 'a' }, { id: 2, label: 'b' }]);
				const [selected, setSelected] = useState(0);
				stats.set = setRows;
				return <table><tbody>{rows.map(row => {
					const id = row.id;
					return <tr key={id} class={selected === id ? 'danger' : ''}>
						<td class="id">{id}</td>
						<td><a onClick={() => setSelected(id)}>{row.label}</a></td>
						<td><a class="x" onClick={() => setRows(rows.filter(r => r.id !== id))}>x</a></td>
					</tr>;
				})}</tbody></table>;
			}`;
		assert.deepEqual(await blockCount(code, BLOCKS), [1, 1]);
		const runs = await equivalent(
			code,
			[
				click('tr:nth-child(2) a'),
				m => m.stats.set(rows => [...rows].reverse()),
				m => m.stats.set(rows => [...rows, { id: 3, label: 'c' }]),
				m => m.stats.set(rows => rows.map(r => (r.id === 3 ? { id: 3, label: 'C' } : r))),
				click('tr:nth-child(1) a'),
				click('tr:nth-child(1) a.x'),
				m => m.stats.set([])
			],
			BLOCKS
		);
		assert.equal(
			runs.none.html[1],
			'<table><tbody><tr class=""><td class="id">1</td><td><a>a</a></td><td><a class="x">x</a></td></tr><tr class="danger"><td class="id">2</td><td><a>b</a></td><td><a class="x">x</a></td></tr></tbody></table>'
		);
		// Selecting the selected row doesn't render.
		assert.equal(runs.none.stats.renders, 7);
		assert.equal(runs.babel.stats.renders, 1);
		assert.equal(runs.rolldown.stats.renders, 1);
	});

	test('rows keep their DOM nodes across updates', async () => {
		const code = `import { signal } from '@preact/signals';
			export const label = signal('a');
			export function App() {
				return <p class="row"><b>{label.value}</b> and <i>{label.value.length}</i></p>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		for (const via of ['babel', 'rolldown']) {
			const { module } = await load(code, via, BLOCKS);
			const root = container();
			render(h(module.App, null), root);
			const b = root.querySelector('b');
			module.label.value = 'abc';
			await settle();
			assert.equal(root.innerHTML, '<p class="row"><b>abc</b> and <i>3</i></p>', via);
			assert.equal(root.querySelector('b'), b, via);
			render(null, root);
			// Disposed: later writes don't touch the old nodes.
			module.label.value = 'zz';
			assert.equal(b.textContent, 'abc', via);
		}
	});

	test('text slots that turn into vnodes fall back, and come back', async () => {
		const code = `import { signal } from '@preact/signals';
			export const content = signal('text');
			export const plain = signal('p');
			export function App() {
				return <div>
					<p class="a">{content.value} <span>!</span></p>
					<ul>{[1, 2].map(i => <li key={i}>{content.value}{i}</li>)}</ul>
					<p class="b">{plain.value}<br /></p>
				</div>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		await equivalent(
			code,
			[
				m => (m.content.value = h('em', null, 'vnode')),
				m => (m.content.value = 'back'),
				m => (m.content.value = null),
				m => (m.content.value = true),
				m => (m.content.value = 7),
				m => (m.plain.value = h('s', null, 'struck')),
				m => (m.plain.value = 'plain')
			],
			BLOCKS
		);
	});

	test('a vnode passed in a text slot renders the original JSX', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = {};
			export function App() {
				const [v, setV] = useState(<b>bold</b>);
				stats.set = setV;
				return <p class="x" title={typeof v}>{v}<i>!</i></p>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		await equivalent(
			code,
			[m => m.stats.set('text'), m => m.stats.set(h('b', null, 'again')), m => m.stats.set(['a', 'b'])],
			BLOCKS
		);
	});

	test('signals passed directly bind as slots', async () => {
		const code = `import { signal } from '@preact/signals';
			export const text = signal('t');
			export const cls = signal('c');
			// Through props: module-level signals alone make markup static.
			function P({ text, cls }) {
				return <p class={cls}>{text}<i>!</i></p>;
			}
			export function App() {
				return <P text={text} cls={cls} />;
			}`;
		assert.deepEqual(await blockCount(code, BLOCKS), [1, 1]);
		await equivalent(
			code,
			[
				m => (m.text.value = 'u'),
				m => (m.cls.value = 'd'),
				m => (m.text.value = h('b', null, 'node')),
				m => (m.text.value = 'v')
			],
			BLOCKS
		);
		const { module } = await load(code, 'babel', BLOCKS);
		module.text.value = h('b', null, 'early');
		const root = container();
		render(h(module.App, null), root);
		await settle();
		assert.equal(root.innerHTML, '<p class="c"><b>early</b><i>!</i></p>');
	});

	test('switching templates on one element remounts it', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = {};
			export function App() {
				const [on, setOn] = useState(true);
				const [n, setN] = useState(1);
				stats.toggle = () => setOn(o => !o);
				stats.inc = () => setN(x => x + 1);
				return <section>{on
					? <div class="a" title={'t' + n}>one {n}<b /></div>
					: <div id="b">two {n}<i /></div>}</section>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		await equivalent(code, [m => m.stats.toggle(), m => m.stats.inc(), m => m.stats.toggle()], BLOCKS);
	});

	test('fixed form properties are set as properties, entities decoded', async () => {
		const code = `export function App({ n }) {
				return <form>
					<input value="a &amp; &quot;b&quot;" />
					<input type="checkbox" checked />
					<input type="checkbox" checked={false} />
					{n}
				</form>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		const read = root => [...root.querySelectorAll('input')].map(el => [el.value, el.checked]);
		const states = {};
		for (const via of ['none', 'babel', 'rolldown']) {
			const { module } = await load(code, via, BLOCKS);
			const root = container();
			render(h(module.App, { n: 1 }), root);
			const seen = [read(root), root.innerHTML];
			// Re-rendering resets a typed value and an unchecked box, like any controlled prop.
			root.querySelector('input').value = 'typed';
			root.querySelectorAll('input')[1].checked = false;
			render(h(module.App, { n: 2 }), root);
			seen.push(read(root));
			states[via] = seen;
			render(null, root);
		}
		assert.equal(states.none[0][0][0], 'a & "b"');
		assert.deepEqual(states.babel, states.none);
		assert.deepEqual(states.rolldown, states.none);
	});

	test('form properties: value and checked follow the live DOM', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = {};
			export function App() {
				const [text, setText] = useState('a');
				const [on, setOn] = useState(true);
				stats.setText = setText;
				stats.setOn = setOn;
				return <form>
					<input value={text} onInput={e => setText(e.target.value)} />
					<input type="checkbox" checked={on} onClick={() => setOn(!on)} />
					<button value="static" type="button">{text}</button>
				</form>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		const read = root => [...root.querySelectorAll('input, button')].map(el => [el.value, el.checked]);
		const states = {};
		for (const via of ['none', 'babel', 'rolldown']) {
			const { module } = await load(code, via, BLOCKS);
			const root = container();
			render(h(module.App, null), root);
			await settle();
			const seen = [read(root)];
			const input = root.querySelector('input');
			input.value = 'typed';
			input.dispatchEvent(new Event('input'));
			await settle();
			seen.push(read(root));
			// A controlled value that doesn't change still resets the DOM.
			input.value = 'stray';
			module.stats.setText('typed');
			await settle();
			seen.push(read(root));
			module.stats.setOn(false);
			await settle();
			seen.push(read(root), canonical(root.innerHTML));
			states[via] = seen;
			render(null, root);
		}
		assert.deepEqual(states.babel, states.none);
		assert.deepEqual(states.rolldown, states.none);
	});

	test('styles, booleans, functions and unknown attributes', async () => {
		const code = `import { signal } from '@preact/signals';
			export const step = signal(0);
			const STYLES = [{ color: 'red', '--x': '1' }, 'margin: 1px', { padding: '2px', color: null }, null, { color: 'blue' }];
			export function App() {
				const i = step.value;
				return <div>
					<p style={STYLES[i]} aria-hidden={i % 2 === 0} data-on={i > 1 ? false : 'yes'} hidden={i === 3} foo={i === 1 ? false : 'bar'}>s</p>
					<p fn={() => i} tabIndex={i} draggable={i % 2 === 1}>f</p>
				</div>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		await equivalent(
			code,
			[1, 2, 3, 4, 0].map(i => m => (m.step.value = i)),
			BLOCKS
		);
	});

	test('events: capture, lowercase names, removal, and handlers attached mid-dispatch', async () => {
		const code = `import { signal } from '@preact/signals';
			export const log = [];
			export const armed = signal(false);
			export const on = signal(true);
			export function App() {
				return <div onClick={armed.value ? () => log.push('outer') : null} onClickCapture={() => log.push('capture')}>
					<button onclick={on.value ? () => { log.push('inner'); armed.value = true; } : undefined}>b</button>
					<span onGotPointerCapture={() => log.push('pointer')}>s</span>
				</div>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		const logs = {};
		for (const via of ['none', 'babel', 'rolldown']) {
			const { module } = await load(code, via, BLOCKS);
			const root = container();
			render(h(module.App, null), root);
			await settle();
			const fire = (sel, type = 'click') => root.querySelector(sel).dispatchEvent(new Event(type, { bubbles: true }));
			fire('button');
			await settle();
			fire('button');
			fire('span', 'gotpointercapture');
			module.on.value = false;
			await settle();
			fire('button');
			logs[via] = module.log.slice();
			render(null, root);
		}
		assert.deepEqual(logs.none, ['capture', 'inner', 'capture', 'inner', 'outer', 'pointer', 'capture', 'outer']);
		assert.deepEqual(logs.babel, logs.none);
		assert.deepEqual(logs.rolldown, logs.none);
	});

	test('options.event sees block events', async () => {
		const code = `export const seen = [];
			export function App() {
				return <p class="x"><button onClick={e => seen.push(e.tagged)}>b</button>{'t'}</p>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		const prev = options.event;
		options.event = e => ((e.tagged = true), e);
		try {
			for (const via of ['babel', 'rolldown']) {
				const { module } = await load(code, via, BLOCKS);
				const root = container();
				render(h(module.App, null), root);
				root.querySelector('button').dispatchEvent(new Event('click'));
				assert.deepEqual(module.seen, [true], via);
				render(null, root);
			}
		} finally {
			options.event = prev;
		}
	});

	test('attributes Preact never sets as properties', async () => {
		const code = `export function App({ v }) {
				return <div width={v} height={v} href={v} list={v} form={v} download={v} rowSpan={v} colSpan={v} role={v} popover={v === 1 ? true : v}>
					{false}{null}{v}<i />
				</div>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		const html = {};
		for (const via of ['none', 'babel', 'rolldown']) {
			const { module } = await load(code, via, BLOCKS);
			const root = container();
			html[via] = [];
			for (const v of [1, 2, null]) {
				render(h(module.App, { v }), root);
				html[via].push(canonical(root.innerHTML));
			}
			render(null, root);
		}
		assert.deepEqual(html.babel, html.none);
		assert.deepEqual(html.rolldown, html.none);
	});

	test('a controlled value of undefined leaves the DOM alone', async () => {
		const code = `export function App({ v }) {
				return <p><input value={v} />{v}</p>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		for (const via of ['none', 'babel', 'rolldown']) {
			const { module } = await load(code, via, BLOCKS);
			const root = container();
			render(h(module.App, { v: 'a' }), root);
			root.querySelector('input').value = 'typed';
			render(h(module.App, { v: undefined }), root);
			assert.equal(root.querySelector('input').value, 'typed', via);
			render(null, root);
		}
	});

	test('properties that throw fall back to attributes', async () => {
		const code = `export function App({ name }) {
				return <p tagName="x" title={name}><b>{name}</b></p>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		for (const via of ['babel', 'rolldown']) {
			const { module } = await load(code, via, BLOCKS);
			const root = container();
			render(h(module.App, { name: 'n' }), root);
			assert.equal(root.innerHTML, '<p tagname="x" title="n"><b>n</b></p>', via);
		}
	});

	test('MathML roots stay plain JSX: token elements switch children to HTML', async () => {
		const code = `export function Row({ x }) {
				return <mrow><mi>{x}</mi><mo>+</mo></mrow>;
			}
			export function App({ x }) {
				return <div><math><Row x={x} /></math><p>{x}<Row x={x} /></p></div>;
			}`;
		assert.deepEqual(await blockCount(code, BLOCKS), [0, 0]);
		for (const via of ['none', 'babel', 'rolldown']) {
			const { module } = await load(code, via, BLOCKS);
			const root = container();
			render(h(module.App, { x: 'a' }), root);
			render(h(module.App, { x: 'b' }), root);
			assert.equal(root.querySelector('math mi').namespaceURI, 'http://www.w3.org/1998/Math/MathML', via);
			assert.equal(root.querySelector('math mi').textContent, 'b', via);
			assert.equal(root.querySelector('p mi').textContent, 'b', via);
			render(null, root);
		}
	});

	test('a root slot is cleared when the block falls back', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = {};
			export function App() {
				const [v, setV] = useState('a');
				stats.set = setV;
				return <p title={v} onClick={() => {}} style={{ color: 'red' }}>{v}<i /></p>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		await equivalent(code, [m => m.stats.set(h('b', null, 'b')), m => m.stats.set('c')], BLOCKS);
	});

	test('server rendering renders the original JSX, and hydration takes over', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = {};
			export function App() {
				const [n, setN] = useState(1);
				stats.inc = () => setN(n + 1);
				return <div class="app"><p class="n" title={'n' + n}>count {n}<b>!</b></p><button onClick={() => setN(n + 1)}>+</button></div>;
			}`;
		assert.ok(
			(await blockCount(code, BLOCKS)).every(n => n > 0),
			'compiles to blocks'
		);
		const { module: plain } = await load(code, 'none', BLOCKS);
		const html = renderToString(h(plain.App, null));
		for (const via of ['babel', 'rolldown']) {
			const { module } = await load(code, via, BLOCKS);
			assert.equal(renderToString(h(module.App, null)), html, via);
			const root = container();
			root.innerHTML = html;
			hydrate(h(module.App, null), root);
			await settle();
			assert.equal(root.innerHTML, html, via);
			root.querySelector('button').dispatchEvent(new Event('click'));
			await settle();
			assert.equal(canonical(root.innerHTML), canonical(html.replace('n1', 'n2').replace('count 1', 'count 2')), via);
			render(null, root);
		}
	});
});

describe('block shapes', () => {
	const one = body => `export function App({ a, b, c, children, props }) { return ${body}; }`;
	const cases = {
		'host tree with text and attribute slots': ['<p class={a}>{b}<i>{c}</i></p>', 1],
		'static text alone is two nodes': ['<p>x<i /></p>', 0], // hoisted instead
		'one content node': ['<p>{a}</p>', 0],
		'empty JSX expressions do not count': ['<p>{/* c */}{a}</p>', 0],
		'whitespace text does not count': ['<p>\n  {a}\n</p>', 0],
		'a component': ['<p>{a}<Comp /></p>', 0],
		'a fragment child': ['<p>{a}<>x</></p>', 0],
		'a spread attribute': ['<p {...props}>{a}<i /></p>', 0],
		'a ref': ['<p ref={a}>{b}<i /></p>', 0],
		'a key below the root': ['<p>{a}<i key="k" /></p>', 0],
		dangerouslySetInnerHTML: ['<p>{a}<i dangerouslySetInnerHTML={b} /></p>', 0],
		is: ['<p is="x-p">{a}<i /></p>', 0],
		'children as an attribute': ['<p children={a}>{b}<i /></p>', 0],
		'children as a child': ['<p>{children}<i /></p>', 0],
		'props.children as a child': ['<p>{props.children}<i /></p>', 0],
		'JSX in a slot': ['<p>{a ? <b /> : null}<i /></p>', 0],
		'JSX as an attribute value': ['<p title=<b />>{a}<i /></p>', 0],
		'JSX in an attribute slot': ['<p title={a ? <b /> : null}>{b}<i /></p>', 0],
		'a custom element': ['<x-p>{a}<i /></x-p>', 0],
		'an svg root': ['<svg>{a}<g /></svg>', 0],
		'an svg-capable root': ['<a href="#">{a}<i /></a>', 0],
		'another svg-capable root': ['<set to="x">{a}<i /></set>', 0],
		'an svg child': ['<p>{a}<svg /></p>', 0],
		'a select': ['<p>{a}<select /></p>', 0],
		'a member tag': ['<p>{a}<ns.i /></p>', 0],
		'a boolean form property': ['<p>{a}<input checked /></p>', 1],
		'a boolean attribute': ['<p>{a}<input disabled /></p>', 1],
		'a literal form property': ['<p>{a}<input value="x" /></p>', 1],
		'primitive attribute values are static': ['<p tabIndex={1} title={"t"}>{a}<i /></p>', 1],
		'primitive children are static': ['<p>{1}{"s"}{a}</p>', 1],
		'a literal key on the root': ['<p key="k">{a}<i /></p>', 1],
		'a primitive form property': ['<p>{a}<input checked={true} /></p>', 1],
		'a literal listener': ['<p onclick="go()">{a}<i /></p>', 1],
		'a computed member is not children': ['<p>{props[a]}<i /></p>', 1]
	};
	for (const [name, [jsx, expected]] of Object.entries(cases)) {
		test(name, async () => {
			assert.deepEqual(await blockCount(one(jsx), { blocks: true }), [expected, expected], jsx);
		});
	}

	// Syntax the JSX transform rejects, so only the analysis sees it.
	const unprintable = {
		'a spread child': '<p>{a}{...b}</p>',
		'a valueless key': '<p key>{a}<i /></p>',
		'a namespaced attribute': '<p xml:lang="en">{a}<i /></p>',
		'a namespaced tag': '<p>{a}<svg:g /></p>'
	};
	for (const [name, jsx] of Object.entries(unprintable)) {
		test(name, () => {
			const code = one(jsx);
			const babel = parseSync(code, {
				babelrc: false,
				configFile: false,
				parserOpts: { plugins: ['jsx'] }
			}).program;
			const oxc = parseAst(code, { lang: 'jsx' });
			assert.equal(analyze(babel, code, { blocks: true }).blocks.length, 0, 'babel');
			assert.equal(analyze(oxc, code, { blocks: true }).blocks.length, 0, 'oxc');
		});
	}

	test('templates are pure, so unused components drop them', async () => {
		const out = await compiled(one('<p class={a}>{b}<i /></p>'), { blocks: true });
		for (const [via, text] of Object.entries(out)) {
			assert.match(text, /_t\d* = \/\* @__PURE__ \*\/ _?\$template\(|_t\d* = \/\*#__PURE__\*\/_?\$template\(/, via);
		}
	});

	test('blocks need signals, and are off by default', async () => {
		const code = one('<p class={a}>{b}<i /></p>');
		assert.deepEqual(await blockCount(code, {}), [0, 0]);
		assert.deepEqual(await blockCount(code, { blocks: true, signals: false }), [0, 0]);
	});

	test('module-level JSX is not a block', async () => {
		assert.deepEqual(await blockCount('const x = 1; export const el = <p>{x}<i /></p>;', { blocks: true }), [0, 0]);
	});

	test('keys, literal slots and containers print the same with both plugins', async () => {
		const code = `import { signal } from '@preact/signals';
			const s = signal(1);
			export function App({ items, render: r }) {
				return <div>
					{items.map(item => <p key={item.id} class={s.value}>{item.text}<input value="v" /></p>)}
					<Comp render={<p>{r}<i /></p>} />
					<p title={s.value ? 'a' : 'b'}>{(s.value, 'seq')}<i /></p>
				</div>;
			}`;
		const out = await compiled(code, { blocks: true });
		for (const [via, text] of Object.entries(out)) {
			const flat = text.replace(/\s+/g, ' ');
			assert.match(flat, /\$block\(\[ ?_t\d*, \(\) => s\.value, item\.text ?\], item\.id\)/, via);
			assert.match(flat, /render: _?\$block\(\[_t\d*, r\]\)/, via);
		}
		await equivalent(
			`import { signal } from '@preact/signals';
			export const s = signal(1);
			export function App() {
				const items = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }];
				return <div>
					{items.map(item => <p key={item.id} class={s.value}>{item.text}<input value="v" /></p>)}
					<p title={s.value ? 'a' : 'b'}>{(s.value, 'seq')}<i /></p>
				</div>;
			}`,
			[m => (m.s.value = 0), m => (m.s.value = 2)],
			{ blocks: true }
		);
	});

	test('a key that reads signals wraps the whole block', async () => {
		const code = `import { signal } from '@preact/signals';
			export const s = signal(1);
			const Item = () => <p key={s.value} class="a">{s.value}<i /></p>;
			export function App() {
				return <div><Item />{<p key={s.value}>x{s.value}</p>}</div>;
			}`;
		const out = await compiled(code, { blocks: true });
		for (const [via, text] of Object.entries(out)) {
			assert.equal(
				(text.match(/\$hole\(\(\) => _?\$block\(\[_?t\d*, \(\) => s\.value\], s\.value\)\)/g) || []).length,
				2,
				via
			);
		}
		await equivalent(code, [m => (m.s.value = 2), m => (m.s.value = 3)], { blocks: true });
	});

	test('an unsafe slot stays a plain value read during render', async () => {
		const code = `import { signal } from '@preact/signals';
			export const s = signal(1);
			export const log = {};
			export const stats = { renders: 0 };
			export function App() {
				stats.renders++;
				return <p class="x">{(log.last = s.value)}<i>{s.value}</i></p>;
			}`;
		const out = await compiled(code, { blocks: true });
		for (const [via, text] of Object.entries(out)) {
			assert.match(text.replace(/\s+/g, ' '), /\$block\(\[ ?_t\d*, log\.last = s\.value, \(\) => s\.value ?\]\)/, via);
		}
		const runs = await equivalent(code, [m => (m.s.value = 2)], { blocks: true });
		assert.equal(runs.babel.stats.renders, 2);
		assert.equal(runs.babel.module.log.last, 2);
	});
});
