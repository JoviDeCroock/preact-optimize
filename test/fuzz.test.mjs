// Differential fuzzing: generate random components that mix static markup,
// signal reads, state reads (inside and outside holes), conditional vnodes,
// keyed lists and child components, then check that every plugin variant
// produces the same DOM as the untransformed build after each random update.
//
// FUZZ_SEEDS=2000 FUZZ_START=0 pnpm test  to widen the search.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { h, render } from 'preact';
import { VARIANTS, container, load, tick } from './harness.mjs';
import { apply, generate } from './fuzz-gen.mjs';

const SEEDS = Number(process.env.FUZZ_SEEDS || 150);
const START = Number(process.env.FUZZ_START || 1);

const OPTION_SETS = [
	{ hoistComponents: true, hooks: true },
	{ hoist: false, hooks: true },
	{ signals: false, hoistComponents: true }
];

test(`differential fuzz (${SEEDS} seeds from ${START})`, async () => {
	for (let seed = START; seed < START + SEEDS; seed++) {
		const { code, steps } = generate(seed);
		const options = OPTION_SETS[seed % OPTION_SETS.length];
		const html = {};
		for (const via of VARIANTS) {
			let module;
			try {
				({ module } = await load(code, via, options));
			} catch (error) {
				assert.fail(`seed ${seed} ${via} failed to compile: ${error.message}\n${code}`);
			}
			const root = container();
			render(h(module.App, null), root);
			await tick();
			html[via] = [root.innerHTML];
			for (const step of steps) {
				apply(module, root, step);
				await tick();
				html[via].push(root.innerHTML);
			}
			render(null, root);
			root.remove();
		}
		for (const via of ['babel', 'rolldown']) {
			for (let i = 0; i < html.none.length; i++) {
				if (html[via][i] !== html.none[i]) {
					assert.fail(
						`seed ${seed} (${JSON.stringify(options)}) ${via} diverged after ` +
							`${i ? JSON.stringify(steps[i - 1]) : 'mount'}\n` +
							`expected: ${html.none[i]}\n` +
							`actual:   ${html[via][i]}\n` +
							`steps: ${JSON.stringify(steps)}\n${code}`
					);
				}
			}
		}
	}
});
