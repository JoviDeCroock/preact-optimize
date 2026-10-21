import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { transformAsync } from '@babel/core';
import { rolldown } from 'rolldown';
import babelPlugin from '../packages/babel/src/index.js';
import rolldownPlugin from '../packages/rolldown/src/index.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const key of ['window', 'document', 'Node', 'Text', 'Element', 'HTMLElement', 'Event', 'InputEvent']) {
	globalThis[key] = key === 'window' ? dom.window : dom.window[key];
}

const tmp = fileURLToPath(new URL('./.tmp/', import.meta.url));
mkdirSync(tmp, { recursive: true });
let fileId = 0;

/**
 * Compile a JSX module to plain ESM that imports `preact/jsx-runtime`.
 * @param {string} code
 * @param {'none' | 'babel' | 'rolldown'} via
 * @param {object} [options] plugin options
 */
export async function compile(code, via, options = {}) {
	if (via === 'rolldown') {
		const bundle = await rolldown({
			input: 'entry.jsx',
			external: id => id !== 'entry.jsx',
			logLevel: 'silent',
			plugins: [
				{
					name: 'virtual',
					resolveId: id => (id === 'entry.jsx' ? id : null),
					load: id => (id === 'entry.jsx' ? code : null)
				},
				rolldownPlugin(options)
			],
			transform: { jsx: { runtime: 'automatic', importSource: 'preact' } }
		});
		const { output } = await bundle.generate({ format: 'esm' });
		return output[0].code;
	}

	const result = await transformAsync(code, {
		filename: 'entry.jsx',
		babelrc: false,
		configFile: false,
		plugins: [
			...(via === 'babel' ? [[babelPlugin, options]] : []),
			['@babel/plugin-transform-react-jsx', { runtime: 'automatic', importSource: 'preact' }]
		]
	});
	return result.code;
}

/** Compile and import a fixture module. */
export async function load(code, via, options) {
	const out = await compile(code, via, options);
	const file = `${tmp}fixture-${++fileId}-${via}.mjs`;
	writeFileSync(file, out);
	return { module: await import(pathToFileURL(file).href), code: out };
}

export const VARIANTS = ['none', 'babel', 'rolldown'];

/** Flush Preact's debounced render queue and pending microtasks. */
export const tick = () => new Promise(r => setTimeout(r, 0));

export function container() {
	const el = document.createElement('div');
	document.body.appendChild(el);
	return el;
}

/**
 * Render `App` from the fixture with every variant, run the same steps, and
 * check the DOM matches the untransformed build after every step. Returns the
 * per-variant render stats so tests can assert on work saved.
 */
export async function equivalent(code, steps, options) {
	const { h, render } = await import('preact');
	const runs = {};
	for (const via of VARIANTS) {
		const { module } = await load(code, via, options);
		const root = container();
		render(h(module.App, null), root);
		await tick();
		const html = [root.innerHTML];
		for (const step of steps) {
			await step(module, root);
			await tick();
			html.push(root.innerHTML);
		}
		runs[via] = { html, stats: { ...module.stats }, module, root };
	}
	for (const via of ['babel', 'rolldown']) {
		assert.deepEqual(runs[via].html, runs.none.html, `${via} DOM diverged`);
	}
	return runs;
}

