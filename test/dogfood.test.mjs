// Patterns from dogfooding on a signals-first app: local signals and models
// whose `.value` is written by handlers, eager unwraps at the top of a
// component, and signals handed down as props.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compile, equivalent } from './harness.mjs';

const P = `import { signal, useSignal } from '@preact/signals';
import { useMemo } from 'preact/hooks';
export const stats = { renders: 0 };
export const count = signal(0);
function Field({ value, onInput }) { return <input value={value} onInput={onInput} />; }`;

const ALL = [{}, { hooks: true }, { blocks: true }, { hooks: true, hoistComponents: true, blocks: true }];

/** The per-file report from the Babel plugin. */
async function report(code, options = {}) {
	let out;
	await compile(code, 'babel', { ...options, report: (_, r) => (out = r) });
	return out;
}

/** Type into the first input of `root`. */
const type = (root, text) => {
	const input = root.querySelector('input');
	input.value = text;
	input.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
};

describe('signal writes', () => {
	test('a local signal written by a handler binds where it is read', async () => {
		const code = `${P}
	export function App() {
	  stats.renders++;
	  const draft = useSignal('');
	  return (
	    <div>
	      <input value={draft.value} onInput={e => (draft.value = e.currentTarget.value)} />
	      <p>{draft.value.trim().length} chars</p>
	      <Field value={draft.value} onInput={e => (draft.value = e.currentTarget.value)} />
	    </div>
	  );
	}`;
		assert.deepEqual((await report(code)).diagnostics, []);
		for (const options of ALL) {
			const runs = await equivalent(code, [(m, root) => type(root, ' ab '), (m, root) => type(root, 'abc')], options);
			assert.equal(runs.babel.stats.renders, 1);
			assert.equal(runs.none.stats.renders, 3);
		}
	});

	test('a model written through a member path', async () => {
		const code = `${P}
	function useModel() { return useMemo(() => ({ selected: signal(null), items: signal(['a', 'b']) }), []); }
	function Row({ name, selected, onPick }) { return <li class={selected ? 'on' : ''} onClick={onPick}>{name}</li>; }
	export function App() {
	  stats.renders++;
	  const model = useModel();
	  const items = model.items.value;
	  const selected = model.selected.value;
	  return (
	    <div>
	      <p>{selected ?? 'none'}</p>
	      <ul>{items.map(name => <Row key={name} name={name} selected={selected === name} onPick={() => (model.selected.value = name)} />)}</ul>
	      <button onClick={() => (model.items.value = [...model.items.value, 'c'])}>add</button>
	    </div>
	  );
	}`;
		assert.deepEqual((await report(code)).diagnostics, []);
		for (const options of ALL) {
			const runs = await equivalent(
				code,
				[
					(m, root) => root.querySelector('li').click(),
					(m, root) => root.querySelector('button').click(),
					(m, root) => root.querySelectorAll('li')[2].click()
				],
				options
			);
			assert.equal(runs.babel.stats.renders, 1);
		}
	});

	test('a signal prop written by the child', async () => {
		const code = `${P}
	function Editor({ draft }) {
	  stats.renders++;
	  const trimmed = draft.value.trim();
	  return <label>{trimmed || 'empty'}<input value={draft.value} onInput={e => (draft.value = e.currentTarget.value)} /></label>;
	}
	export function App() {
	  const draft = useSignal('x');
	  return <Editor draft={draft} />;
	}`;
		assert.deepEqual((await report(code)).diagnostics, []);
		for (const options of ALL) {
			const runs = await equivalent(code, [(m, root) => type(root, ' y '), (m, root) => type(root, '')], options);
			assert.equal(runs.babel.stats.renders, 1);
		}
	});

	test('an unwrap read by a handler sees the value from when it was called', async () => {
		const code = `${P}
	export function App() {
	  const n = count.value;
	  const log = () => (stats.seen = n);
	  return <button onClick={log}>{n}</button>;
	}`;
		for (const options of ALL) {
			const runs = await equivalent(
				code,
				[m => (m.count.value = 5), (m, root) => root.querySelector('button').click()],
				options
			);
			for (const via of ['none', 'babel', 'rolldown']) assert.equal(runs[via].module.stats.seen, 5, via);
		}
	});

	test('an object literal whose .value a handler writes stays a render-time read', async () => {
		// Each render makes a new `o`, so the next render reads 1 again: a hole
		// re-running on `count` would see the old object's 2.
		const code = `${P}
	export function App() {
	  const o = { value: 1 };
	  return <button onClick={() => (o.value = 2)}>{o.value + count.value}</button>;
	}`;
		assert.deepEqual(
			(await report(code)).diagnostics.map(d => d.reason),
			['unsafe-expression', 'unsafe-expression']
		);
		for (const options of ALL) {
			await equivalent(code, [(m, root) => root.querySelector('button').click(), m => m.count.value++], options);
		}
	});

	test('deleting .value is still a mutation', async () => {
		const code = `${P}
	export function App({ box = { value: 1 } }) {
	  return <button onClick={() => delete box.value}>{String(box.value) + count.value}</button>;
	}`;
		assert.deepEqual(
			(await report(code)).diagnostics.map(d => d.reason),
			['unsafe-expression', 'unsafe-expression']
		);
	});
});

describe('signal writes through other bindings', () => {
	test('a call result whose .value a handler writes stays a render-time read', async () => {
		const code = `${P}
	const box = n => ({ value: n });
	export function App() {
	  const o = box(1);
	  return <button onClick={() => (o.value = 2)}>{o.value + count.value}</button>;
	}`;
		assert.deepEqual(
			(await report(code)).diagnostics.map(d => d.reason),
			['unsafe-expression', 'unsafe-expression']
		);
		for (const options of ALL) {
			await equivalent(code, [(m, root) => root.querySelector('button').click(), m => m.count.value++], options);
		}
	});

	test('aliases and destructured props are signal writes', async () => {
		const code = `${P}
	function Editor(props) {
	  const { draft } = props;
	  const alias = props.draft;
	  return <input value={alias.value} onInput={e => (draft.value = e.currentTarget.value)} />;
	}
	export function App() {
	  const draft = useSignal('x');
	  return <div><p>{draft.value}</p><Editor draft={draft} /></div>;
	}`;
		assert.deepEqual((await report(code)).diagnostics, []);
		for (const options of ALL) await equivalent(code, [(m, root) => type(root, 'y')], options);
	});
});
