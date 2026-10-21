// Browser benchmark: each scenario in ./scenarios is bundled once per option
// set (minified, production) and driven in real Chrome. A measurement mounts
// the app fresh, runs the setup ops, then times the measured op `times`
// times, each flushed with `act()` and followed by a forced layout. Variants
// get their own page and are interleaved run by run, so drift hits them all.
//
//   pnpm bench:browser [--filter rows] [--runs 20] [--variants none,blocks]
//
// Uses the installed Google Chrome; set CHROME_PATH to use another binary.
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rolldown } from 'rolldown';
import { chromium } from 'playwright-core';
import preactOptimize from 'rolldown-plugin-preact-optimize';

const { values: args } = parseArgs({
	options: {
		filter: { type: 'string' },
		runs: { type: 'string', default: '15' },
		warmup: { type: 'string', default: '5' },
		variants: { type: 'string' }
	}
});

/** @type {[string, object | null][]} */
const ALL_VARIANTS = [
	['none', null],
	['default', {}],
	['+components', { hoistComponents: true }],
	['+hooks', { hoistComponents: true, hooks: true }],
	['+blocks', { hoistComponents: true, hooks: true, blocks: true }]
];
const VARIANTS = args.variants
	? ALL_VARIANTS.filter(([name]) => args.variants.split(',').some(v => name.replace('+', '') === v.replace('+', '')))
	: ALL_VARIANTS;

/** `setup` ops run untimed after mounting; `op` is timed `times` times. */
const BENCHES = [
	{ scenario: 'rows', name: 'create 1,000 rows', setup: [], op: 'create', times: 1 },
	{ scenario: 'rows', name: 'replace 1,000 rows', setup: ['create'], op: 'create', times: 1 },
	{ scenario: 'rows', name: 'update every 10th row', setup: ['create'], op: 'update', times: 1 },
	{ scenario: 'rows', name: 'select a row', setup: ['create'], op: 'select', times: 1 },
	{ scenario: 'rows', name: 'swap two rows', setup: ['create'], op: 'swap', times: 1 },
	{ scenario: 'rows', name: 'remove a row', setup: ['create'], op: 'remove', times: 1 },
	{ scenario: 'rows', name: 'append 1,000 rows', setup: ['create'], op: 'append', times: 1 },
	{ scenario: 'rows', name: 'clear 1,000 rows', setup: ['create'], op: 'clear', times: 1 },
	{ scenario: 'page', name: '100 signal counter writes', setup: [], op: 'count', times: 100 },
	{ scenario: 'page', name: '100 signal object writes', setup: [], op: 'user', times: 100 },
	{ scenario: 'form', name: '100 keystrokes (useState)', setup: [], op: 'type', times: 100 },
	{ scenario: 'form', name: '200 parent class toggles', setup: [], op: 'touch', times: 200 },
	{ scenario: 'cards', name: '50 parent re-renders', setup: [], op: 'tick', times: 50 }
].filter(b => !args.filter || b.scenario === args.filter || b.name.includes(args.filter));

const RUNS = Number(args.runs);
const WARMUP = Number(args.warmup);

const ENTRY = scenario => `
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { App, ops } from ${JSON.stringify(fileURLToPath(new URL(`./scenarios/${scenario}.jsx`, import.meta.url)))};
const root = document.getElementById('root');
// Blocks may set attributes in another order; compare them sorted.
const canonical = el => {
	const copy = el.cloneNode(true);
	for (const node of copy.querySelectorAll('*')) {
		const attrs = [...node.attributes].map(a => [a.name, a.value]).sort(([a], [b]) => (a < b ? -1 : 1));
		for (const [name] of attrs) node.removeAttribute(name);
		for (const [name, value] of attrs) node.setAttribute(name, value);
	}
	return copy.innerHTML;
};
window.measure = (setup, op, times) => {
	act(() => render(null, root));
	act(() => render(h(App, null), root));
	for (const name of setup) act(() => ops[name]());
	root.offsetHeight;
	if (window.gc) window.gc();
	const start = performance.now();
	for (let i = 0; i < times; i++) {
		act(() => ops[op]());
		root.offsetHeight;
	}
	const ms = performance.now() - start;
	return { ms, html: canonical(root) };
};
`;

