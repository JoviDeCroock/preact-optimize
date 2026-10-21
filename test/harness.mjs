import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { transformAsync } from '@babel/core';
import { rolldown } from 'rolldown';
import babelPlugin from '../packages/babel/src/index.js';
import rolldownPlugin from '../packages/rolldown/src/index.js';

// A zero-delay frame, so passive effects (which wait for the next frame, or
// 35ms without one) run within a few macrotasks.
globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

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
 * @param {'jsx' | 'tsx'} [lang]
 */
export async function compile(code, via, options = {}, lang = 'jsx') {
	const entry = `entry.${lang}`;
	if (via === 'rolldown') {
		const bundle = await rolldown({
			input: entry,
			external: id => id !== entry,
			logLevel: 'silent',
			plugins: [
				{
					name: 'virtual',
					resolveId: id => (id === entry ? id : null),
					load: id => (id === entry ? code : null)
				},
				rolldownPlugin(options)
			],
			transform: { jsx: { runtime: 'automatic', importSource: 'preact' } }
		});
		const { output } = await bundle.generate({ format: 'esm' });
		return output[0].code;
	}

	const result = await transformAsync(code, {
		filename: entry,
		babelrc: false,
		configFile: false,
		presets: lang === 'tsx' ? ['@babel/preset-typescript'] : [],
		plugins: [
			...(via === 'babel' ? [[babelPlugin, options]] : []),
			['@babel/plugin-transform-react-jsx', { runtime: 'automatic', importSource: 'preact' }]
		]
	});
	return result.code;
}

/** Compile and import a fixture module. */
export async function load(code, via, options, lang) {
	const out = await compile(code, via, options, lang);
	const file = `${tmp}fixture-${process.pid}-${++fileId}-${via}.mjs`;
	writeFileSync(file, out);
	return { module: await import(pathToFileURL(file).href), code: out };
}

export const VARIANTS = ['none', 'babel', 'rolldown'];

/**
 * Serialized DOM with each element's attributes sorted. A block's template
 * carries its static attributes, so slots set after them can serialize in a
 * different order than Preact's prop order: not observable otherwise.
 * @param {string} html
 */
export const canonical = html =>
	html.replace(/<([a-z][\w-]*)((?:\s[^\s=>]+(?:="[^"]*")?)+)>/g, (_, tag, attrs) => {
		const list = attrs.match(/[^\s=>]+(?:="[^"]*")?/g);
		return `<${tag} ${list.sort().join(' ')}>`;
	});

/** Flush Preact's debounced render queue and pending microtasks. */
export const tick = () => new Promise(r => setTimeout(r, 0));

/** Wait until renders, signal DOM flushes and passive effects are done. */
export const settle = async () => {
	for (let i = 0; i < 4; i++) await tick();
};

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
export async function equivalent(code, steps, options, lang) {
	const { h, render } = await import('preact');
	const runs = {};
	for (const via of VARIANTS) {
		const { module } = await load(code, via, options, lang);
		const root = container();
		render(h(module.App, null), root);
		await settle();
		const html = [root.innerHTML];
		for (const step of steps) {
			await step(module, root);
			await settle();
			html.push(root.innerHTML);
		}
		runs[via] = { html, stats: { ...module.stats }, module, root };
	}
	for (const via of ['babel', 'rolldown']) {
		assert.deepEqual(runs[via].html.map(canonical), runs.none.html.map(canonical), `${via} DOM diverged`);
	}
	return runs;
}
