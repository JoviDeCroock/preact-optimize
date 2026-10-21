// Work-per-update benchmark in jsdom: counts component renders and diffed
// vnodes (options.diffed) per update, plus wall time. jsdom timings are only
// indicative; the vnode counts are exact.
//
//   node bench/work.mjs
import { h, options, render } from 'preact';
import { container, load, tick } from '../test/harness.mjs';

const VARIANTS = [
	['none', null],
	['default', {}],
	['+components', { hoistComponents: true }],
	['+hooks', { hoistComponents: true, hooks: true }]
];

const SCENARIOS = {
	'signal text in a 60-node static page': {
		code: `import { signal } from '@preact/signals';
			export const count = signal(0);
			const Static = () => <ul>${'<li class="item"><b>label</b> <i>value</i></li>'.repeat(20)}</ul>;
			export function App() {
				return <div><header><h1>Title</h1><nav><a href="/a">a</a><a href="/b">b</a></nav></header>
					<p>Count: {count.value}</p>
					<Static />
				</div>;
			}`,
		update: m => m.count.value++
	},
	'typing into a useState form (20 static fields)': {
		code: `import { useState } from 'preact/hooks';
			export const stats = {};
			export function App() {
				const [text, setText] = useState('');
				stats.type = setText;
				return <form>
					${'<label class="f">Field <input name="x" /></label>'.repeat(20)}
					<input value={text} onInput={e => setText(e.currentTarget.value)} />
					<p>{text.length} chars</p>
				</form>;
			}`,
		update: (m, i) => m.stats.type('x'.repeat(i % 50))
	},
	'parent state with 20 static child components': {
		code: `import { useState } from 'preact/hooks';
			export const stats = {};
			function Count(props) { return <p>{props.n}</p>; }
			function Card(props) { return <div class="card"><h2>{props.title}</h2><p>body</p></div>; }
			export function App() {
				const [n, setN] = useState(0);
				stats.set = setN;
				return <main><Count n={n} />${'<Card title="t" />'.repeat(20)}</main>;
			}`,
		update: (m, i) => m.stats.set(i)
	}
};

const MOUNT = {
	code: `import { signal } from '@preact/signals';
		export const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, label: signal('row ' + i), done: signal(false) }));
		export function App() {
			return <table><tbody>{rows.map(r => <tr key={r.id} class={r.done.value ? 'done' : ''}><td>{r.id}</td><td>{r.label.value}</td></tr>)}</tbody></table>;
		}`
};

let diffed = 0;
let renders = 0;
const prevDiffed = options.diffed;
options.diffed = vnode => {
	diffed++;
	if (prevDiffed) prevDiffed(vnode);
};
const prevRender = options.__r;
options.__r = vnode => {
	renders++;
	if (prevRender) prevRender(vnode);
};

const UPDATES = 300;

for (const [name, { code, update }] of Object.entries(SCENARIOS)) {
	console.log(`\n${name}`);
	for (const [label, opts] of VARIANTS) {
		const { module } = await load(code, opts ? 'rolldown' : 'none', opts || {});
		const root = container();
		render(h(module.App, null), root);
		await tick();
		diffed = renders = 0;
		const start = performance.now();
		for (let i = 1; i <= UPDATES; i++) {
			update(module, i);
			await Promise.resolve();
			await Promise.resolve();
		}
		await tick();
		const ms = performance.now() - start;
		console.log(
			`  ${label.padEnd(13)} ${(renders / UPDATES).toFixed(1).padStart(5)} renders/update  ` +
				`${(diffed / UPDATES).toFixed(1).padStart(6)} vnodes diffed/update  ${((ms / UPDATES) * 1000).toFixed(0).padStart(5)} µs/update`
		);
		render(null, root);
	}
}

console.log('\nmount: 200 rows, 2 signal reads each');
for (const [label, opts] of VARIANTS) {
	const { module } = await load(MOUNT.code, opts ? 'rolldown' : 'none', opts || {});
	const times = [];
	for (let i = 0; i < 15; i++) {
		const root = container();
		const start = performance.now();
		render(h(module.App, null), root);
		times.push(performance.now() - start);
		render(null, root);
		root.remove();
	}
	times.sort((a, b) => a - b);
	console.log(`  ${label.padEnd(13)} median ${times[7].toFixed(2)} ms`);
}
