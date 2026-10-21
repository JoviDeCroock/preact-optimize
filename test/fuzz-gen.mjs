// Random component generator for the differential fuzzer.

function mulberry32(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function generate(seed) {
	const rand = mulberry32(seed);
	const int = n => Math.floor(rand() * n);
	const pick = list => list[int(list.length)];
	const TAGS = ['div', 'span', 'p', 'b', 'i', 'section', 'em'];

	const attrs = () => {
		const out = [];
		for (let i = int(3); i--; ) {
			out.push(
				pick([
					`class="static-${int(3)}"`,
					`class={s0.value % 2 ? 'odd' : 'even'}`,
					`title={a}`,
					`title={'b' + b}`,
					`data-p={props.p}`,
					`data-s={s1.value}`,
					`id={LABEL}`,
					`style={{ color: 'red' }}`,
					`hidden={s0.value > 3}`,
					`aria-label={a > 1 ? 'many' : null}`,
					`data-mix={props.p + ':' + s1.value + ':' + b}`
				])
			);
		}
		// Duplicate attribute names are a JSX error.
		const seen = new Set();
		return out
			.filter(a => {
				const name = a.split('=')[0];
				return !seen.has(name) && seen.add(name);
			})
			.join(' ');
	};

	const child = depth => {
		const options = [
			() => `text${int(3)}`,
			() => `{s0.value}`,
			() => `{a}`,
			() => `{b * 2}`,
			() => `{props.p}`,
			() => `{LABEL}`,
			() => `{count}`,
			() => `{s1.value > 1 ? <b>big {a}</b> : 'small'}`,
			() => `{a > 1 && <Child n={a} />}`,
			() => `<Child n={s0.value} />`,
			() => `<Child n={b} />`,
			() => `<Child n={7} />`,
			() => `{list.value.map(item => <li key={item.id}>{item.label}{b}</li>)}`,
			() => `{list.value.length ? list.value.length + ' items' : 'none'}`,
			() => `<i>static <b>tree</b></i>`
		];
		if (depth < 3) {
			options.push(
				() => element(depth + 1),
				() => element(depth + 1),
				() => `<>${children(depth + 1)}</>`
			);
		}
		return pick(options)();
	};
	const children = depth => {
		const out = [];
		for (let i = 1 + int(3); i--; ) out.push(child(depth));
		return out.join('');
	};
	const element = depth => {
		const tag = pick(TAGS);
		return `<${tag} ${attrs()}>${children(depth)}</${tag}>`;
	};

	const code = `import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
export const s0 = signal(0);
export const s1 = signal(1);
export const list = signal([{ id: 1, label: 'one' }]);
const count = signal(3);
const LABEL = 'label';
export const stats = {};
function Child(props) { return <span class="child">{props.n}</span>; }
function Inner(props) {
	const [a, setA] = useState(0);
	const [b, setB] = useState(1);
	stats.setA = setA;
	stats.setB = setB;
	return <section>
		<button onClick={() => { setA(a + 1); setB(c => c * 2); }}>go</button>
		${element(0)}
	</section>;
}
export function App() {
	const [p, setP] = useState('p0');
	stats.setP = setP;
	return <Inner p={p} />;
}
export { count };`;

	const steps = [];
	for (let i = 2 + int(6); i--; ) {
		steps.push(
			pick([
				['s0', int(6)],
				['s1', int(4)],
				['list', int(4)],
				['a', int(4)],
				['b', int(5)],
				['p', int(3)],
				['click', 0],
				['count', int(5)]
			])
		);
	}
	return { code, steps };
}

const LISTS = [
	[],
	[{ id: 1, label: 'one' }],
	[
		{ id: 2, label: 'two' },
		{ id: 1, label: 'one' }
	],
	[
		{ id: 3, label: 'three' },
		{ id: 1, label: 'uno' },
		{ id: 2, label: 'two' }
	]
];

/** Apply a generated step to a loaded fixture. */
export function apply(module, root, [kind, value]) {
	switch (kind) {
		case 's0':
		case 's1':
		case 'count':
			module[kind].value = value;
			break;
		case 'list':
			module.list.value = LISTS[value];
			break;
		case 'a':
			module.stats.setA(value);
			break;
		case 'b':
			module.stats.setB(value);
			break;
		case 'p':
			module.stats.setP('p' + value);
			break;
		case 'click':
			root.querySelector('button').dispatchEvent(new Event('click'));
			break;
	}
}