/** Bundle a scenario with one option set (`null`: no plugin). */
async function build(scenario, options) {
	const bundle = await rolldown({
		input: 'entry',
		plugins: [
			{
				name: 'entry',
				resolveId: id => (id === 'entry' ? id : null),
				load: id => (id === 'entry' ? ENTRY(scenario) : null)
			},
			options && preactOptimize(options)
		],
		transform: {
			jsx: { runtime: 'automatic', importSource: 'preact' },
			define: { 'process.env.NODE_ENV': '"production"' }
		},
		logLevel: 'silent'
	});
	const { output } = await bundle.generate({ format: 'iife', minify: true });
	await bundle.close();
	return output[0].code;
}

const median = xs => {
	const s = xs.toSorted((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const geomean = xs => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
const pad = (s, n) => String(s).padStart(n);

const browser = await chromium.launch({
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
	args: ['--js-flags=--expose-gc', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
});

const scenarios = [...new Set(BENCHES.map(b => b.scenario))];
/** @type {Record<string, Record<string, import('playwright-core').Page>>} */
const pages = {};
console.log(`Bundle sizes (minified, bytes gzip / brotli), ${VARIANTS.length} variants\n`);
console.log(`${'scenario'.padEnd(10)}${VARIANTS.map(([v]) => pad(v, 18)).join('')}`);
for (const scenario of scenarios) {
	pages[scenario] = {};
	const sizes = [];
	for (const [variant, options] of VARIANTS) {
		const code = await build(scenario, options);
		sizes.push(`${gzipSync(code).length} / ${brotliCompressSync(code).length}`);
		const page = await (await browser.newContext()).newPage();
		await page.setContent('<!doctype html><div id="root"></div>');
		await page.addScriptTag({ content: code });
		pages[scenario][variant] = page;
	}
	console.log(`${scenario.padEnd(10)}${sizes.map(s => pad(s, 18)).join('')}`);
}

console.log(`\nMedian ms over ${RUNS} runs (after ${WARMUP} warmup), ratio to none in parentheses\n`);
console.log(`${'benchmark'.padEnd(28)}${VARIANTS.map(([v]) => pad(v, 16)).join('')}`);
/** @type {Record<string, number[]>} */
const ratios = Object.fromEntries(VARIANTS.map(([v]) => [v, []]));
for (const bench of BENCHES) {
	/** @type {Record<string, number[]>} */
	const times = Object.fromEntries(VARIANTS.map(([v]) => [v, []]));
	const html = {};
	for (let run = 0; run < WARMUP + RUNS; run++) {
		// Rotate the order so no variant always runs first.
		for (let i = 0; i < VARIANTS.length; i++) {
			const [variant] = VARIANTS[(run + i) % VARIANTS.length];
			const result = await pages[bench.scenario][variant].evaluate(
				([setup, op, n]) => /** @type {any} */ (window).measure(setup, op, n),
				[bench.setup, bench.op, bench.times]
			);
			if (run >= WARMUP) times[variant].push(result.ms);
			html[variant] = result.html;
		}
	}
	const reference = html[VARIANTS[0][0]];
	const base = median(times[VARIANTS[0][0]]);
	const cells = VARIANTS.map(([variant]) => {
		const m = median(times[variant]);
		ratios[variant].push(m / base);
		const mismatch = html[variant] !== reference ? '!' : ' ';
		return pad(`${m.toFixed(2)} (${(m / base).toFixed(2)})${mismatch}`, 16);
	});
	console.log(`${bench.name.padEnd(28)}${cells.join('')}`);
}
console.log(`${'geometric mean'.padEnd(28)}${VARIANTS.map(([v]) => pad(geomean(ratios[v]).toFixed(2), 16)).join('')}`);
console.log('\n! marks a variant whose DOM (attributes sorted) differs from the first one after the run');
await browser.close();
