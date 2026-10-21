import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { h, render } from 'preact';
import babelPlugin from '../packages/babel/src/index.js';
import rolldownPlugin from '../packages/rolldown/src/index.js';
import { container, tick } from './harness.mjs';

const require = createRequire(import.meta.url);
const tmp = fileURLToPath(new URL('./.tmp/vite/', import.meta.url));

const APP = `import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
export const count = signal(0);
export const stats = { renders: 0 };
export function App() {
	stats.renders++;
	const [text, setText] = useState('a');
	return <main>
		<h1 class="title">Static <em>header</em></h1>
		<p data-count={count.value}>{count.value} / {text}</p>
		<button onClick={() => setText(text + '!')}>go</button>
	</main>;
}
`;

const JSX = { runtime: 'automatic', importSource: 'preact' };

describe('vite 8', async () => {
	const { build, createServer } = await import('vite');
	mkdirSync(tmp + 'src', { recursive: true });
	writeFileSync(tmp + 'src/App.jsx', APP);

	test('build output runs and skips re-renders', async () => {
		const result = await build({
			root: tmp,
			configFile: false,
			logLevel: 'silent',
			plugins: [rolldownPlugin({ hooks: true })],
			oxc: { jsx: JSX },
			build: {
				write: false,
				minify: false,
				lib: { entry: tmp + 'src/App.jsx', formats: ['es'], fileName: 'app' },
				rolldownOptions: {
					external: [/^preact/, /^@preact\//, /^preact-optimize/]
				}
			}
		});
		const chunk = [result].flat()[0].output[0];
		assert.match(chunk.code, /\$hole/);
		assert.match(chunk.code, /\$static/);
		assert.match(chunk.code, /\$useState/);

		const file = tmp + 'app.mjs';
		writeFileSync(file, chunk.code);
		const app = await import(pathToFileURL(file).href);
		const root = container();
		render(h(app.App, null), root);
		app.count.value = 2;
		root.querySelector('button').dispatchEvent(new Event('click'));
		await tick();
		assert.equal(
			root.innerHTML,
			'<main><h1 class="title">Static <em>header</em></h1><p data-count="2">2 / a!</p><button>go</button></main>'
		);
		assert.equal(app.stats.renders, 1);
	});

	test('dev server runs the plugin before its JSX transform', async () => {
		const server = await createServer({
			root: tmp,
			configFile: false,
			logLevel: 'silent',
			plugins: [rolldownPlugin()],
			oxc: { jsx: JSX },
			server: { middlewareMode: true, ws: false }
		});
		try {
			const result = await server.transformRequest('/src/App.jsx');
			assert.match(result.code, /\$hole/);
			assert.match(result.code, /\$static/);
			assert.ok(result.map, 'source map');
		} finally {
			await server.close();
		}
	});
});

describe('babel 7', () => {
	test('same output shape as babel 8', async () => {
		const babel7 = require('babel7');
		const result = babel7.transformSync(APP, {
			filename: 'App.jsx',
			babelrc: false,
			configFile: false,
			plugins: [
				[babelPlugin, { hooks: true }],
				[require.resolve('babel7-jsx'), JSX]
			]
		});
		assert.match(result.code, /_\$hole\(\(\) => count\.value\)/);
		assert.match(result.code, /_\$text\(\(\) => count\.value\)/);
		assert.match(result.code, /_\$text\(\(\) => _text\.value\)/);
		assert.match(result.code, /_\$useState\('a'\)/);
		assert.match(result.code, /_h \|\| \(_h = _\$static\(_jsxs?\("h1"/);
	});
});
