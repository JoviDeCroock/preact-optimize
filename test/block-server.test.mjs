// No jsdom here: blocks without a DOM (a server that doesn't go through
// render-to-string's skip-effects flag) render the original JSX.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { h } from 'preact';
import { jsx, jsxs } from 'preact/jsx-runtime';
import { renderToString } from 'preact-render-to-string';
import { signal } from '@preact/signals';
import { $block, $template } from '../packages/runtime/src/block.js';

test('without a DOM, a block is its original JSX', () => {
	assert.equal(typeof Element, 'undefined');
	const t = $template(s => jsxs('p', { class: s[0], children: [s[1], jsx('i', {})] }), [0]);
	const on = signal(true);
	const vnode = $block([t, () => (on.value ? 'on' : 'off'), 'text'], 'k');
	assert.equal(vnode.type, 'p');
	assert.equal(vnode.key, 'k');
	assert.equal(renderToString(h('div', null, vnode)), '<div><p class="on">text<i></i></p></div>');
});
