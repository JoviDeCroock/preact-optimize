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
		for (let i = int(3); i--;) {
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
					`data-mix={props.p + ':' + s1.value + ':' + b}`,
					`style={{ width: s0.value + 'px', color: 'blue' }}`,
					`style={'height:' + r + 'px'}`,
					`{...{ 'data-spread': s1.value }}`,
					`title={label}`,
					`data-total={total}`,
					`data-r={r}`,
					`onClick={() => s0.value++}`,
					`data-f={fmt(a)}`,
					`data-lst={list.value.map(item => item.id).join(',')}`,
					`data-o={list.value[s1.value]?.id}`
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
			() => `<i>static <b>tree</b></i>`,
			() => `{label}`,
			() => `{total}`,
			() => `{r}`,
			() => `{fmt(b)}`,
			() => `{mutable}`,
			() => `{memo}`,
			() => `<Child n={memo} />`,
			() => `<Child n={r}>{s0.value}</Child>`,
			() => `<Wrap>{s1.value} {a}</Wrap>`,
			() => `<Wrap>static</Wrap>`,
			() => `{list.value.filter(item => item.id > s0.value).map(item => <em key={item.id}>{item.label}</em>)}`,
			() => `{[a, s0.value].map(x => <u>{x}</u>)}`,
			() => `{props.children}`,
			() => `{(() => s1.value + 1)()}`,
			() => `{list.value[s0.value % 3]?.label ?? 'none'}`,
			() => `{props.q?.x}{(a > 1 ? null : list.value[0])?.id}`,
			() =>
				`<ul>{list.value.map(item => <li key={item.id} class={item.id === a ? 'on' : ''}>{item.label}<b>{b}</b></li>)}</ul>`,
			() =>
				`<ol>{list.value.map(item => { const id = item.id; return <li key={id} onClick={() => setA(id)}>{item.label}<i>{id + s0.value}</i></li>; })}</ol>`
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
		for (let i = 1 + int(3); i--;) out.push(child(depth));
		return out.join('');
	};
	const element = depth => {
		const tag = pick(TAGS);
		return `<${tag} ${attrs()}>${children(depth)}</${tag}>`;
	};

	const code = `import { signal } from '@preact/signals';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
export const s0 = signal(0);
export const s1 = signal(1);
export const list = signal([{ id: 1, label: 'one' }]);
const count = signal(3);
const LABEL = 'label';
export const stats = {};
const fmt = x => '<' + x + '>';
const reducer = (state, action) => action === 'inc' ? state + 1 : action;
function Child(props) { return <span class="child">{props.n}{props.children}</span>; }
function Wrap({ children }) { return <div class="wrap">{children}</div>; }
function Inner(props) {
	const [a, setA] = useState(0);
	const [b, setB] = useState(1);
	const [r, dispatch] = useReducer(reducer, 2);
	${pick([
		'const label = s0.value > 2 ? "hi" : "lo";',
		'const label = `${s1.value}-${b}`;',
		'const label = props.p + s0.value;'
	])}
	const total = list.value.reduce((sum, item) => sum + item.id, 0) + a;
	let mutable = ${pick(['s1.value', 'b', '0'])};
	${pick(['', 'mutable += 1;', 'if (s0.value > 3) mutable = 9;'])}
	const memo = useMemo(() => ${pick(['a * 10', 's1.value * 10', 'r', 'a + props.p', '<b>{r}</b>', '[a, b].join("/")'])}, [${pick(['a', 'r', '', 'a, props.p', 'a, b', 'props.p', 'r, a'])}]);
	const onGo = useCallback(${pick([
		"() => { setA(a + 1); setB(c => c * 2); dispatch('inc'); }",
		'() => setA(a + 1)',
		'() => setB(b + r)',
		"() => dispatch('inc')"
	])}, [${pick(['a', 'b, r', '', 'a, props.p'])}]);
	const out = useRef();
	const sec = useRef();
	${pick([
		'',
		'useLayoutEffect(() => { stats.seen = b; });',
		"useEffect(() => { const o = out.current; if (o) { o.dataset.e = a + ':' + r; o.dataset.n = (+o.dataset.n || 0) + 1; } }, [a, r]);",
		"useLayoutEffect(() => { const o = out.current; if (o) o.dataset.l = (sec.current ? sec.current.textContent.length : -1) + ':' + b; }, [b]);",
		'useEffect(() => { const o = out.current; if (o) o.dataset.p = props.p + a; }, [props.p, a]);',
		'useEffect(() => { const id = a + r; return () => { const o = out.current; if (o) o.dataset.c = id; }; }, [a, r]);',
		'useEffect(() => { const o = out.current; if (o) o.dataset.m = label + memo; }, [label, memo]);',
		'useEffect(() => { const o = out.current; if (o) o.dataset.once = a; }, []);',
		'useEffect(() => () => { const o = out.current; if (o) o.dataset.cl = a + r; }, [a, r]);',
		'useEffect(() => { const o = out.current; if (o) o.dataset.u = a + label; }, [r]);',
		'useLayoutEffect(() => { const o = out.current; if (o) o.dataset.lm = memo; }, [memo]);'
	])}
	const later = ${pick([
		"() => setTimeout(() => { const o = out.current; if (o) o.dataset.t = a + ':' + b; }, 0)",
		'() => { const o = out.current; if (o) o.dataset.h = label + total; }',
		'async () => { await null; const o = out.current; if (o) o.dataset.as = r + a; }',
		'function () { const read = () => b * 2; setTimeout(() => { const o = out.current; if (o) o.dataset.f = read(); }, 0); }'
	])};
	${pick(['', "useLayoutEffect(() => { const o = out.current; if (o) o.dataset.r = r + ':' + (sec.current ? sec.current.textContent.length : -1); }, [r]);"])}
	stats.setA = setA;
	stats.setB = setB;
	stats.dispatch = dispatch;
	${pick([
		`return <section ref={sec}>
		<button onClick={onGo}>go</button><output ref={out} onClick={later} />
		${element(0)}
	</section>;`,
		`return s1.value > 2 ? <p>root {a}</p> : <section ref={sec}><output ref={out} onClick={later} />
		<button onClick={() => { setA(a + 1); dispatch('inc'); }}>go</button>
		${element(0)}
	</section>;`,
		`if (r > 4) return <p>early {r}</p>;
	return <section ref={sec}><output ref={out} onClick={later} />
		<button onClick={() => setB(b + 1)}>go</button>
		${element(0)}
	</section>;`
	])}
}
export function App() {
	const [p, setP] = useState('p0');
	stats.setP = setP;
	return <Inner p={p}>kid {s0.value}</Inner>;
}
export { count };`;

	const steps = [];
	for (let i = 2 + int(6); i--;) {
		steps.push(
			pick([
				['s0', int(6)],
				['s1', int(4)],
				['list', int(4)],
				['a', int(4)],
				['b', int(5)],
				['p', int(3)],
				['click', 0],
				['count', int(5)],
				['r', int(7)],
				['inc', 0],
				['later', 0],
				['later', 0]
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
		case 'r':
			module.stats.dispatch(value);
			break;
		case 'inc':
			module.stats.dispatch('inc');
			break;
		case 'click':
			root.querySelector('button')?.dispatchEvent(new Event('click'));
			break;
		case 'later':
			root.querySelector('output')?.dispatchEvent(new Event('click'));
			break;
	}
}
