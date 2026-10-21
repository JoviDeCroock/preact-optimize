// The declarations name exactly what each runtime entry exports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import './harness.mjs';

const runtime = JSON.parse(readFileSync(new URL('../packages/runtime/package.json', import.meta.url), 'utf8'));

for (const [entry, target] of Object.entries(runtime.exports)) {
	if (typeof target == 'string') continue;
	test(`preact-optimize${entry.slice(1)} declares its exports`, async () => {
		const url = new URL('../packages/runtime/' + target.default, import.meta.url);
		const declared = readFileSync(new URL('../packages/runtime/' + target.types, import.meta.url), 'utf8')
			.matchAll(/^export declare function ([\w$]+)/gm)
			.map(m => m[1]);
		assert.deepEqual(Object.keys(await import(url)).sort(), [...new Set(declared)].sort());
	});
}
