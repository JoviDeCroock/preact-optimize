import assert from 'node:assert/strict';
import { test } from 'node:test';
import { h, hydrate, render } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { VARIANTS, container, load, tick } from './harness.mjs';
import { apply, generate } from './fuzz-gen.mjs';

/** Server style serialization (`color:red;`) survives hydration. */
const normalize = html =>
	html.replace(/style="([^"]*)"/g, (_, v) => `style="${v.replace(/\s+/g, '')}"`);

const SEEDS = Number(process.env.SSR_SEEDS || 60);
const OPTIONS = { hoistComponents: true, hooks: true };

// Preact 11.0.1 core mis-hydrates adjacent numeric text (`<i>00</i>` with
// children `[0, 0]` becomes `000`: `dom.data != newProps` compares "00" == 0
// loosely). Seeds where the untransformed build itself hydrates to different
// DOM than it client-renders are skipped, since every later step then depends
// on which variant happens to re-render over the broken text node.
test(`server output matches and hydrates (${SEEDS} seeds)`, async t => {
	const skipped = [];
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { code, steps } = generate(seed);
		const html = {};
		const modules = {};
		for (const via of VARIANTS) {
			modules[via] = (await load(code, via, OPTIONS)).module;
			html[via] = renderToString(h(modules[via].App, null));
		}
		assert.equal(html.babel, html.none, `seed ${seed} babel SSR\n${code}`);
		assert.equal(html.rolldown, html.none, `seed ${seed} rolldown SSR\n${code}`);

		const client = container();
		render(h(modules.none.App, null), client);
		const clientHtml = client.innerHTML;
		render(null, client);

		// Reference: the untransformed build hydrating the same markup.
		const reference = container();
		reference.innerHTML = html.none;
		hydrate(h(modules.none.App, null), reference);
		await tick();
		if (normalize(reference.innerHTML) !== normalize(clientHtml)) {
			skipped.push(seed);
			render(null, reference);
			continue;
		}
		const expected = [reference.innerHTML];
		for (const step of steps) {
			apply(modules.none, reference, step);
			await tick();
			expected.push(reference.innerHTML);
		}
		render(null, reference);

		// Transformed clients hydrating the server markup, then updating.
		for (const via of ['babel', 'rolldown']) {
			const { module } = await load(code, via, OPTIONS);
			const root = container();
			root.innerHTML = html.none;
			hydrate(h(module.App, null), root);
			await tick();
			const actual = [root.innerHTML];
			for (const step of steps) {
				apply(module, root, step);
				await tick();
				actual.push(root.innerHTML);
			}
			assert.deepEqual(actual, expected, `seed ${seed} ${via} hydration\n${code}`);
			render(null, root);
		}
	}
	t.diagnostic(`skipped (core hydration bug): ${skipped.length}/${SEEDS} ${skipped.join(',')}`);
	assert.ok(skipped.length < SEEDS / 3, 'too many skipped seeds');
});
