# preact-optimize

Compile-time JSX optimizations for Preact. It makes renders do less work without changing how you write components:

- **Static hoisting**: JSX that can't change between renders is created once and reused. With `hoistComponents`, a static `<Card title="x" />` stops re-rendering when its parent does.
- **Signal holes**: a JSX expression that reads `.value` gets its own computed and binds straight to the DOM (text, attribute, or a self-re-rendering region for vnodes and lists). The component around it no longer re-renders when that signal changes.
- **Hooks → signals** (opt-in): `useState`/`useReducer` state that is only read inside such holes and in closures is backed by a signal, so `setState` updates the DOM without re-rendering the component.

It ships as a Babel plugin and a Rolldown/Vite plugin built on Oxc. Both share one analysis module and are tested to produce identical DOM.

| Package | |
|---|---|
| [`babel-plugin-preact-optimize`](packages/babel) | Babel 7 and 8 |
| [`rolldown-plugin-preact-optimize`](packages/rolldown) | Rolldown and Vite 8 (`enforce: 'pre'`, runs before the Oxc JSX transform) |
| [`preact-optimize`](packages/runtime) | Runtime helpers the output imports (`/static`, `/signals`) |

## Usage

```js
// vite.config.js (Vite 8)
import preactOptimize from 'rolldown-plugin-preact-optimize';

export default {
	plugins: [preactOptimize({ hoistComponents: true, hooks: true })],
	oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } }
};
```

```js
// babel.config.js — list it before the JSX transform/preset
export default {
	plugins: [['babel-plugin-preact-optimize', { hooks: true }]],
	presets: [['@babel/preset-react', { runtime: 'automatic', importSource: 'preact' }]]
};
```

`signals` and `hooks` need `@preact/signals` installed.

| Option | Default | |
|---|---|---|
| `hoist` | `true` | Cache static JSX at module scope |
| `hoistComponents` | `false` | Also cache static trees that contain component elements |
| `signals` | `true` | Turn `.value` reads in JSX into DOM bindings |
| `hooks` | `false` | Back hole-only `useState`/`useReducer` state with signals |
| `runtime` | `'preact-optimize'` | Where helpers are imported from |
| `include` / `exclude` | `.jsx/.tsx/.js`, `node_modules` | Rolldown plugin only |

## What it does

```jsx
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';

const count = signal(0);

function Counter() {
	const [text, setText] = useState('');
	return (
		<div>
			<h1 class="title">Counter <small>v1</small></h1>
			<p class={count.value > 5 ? 'big' : ''}>{count.value} clicks</p>
			<input value={text} onInput={e => setText(e.currentTarget.value)} />
			{text && <Preview text={text} />}
		</div>
	);
}
```

becomes (with `hooks: true`, before the JSX transform):

```jsx
import { $static } from 'preact-optimize/static';
import { $hole, $useState } from 'preact-optimize/signals';
var _h1;

function Counter() {
	const [_text, setText] = $useState('');
	return (
		<div>
			{_h1 || (_h1 = $static(<h1 class="title">Counter <small>v1</small></h1>))}
			<p class={$hole(() => (count.value > 5 ? 'big' : ''))}>{$hole(() => count.value)} clicks</p>
			<input value={$hole(() => _text.value)} onInput={e => setText(e.currentTarget.value)} />
			{$hole(() => _text.value && <Preview text={_text.value} />)}
		</div>
	);
}
```

`Counter` renders once. Clicking or typing updates the `<p>`, the `<input>` and the `Preview` region and nothing else.

### Static hoisting

An element is static when it has no spread, no `ref`, and only literal attributes and children. Module-level constants also count, so `<p>Count: {count}</p>` with a module `const count = signal(0)` is static, and so is `<button onClick={reset}>` with a module `function reset`. The cache is filled on first use rather than at module init, so hoisted component references don't hit TDZ errors or import cycles.

