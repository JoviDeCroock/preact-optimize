import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { transformAsync } from '@babel/core';
import { rolldown } from 'rolldown';
import babelPlugin from '../packages/babel/src/index.js';
import rolldownPlugin from '../packages/rolldown/src/index.js';
import { equivalent, load } from './harness.mjs';

/** Run the rolldown plugin's transform hook directly. */
async function rolldownTransform(code, id, options = {}) {
	let result;
	const bundle = await rolldown({
		input: id,
		external: () => true,
		logLevel: 'silent',
		plugins: [
			{ name: 'virtual', resolveId: x => (x === id ? x : null), load: x => (x === id ? code : null) },
			{
				...rolldownPlugin(options),
				transform: {
					...rolldownPlugin(options).transform,
					async handler(c, i) {
						result = await rolldownPlugin(options).transform.handler.call(this, c, i);
						return result;
					}
				}
			}
		],
		transform: { jsx: 'preserve' }
	});
	await bundle.generate({ format: 'esm' });
	return result;
}

describe('module constants', () => {
	test('signals and module functions make markup hoistable', async () => {
		const code = `import { signal } from '@preact/signals';
			export const count = signal(0);
			export const stats = { renders: 0, set: null };
			function reset() { count.value = 0; }
			const LABEL = 'Count';
			import { useState } from 'preact/hooks';
			export function App() {
				stats.renders++;
				const [x, set] = useState(0);
				stats.set = set;
				return <div>
					<p class="c"><b>{LABEL}</b>: {count}</p>
					<button onClick={reset}>reset</button>
					<i>{x}</i>
				</div>;
			}`;
		for (const via of ['babel', 'rolldown']) {
			const { code: out } = await load(code, via);
			assert.equal((out.match(/\$static\(/g) || []).length, 2, `${via}\n${out}`);
		}
		await equivalent(code, [
			m => (m.count.value = 5),
			m => m.stats.set(1),
			(m, root) => root.querySelector('button').dispatchEvent(new Event('click')),
			m => m.stats.set(2)
		]);
	});

	test('mutable and non-constant bindings are not hoisted', async () => {
		const code = `import { options as imported } from 'preact';
			let counter = 0;
			const list = ['a'];
			export const stats = {};
			export function App() {
				return <div>
					<p>{counter}</p>
					<p>{list}</p>
					<p>{imported}</p>
				</div>;
			}
			counter++;`;
		for (const via of ['babel', 'rolldown']) {
			const { code: out } = await load(code, via);
			assert.doesNotMatch(out, /\$static\(/, via);
		}
	});
});

describe('syntax', () => {
	test('TSX through both plugins', async () => {
		const code = `import { signal, type Signal } from '@preact/signals';
			import type { ComponentChildren } from 'preact';
			const count: Signal<number> = signal(0);
			enum Size { Small = 1 }
			function Box<T extends string>(props: { label: T; children?: ComponentChildren }) {
				return <div class={props.label as string} data-size={Size.Small}>{props.children}</div>;
			}
			export function App() {
				const items = [1, 2] satisfies number[];
				return <Box label="x"><span>{count.value! + items.length}</span><hr /></Box>;
			}`;
		const out = await rolldownTransform(code, 'entry.tsx');
		assert.match(out.code, /\$hole\(\(\) => \(count\.value! \+ items\.length\), \[count, items\], _k\[0\]\)/);
		assert.match(out.code, /<hr \/>/);
		assert.match(out.code, /\$static\(<hr \/>\)/);

		const babel = await transformAsync(code, {
			filename: 'entry.tsx',
			babelrc: false,
			configFile: false,
			presets: ['@babel/preset-typescript'],
			parserOpts: { plugins: ['jsx'] },
			plugins: [babelPlugin]
		});
		assert.match(babel.code, /_\$hole\(\(\) => count\.value!? \+ items\.length, \[count, items\], _k\[0\]\)/);
		assert.match(babel.code, /_\$static\(<hr \/>\)/);
	});

	test('non-ASCII text keeps offsets intact', async () => {
		const code = `import { signal } from '@preact/signals';
			export const name = signal('wörld');
			export const stats = {};
			export function App() {
				return <p title="héllo 👋">héllo 👋 {name.value} — ünïcode <em>静的</em></p>;
			}`;
		const runs = await equivalent(code, [m => (m.name.value = '世界')]);
		assert.equal(runs.none.html.at(-1), '<p title="héllo 👋">héllo 👋 世界 — ünïcode <em>静的</em></p>');
	});

	test('directives and hashbangs stay first', async () => {
		const out = await rolldownTransform(
			`#!/usr/bin/env node\n'use client';\nexport function App() { return <p>static</p>; }`,
			'entry.jsx'
		);
		assert.match(out.code, /^#!\/usr\/bin\/env node\n'use client';\nimport \{ \$static/);
	});

	test('files without work are left untouched', async () => {
		const out = await rolldownTransform(
			`export function App(props) { return <p>{props.x}</p>; }\nexport const add = (a, b) => a + b;`,
			'entry.jsx'
		);
		assert.equal(out, undefined);
	});

	test('emits a source map', async () => {
		const out = await rolldownTransform(`export function App() {\n  return <p>static</p>;\n}`, 'entry.jsx');
		assert.ok(out.map, 'map');
		assert.ok(out.map.mappings.length > 0);
	});

	test('helper names avoid collisions', async () => {
		const code = `const _$hole = 1, _$static = 2, _h1 = 3;
			import { signal } from '@preact/signals';
			export const s = signal(1);
			export const stats = {};
			export function App() { return <div title={String(_$hole + _$static + _h1)}><b>x</b>{s.value}</div>; }`;
		await equivalent(code, [m => (m.s.value = 2)]);
	});

	test('module-level JSX is left alone', async () => {
		// It runs once at module init, so binding it would change behaviour.
		for (const via of ['babel', 'rolldown']) {
			const { code } = await load(
				`import { signal } from '@preact/signals';
				const s = signal(1);
				export const tree = <p class="a">{s.value}</p>;
				export const App = () => tree;`,
				via
			);
			assert.doesNotMatch(code, /\$static\(|\$hole\(/, via);
		}
	});

	test('report lists what stayed in render', async () => {
		const code = `import { signal } from '@preact/signals';
			import { useEffect, useState } from 'preact/hooks';
			const s = signal(1);
			export function App() {
				const [n, setN] = useState(0);
				useEffect(() => {}, []);
				if (s.value > 1) return null;
				return <p onClick={() => setN(n + 1)}>{s.value}{n}</p>;
			}`;
		const reports = {};
		for (const via of ['babel', 'rolldown']) {
			await load(code, via, { hooks: true, report: (file, report) => (reports[via] = { file, ...report }) });
		}
		assert.match(reports.babel.file, /entry\.jsx$/);
		assert.equal(reports.rolldown.file, 'entry.jsx');
		for (const via of ['babel', 'rolldown']) {
			const { file, ...report } = reports[via];
			assert.deepEqual(
				report,
				{
					reads: 3,
					moved: 2,
					diagnostics: [{ line: 7, column: 8, reason: 'control-flow' }],
					keptState: []
				},
				via
			);
		}
	});

	test('a hoist nested at the start of a hole', async () => {
		const code = `import { signal } from '@preact/signals';
			export const s = signal(0);
			export function App() { return <div>{<b>static</b> && s.value}</div>; }`;
		await equivalent(code, [m => (m.s.value = 2)]);
		for (const via of ['babel', 'rolldown']) {
			const { code: out } = await load(code, via);
			// The hoist sits inside the hole even though both start at `<b>`.
			assert.match(out, /\$hole\(\(\) => \(+_h1? \|\|/, via);
		}
	});

	test('private names are not references', async () => {
		const code = `import { useState } from 'preact/hooks';
			export const stats = {};
			export function App() {
				const [f, setF] = useState(1);
				class Box { #f = 'private'; get() { return this.#f; } }
				stats.set = setF;
				return <p onClick={() => setF(f + 1)}>{f}{new Box().get()}</p>;
			}`;
		const runs = await equivalent(code, [m => m.stats.set(5)], { hooks: true });
		assert.match(runs.babel.html[1], /5private/);
	});

	test('nested declarations and catch patterns shadow', async () => {
		const code = `import { useState } from 'preact/hooks';
			import { signal } from '@preact/signals';
			export const s = signal('x');
			export const stats = {};
			export function App() {
				const [n, setN] = useState(1);
				stats.set = setN;
				function label() { return 'n'; }
				try { throw {}; } catch ({ e = s.value }) { stats.caught = e; }
				return <p>{label()}{n}</p>;
			}`;
		const runs = await equivalent(code, [m => m.stats.set(3)], { hooks: true });
		assert.equal(runs.babel.html[1], '<p>n3</p>');
	});
});
