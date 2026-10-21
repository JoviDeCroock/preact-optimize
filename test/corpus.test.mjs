// Optimization coverage on realistic components: every render-time reactive
// read should move out of render, both plugins must agree on that, and the
// result must behave like the untransformed build (DOM after every step and
// the side effects the components record).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { h, options, render } from 'preact';
import { VARIANTS, compile, container, load, settle } from './harness.mjs';

const dir = new URL('./corpus/', import.meta.url);
const FILES = readdirSync(dir).filter(file => file.endsWith('.jsx'));
const OPTION_SETS = [{}, { hooks: true }, { hooks: true, hoistComponents: true }];

// [moved, reads] with `hooks: true`. Every reactive read moves.
const COVERAGE = {
	'counter.jsx': [5, 5],
	'dashboard.jsx': [16, 16],
	'form.jsx': [18, 18],
	'modal.jsx': [2, 2],
	'search.jsx': [15, 15],
	'tabs.jsx': [10, 10],
	'todo.jsx': [10, 10]
};

/** Count renders of the named components while `fn` runs. */
async function countRenders(names, fn) {
	let renders = 0;
	const prev = options.__r;
	options.__r = vnode => {
		if (names.has(vnode.type.name)) renders++;
		if (prev) prev(vnode);
	};
	try {
		await fn();
	} finally {
		options.__r = prev;
	}
	return renders;
}

test('every corpus file is covered', () => {
	assert.deepEqual(Object.keys(COVERAGE).sort(), FILES.sort());
});

for (const file of FILES) {
	test(file, async t => {
		const code = readFileSync(new URL(file, dir), 'utf8');
		const components = new Set([...code.matchAll(/function ([A-Z]\w*)/g)].map(m => m[1]));

		const reports = {};
		for (const via of ['babel', 'rolldown']) {
			await compile(code, via, { hooks: true, report: (_, report) => (reports[via] = report) });
		}
		assert.deepEqual(reports.rolldown, reports.babel, 'plugins disagree');
		const { moved, reads, diagnostics, keptState } = reports.babel;
		assert.deepEqual(
			{ moved, reads, diagnostics, keptState },
			{
				moved: COVERAGE[file][0],
				reads: COVERAGE[file][1],
				diagnostics: [],
				keptState: []
			}
		);

		for (const opts of OPTION_SETS) {
			const runs = {};
			for (const via of VARIANTS) {
				const { module } = await load(code, via, opts);
				const root = container();
				const html = [];
				const renders = await countRenders(components, async () => {
					render(h(module.App, null), root);
					await settle();
					html.push(root.innerHTML);
					for (const step of module.steps) {
						await step(root, module);
						await settle();
						html.push(root.innerHTML);
					}
				});
				render(null, root);
				root.remove();
				runs[via] = { html, renders, stats: JSON.stringify(module.stats) };
			}
			for (const via of ['babel', 'rolldown']) {
				const label = `${via} ${JSON.stringify(opts)}`;
				assert.deepEqual(runs[via].html, runs.none.html, `${label} DOM diverged`);
				assert.equal(runs[via].stats, runs.none.stats, `${label} side effects diverged`);
				assert.equal(runs[via].renders, runs.babel.renders, `${label} render count differs between plugins`);
				assert.ok(runs[via].renders <= runs.none.renders, `${label} renders more`);
			}
			t.diagnostic(`${JSON.stringify(opts)} component renders: ${runs.none.renders} → ${runs.babel.renders}`);
		}
	});
}