`$static` marks the vnode so Preact always clones it before diffing. Without the mark, the first render would adopt the shared vnode and pin that render's DOM and vnode tree to the module. Clones keep the original `_original`, which is what Preact's strict-equality bail checks:

- **Fragments and components** (with `hoistComponents`) are skipped on re-render today.
- **Host elements** are still diffed. Core Preact has no equality bail for DOM vnodes yet, so hoisting them only saves allocation until it does.

### Signal holes

A hole is a JSX expression in a *bindable position* that reads `.value` while rendering. Bindable positions are:

- a child of a host element or fragment
- a host attribute other than `on*`, `ref`, `key`, `style` and `dangerouslySetInnerHTML`

Children of components are left alone, since a component may inspect `props.children`. Expressions that write, `await`, `yield` or call hooks are left alone too.

`$hole(fn)` evaluates `fn` once in its own computed, without tracking:

- **If it read signals**, the computed is returned and `@preact/signals` binds it. Text and attributes update in place. For vnode and array values, the `ReactiveTextNode` re-renders only that region.
- **If it read none** (e.g. `field.value` on a plain object), the plain value is returned and behaviour is unchanged.

### Hooks → signals

A `const [x, setX] = useState(...)` (or `useReducer`) at the top of a function is rewritten only when every render-time read of `x` is inside a hole. Reads inside closures (handlers, effects, `.map` callbacks, helpers) become `x$.value`, which tracks whatever runs them:

- **Called from a hole:** the hole subscribes.
- **Called during render:** the component subscribes, so it re-renders as before.
- **Called from a handler:** the read is untracked.

State that feeds component props, effect dependencies, derived locals or custom hook return values keeps its hook. The rule was taken from the [preactjs/framework](https://github.com/preactjs/framework) SFC compiler: run the setup once and let computeds own the template.

Writes are queued and committed on Preact's render tick (`options.debounceRendering`), all in one `batch()`. Code that runs after `setX()` in the same handler therefore still sees the previous value, and updater functions compose, exactly as with hooks.

## Semantics and deviations

- **Errors** thrown when a hole re-evaluates after a signal write surface from that write (as with any `@preact/signals` binding), not from the nearest error boundary.
- **`hoistComponents`** gives static component elements `memo()` semantics: they re-render from their own state, context and signals, not from their parent. Components that read mutable module state during render without signals won't see changes, and neither will legacy `getChildContext` consumers.
- **`hooks`**: closures read the latest *committed* state instead of their render's snapshot. This only differs for closures that outlive a re-render they would otherwise have seen, such as a `setTimeout` scheduled before an update. State with render-time reads (like effect dependencies) is never transformed, so effect cleanups keep their snapshot.
- **`.value` is a syntactic heuristic.** Non-signal `.value` reads in holes stay correct, but allocate a computed per render.
- **Hydration**: Preact 11.0.1 core mis-hydrates adjacent *numeric* text children (`<i>{0}{0}</i>` over server `<i>00</i>` becomes `000`). This happens without this plugin too; holes just make it more common.

## Numbers

From `pnpm bench` (jsdom, exact vnode counts per update):

| Scenario | none | default | + `hoistComponents` | + `hooks` |
|---|---|---|---|---|
| Signal text in a 60-node static page | 135 | 0 | 0 | 0 |
| Typing into a `useState` form, 20 static fields | 66 | 66 | 66 | 0 |
| Parent state + 20 static child components | 125 | 125 | 25 | 25 |

## Testing

`pnpm test` runs:

- behaviour tests that compile every fixture three ways (untransformed, Babel, Rolldown), render in jsdom and require identical DOM after every step
- a differential fuzzer generating random components with signals, state, conditionals, keyed lists and child components (`FUZZ_SEEDS=5000` to widen)
- SSR plus hydration equivalence through `preact-render-to-string`
- a Vite 8 build and dev-server run, and Babel 7 compatibility
