# preact-optimize

Compile-time JSX optimizations for Preact. It makes renders do less work without changing how you write components:

- **Static hoisting**: JSX that can't change between renders is created once and reused. With `hoistComponents`, a static `<Card title="x" />` stops re-rendering when its parent does.
- **Signal holes**: a JSX expression that reads `.value` gets its own computed and binds straight to the DOM (text, attribute, or a self-re-rendering region for vnodes and lists). The component around it no longer re-renders when that signal changes.
- **Hooks → signals** (opt-in): `useState`/`useReducer` state whose render-time reads can all move into holes is backed by a signal, so `setState` updates the DOM without re-rendering the component. `useMemo` becomes a computed, and memo, callback and effect dependency lists stop listing that state: effects re-run when the signal changes instead.

It ships as a Babel plugin and a Rolldown/Vite plugin built on Oxc. Both share one analysis module and are tested to produce identical DOM.

| Package                                                |                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`babel-plugin-preact-optimize`](packages/babel)       | Babel 7 and 8                                                             |
| [`rolldown-plugin-preact-optimize`](packages/rolldown) | Rolldown and Vite 8 (`enforce: 'pre'`, runs before the Oxc JSX transform) |
| [`preact-optimize`](packages/runtime)                  | Runtime helpers the output imports (`/static`, `/signals`)                |

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

`signals`, `hooks` and `blocks` need `@preact/signals` installed.

| Option                | Default                         |                                                                                                      |
| --------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `hoist`               | `true`                          | Cache static JSX at module scope                                                                     |
| `hoistComponents`     | `false`                         | Also cache static trees that contain component elements                                              |
| `signals`             | `true`                          | Turn `.value` reads in JSX into DOM bindings                                                         |
| `hooks`               | `false`                         | Back `useState`/`useReducer` state with signals when no read needs the render                        |
| `blocks`              | `false`                         | Render host-only JSX trees from cloned DOM templates (experimental)                                  |
| `runtime`             | `'preact-optimize'`             | Where helpers are imported from                                                                      |
| `report`              |                                 | `(file, report) => void`, called per file with how many reactive reads moved and why the rest didn't |
| `include` / `exclude` | `.jsx/.tsx/.js`, `node_modules` | Rolldown plugin only                                                                                 |

## What it does

```jsx
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';

const count = signal(0);

function Counter() {
  const [text, setText] = useState('');
  return (
    <div>
      <h1 class="title">
        Counter <small>v1</small>
      </h1>
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
      {_h1 ||
        (_h1 = $static(
          <h1 class="title">
            Counter <small>v1</small>
          </h1>
        ))}
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

`$static` marks the vnode so Preact always clones it before diffing. Without the mark, the first render would adopt the shared vnode and pin that render's DOM and vnode tree to the module. Clones keep the original `_original`, which is what Preact's strict-equality bail checks. Core only bails on component vnodes (Fragments included), so a hoisted host element is wrapped in a Fragment carrying its key, and the whole subtree is skipped on re-render. Static components (with `hoistComponents`) are skipped the same way.

### Signal holes

A hole is a JSX expression in a _bindable position_ that reads `.value` while rendering. Bindable positions are:

- a child of a host element or fragment
- a host attribute other than `on*`, `ref`, `key`, `style` and `dangerouslySetInnerHTML`

Children of components are left alone, since a component may inspect `props.children`. Expressions that write, `await`, `yield` or call hooks are left alone too.

`$hole(fn)` evaluates `fn` once in its own computed, without tracking:

- **If it read signals**, the computed is returned and `@preact/signals` binds it. Text and attributes update in place. For vnode and array values, the `ReactiveTextNode` re-renders only that region.
- **If it read none** (e.g. `field.value` on a plain object), the plain value is returned and behaviour is unchanged.

The compiler also passes what the expression reads from its render (locals, props, converted state's signals, module bindings) and a per-site key: `$hole(fn, [deps], _k[i])`. When the component re-renders with the same inputs, the hole hands back the computed from its previous render instead of creating and evaluating a new one, so the binding stays put. Inputs compare with `Object.is`, and only primitives, functions and signals count: an object input could have been mutated in place, so it always makes a new computed. When a hole only reads properties of an object (`row.id`, `props.title`), those properties are its inputs instead, unless it calls a method on it. A hole that reads `this`, a ref's `.current` while evaluating, or a global that isn't known to be pure (`Date.now()`, `Math.random()`) is never reused. Holes inside `.map()` callbacks reuse by position. Only computeds holding a primitive are reused; a vnode can't be handed to Preact twice without losing its signal props.

### Derived values

A `const` (or never-reassigned `let`) in a component body whose initializer reads signals becomes `$derive(() => init)` when all of its own reads can move into holes. `const label = count.value > 1 ? 'many' : 'one'` then stops subscribing the component, and `{label}` binds like `{count.value}` would.

### Hooks → signals

With `hooks: true`, `const [x, setX] = useState(...)` (or `useReducer`) is backed by a signal when every read of `x` while rendering can move out of render:

- **Into a hole or derived value**, which reads `_x.value`.
- **Into a dependency list**: `useMemo(fn, [x])` becomes `$useMemo(fn, [], [_x])`, a computed that recomputes when `_x` changes. `useEffect(fn, [x])` becomes `$useEffect(fn, [], [_x])`, which re-runs the latest render's callback (cleanup first) after the DOM has updated, the way a re-render would have. `useCallback(fn, [x])` just drops `x`; the callback reads the signal when called.

Functions created during render (handlers, effect callbacks, cleanups, memo callbacks) start with a snapshot, `const x = _x.value`. A closure therefore sees one value per call, like it saw one value per render: a `setTimeout` scheduled from a handler still logs the value from when the handler ran, and code after `setX()` in the same handler still sees the previous value. Writes commit right away, so updater functions compose as with hooks, and a hole re-rendering a child is queued before Preact's render pass: a handler that sets a child's hook state and its parent's converted state renders the child once, with both.

Skipping the render is only correct when the render had no other job, so state also stays a hook when its component renders something the analysis can't follow, or hands a render-created function to code that could tell it apart from the next render's.

State stays a hook when a read can't move. The `report` option and the plan's diagnostics name the reason:

| Reason                  | Example                                                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hook-argument`         | `useFoo(x)`, or a dependency list the hook can't track (an unconverted memo, a custom hook)                                                                                                                                                                             |
| `hook-closure`          | `useCallback(() => x, [])` (React keeps the stale closure)                                                                                                                                                                                                              |
| `escaping-closure`      | a function reading `x` goes somewhere other than a call, a host element prop, an `on*`/`ref` component prop or a hook: a render prop (`renderItem={it => ... x ...}`), a dependency list (`useEffect(load, [load])` with `load` a callback reading `x`), a subscription |
| `control-flow`          | `if (x) return null`                                                                                                                                                                                                                                                    |
| `local-binding`         | `let y = x; y++`                                                                                                                                                                                                                                                        |
| `reassigned`            | the state name is assigned, or used as a JSX tag                                                                                                                                                                                                                        |
| `outside-function-body` | a parameter default or class field reads it, so there is no body to snapshot in                                                                                                                                                                                         |
| `effect-every-render`   | the component has a `useEffect`/`useLayoutEffect` without a dependency list                                                                                                                                                                                             |
| `render-reads-ref`      | the render reads a ref's `.current` (`{renders.current}`), which only refreshes on re-render                                                                                                                                                                            |
| `unread`                | `const [tick, setTick] = useState(0)` with `tick` unused: the setter exists to re-render                                                                                                                                                                                |

Converted state is held with `useMemo`, not `useState`, so it adds no hook state: Preact's hooks don't wrap the component's `shouldComponentUpdate`, and `@preact/signals` keeps its own bail-out for the component.

The approach follows the [preactjs/framework](https://github.com/preactjs/framework) SFC compiler: run setup once and let computeds own the template.

### Blocks

With `blocks: true`, a JSX tree made only of HTML elements, text and expressions compiles to a DOM template, the way Solid and Vue Vapor compile templates:

```jsx
<tr key={id} class={selected === id ? 'danger' : ''}>
  <td class="col-md-1">{id}</td>
  <td class="col-md-4">
    <a onClick={() => setSelected(id)}>{label}</a>
  </td>
</tr>
```

becomes (with `hooks: true`, `selected` converted)

```jsx
var _t = $template(
  s => (
    <tr class={s[0]}>
      <td class="col-md-1">{s[1]}</td>
      <td class="col-md-4">
        <a onClick={s[2]}>{s[3]}</a>
      </td>
    </tr>
  ),
  [0]
);
// ...
$block([_t, () => (_selected.value === id ? 'danger' : ''), id, () => setSelected(id), label], id);
```

`$block` returns a single `<tr>` vnode with no children. Preact creates and keys the root as usual. Its inside is cloned from the template once and never diffed: each render compares the slot values with the last ones and writes only the slots that changed. Slots that read signals become functions run by one effect per block, so selecting a row updates its `class` without rendering anything.

A tree is a block when it has at least two content nodes and:

- every element is a lowercase HTML tag other than `svg`, `math`, `select`, `option`, `optgroup`, `textarea`, `template`, `script`, `style` or `slot`, and the root is not also an SVG element name (`a`, `title`, `text`...)
- attributes are plain names with no spread, `ref`, `dangerouslySetInnerHTML`, `is` or `children`, and only the root has a `key`
- children are text, elements, or expressions that contain no JSX and aren't `children`/`props.children`

At runtime a text slot holding a vnode, an array or other object renders the original JSX for that render instead. Server rendering always renders the original JSX.

### Optimization coverage

`report` gets `{ reads, moved, diagnostics, keptState }` per file. `reads` counts reactive reads made while a component renders (`.value` reads, and state reads with `hooks`). `moved` counts those that no longer subscribe the component. On the realistic components in [`test/corpus`](test/corpus) (a todo app, signup form, dashboard with a signal store, tabs with a measuring layout effect, debounced search, reducer counter, modal with a document listener), every read moves:

| Component | reads moved | component renders, `hooks: true` (none → optimized) |
| --------- | ----------- | --------------------------------------------------- |
| counter   | 5 / 5       | 5 → 1                                               |
| dashboard | 16 / 16     | 12 → 4                                              |
| form      | 18 / 18     | 24 → 8                                              |
| modal     | 2 / 2       | 7 → 3                                               |
| search    | 15 / 15     | 27 → 14                                             |
| tabs      | 10 / 10     | 5 → 1                                               |
| todo      | 10 / 10     | 20 → 12                                             |

The remaining renders are child components receiving new props and initial mounts.

From `pnpm bench:browser` (Chrome, minified production bundles, median of 20 runs, ratio to the untransformed build; lower is better):

| Benchmark                      | none     | default | + `hoistComponents` | + `hooks` | + `blocks` |
| ------------------------------ | -------- | ------- | ------------------- | --------- | ---------- |
| create 1,000 rows              | 23.95 ms | 1.00    | 0.99                | 1.06      | 0.92       |
| update every 10th row          | 7.45 ms  | 0.99    | 0.97                | 1.17      | 0.85       |
| select a row                   | 1.70 ms  | 0.94    | 0.94                | 0.32      | 0.18       |
| swap two rows                  | 5.20 ms  | 1.00    | 0.95                | 1.22      | 0.74       |
| remove a row                   | 4.90 ms  | 0.94    | 0.96                | 1.24      | 0.69       |
| clear 1,000 rows               | 3.55 ms  | 1.01    | 0.90                | 1.11      | 0.85       |
| 100 signal counter writes      | 4.50 ms  | 0.31    | 0.31                | 0.31      | 0.31       |
| 100 keystrokes (`useState`)    | 4.70 ms  | 1.02    | 1.03                | 0.49      | 0.47       |
| 50 parent re-renders           | 1.70 ms  | 1.00    | 0.65                | 0.47      | 0.41       |
| geometric mean (13 benchmarks) |          | 0.83    | 0.80                | 0.63      | 0.50       |

`hooks` without `blocks` makes list updates slower: a hole per row (`selected === row.id`) costs more on every re-render of the list than it saves on `select`. `blocks` removes that cost.

In the [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) (keyed, `{ hooks, hoistComponents, blocks }`, all five measured in one run), the CPU geometric mean relative to vanilla JS is 1.35 for preact-optimize, against 1.66 for the same Preact hooks app untransformed, 1.15 for Solid 2 and 1.06 for Vue Vapor. Most of the remaining gap is in updates that touch a few rows (update every 10th, select): the list still re-renders every row's block.

## Semantics and deviations

- **Errors** thrown when a hole re-evaluates after a signal write surface from that write (as with any `@preact/signals` binding), not from the nearest error boundary.
- **`hoistComponents`** gives static component elements `memo()` semantics: they re-render from their own state, context and signals, not from their parent. Components that read mutable module state during render without signals won't see changes, and neither will legacy `getChildContext` consumers.
- **`hooks`** is experimental. It assumes what React Compiler assumes: a render is a pure function of props, state, context and signals. A render that reads mutable module state, `Date.now()` or a store without a subscription stops refreshing when the state it used to piggyback on converts (refs are detected, see `render-reads-ref`).
  - Closures take their snapshot when they are called, not when the render that created them ran. This differs only for a closure created in one render and called after later updates without being recreated, e.g. one stored on first render only.
  - Functions passed to component props named `on*` are taken to be event handlers. A child that lists such a prop in an effect's dependencies, or compares it in `memo`, no longer sees a new function when the converted state changes.
  - Converted effects re-run after signals have flushed the DOM: layout effects a few microtasks after the update rather than synchronously in the commit, passive effects on the next frame as before. A converted parent effect can therefore run before a child's effects from the same update, and each converted effect runs its cleanup right before its own re-run.
  - State compares with `Object.is` except that `-0` to `0` is no update (signals compare with `!==`).
  - Reads hidden behind calls (`const f = () => x; ... {f()}`) aren't seen by the analysis. They stay correct because the component subscribes when it renders, but they don't move.
  - React Refresh/prefresh hook signatures don't see `$useState`, so adding or removing converted state in a hot update isn't detected as a signature change and the component isn't remounted. Prefer enabling `hooks` in production builds.
- **Hole reuse** assumes functions are pure, the way the hooks transform assumes renders are: a hole like `{format(count.value)}` whose `format` reads a mutable module variable won't refresh when the component re-renders with the same `count`, since `format` is the same function. It still refreshes when `count` changes.
- **`.value` is a syntactic heuristic.** Non-signal `.value` reads in holes stay correct, but allocate a computed per render. A non-signal `x.value` dependency stays an ordinary dependency.
- **`NaN`** renders as an empty string from a hole, as from any `@preact/signals` text binding, where Preact renders `NaN`.
- **Blocks** are experimental.
  - Hydrating a block replaces the server-rendered contents of its root element instead of adopting them.
  - A block's template passes through `options.vnode` once, not per render, and its slot values never do, so `preact/compat`'s value-dependent normalization (numeric `style` values, for one) doesn't apply, and devtools don't see inside a block. Leave `blocks` off with compat.
  - Static attributes come from the template, so a cloned element can list its attributes in a different order than Preact would set them.
  - As with holes, errors thrown by a slot re-running after a signal write surface from that write.
- **Hydration**: Preact 11.0.1 core mis-hydrates adjacent _numeric_ text children (`<i>{0}{0}</i>` over server `<i>00</i>` becomes `000`). This happens without this plugin too; holes just make it more common.

## Numbers

From `pnpm bench` (jsdom, exact counts per update):

| Scenario                                        | none                   | default      | + `hoistComponents` | + `hooks`    |
| ----------------------------------------------- | ---------------------- | ------------ | ------------------- | ------------ |
| Signal text in a 60-node static page            | 135 vnodes             | 0            | 0                   | 0            |
| Typing into a `useState` form, 20 static fields | 66 vnodes, 1 render    | 26, 1 render | 26, 1 render        | 0, 0 renders |
| Parent state + 20 static child components       | 125 vnodes, 22 renders | 105, 22      | 25, 2               | 4, 2         |

## Testing

`pnpm test` runs:

- behaviour tests that compile every fixture three ways (untransformed, Babel, Rolldown), render in jsdom and require identical DOM after every step
- the corpus above, checked for identical DOM, identical side effects (effect runs, cleanups, layout measurements), no extra renders, and exact optimization coverage
- unit tests of the analysis on both Babel and Oxc ASTs, which must produce the same plan
- a differential fuzzer generating random components with signals, state, reducers, memos, callbacks, effects that write observable DOM, timers and async handlers, conditionals, keyed lists and child components (`FUZZ_SEEDS=5000` to widen). Planted mutants (for example, reading signals in closures instead of snapshotting) are caught within a few hundred seeds.
- SSR plus hydration equivalence through `preact-render-to-string`
- `act()` from `preact/test-utils` flushing converted updates and effects
- a Vite 8 build and dev-server run, and Babel 7 compatibility

`pnpm coverage` requires 100% line, branch and function coverage of `packages/*/src`.

## Development

| Script                              |                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm test`                         | the suite above                                                                                     |
| `pnpm coverage`                     | the suite with 100% coverage enforced                                                               |
| `pnpm fuzz`                         | 2,000 differential fuzz seeds and 200 SSR seeds (`FUZZ_SEEDS`, `FUZZ_START`, `SSR_SEEDS` to change) |
| `pnpm check`                        | `oxlint`, `oxfmt --check` and `tsc` over the published declarations and `test/types`                |
| `pnpm format`                       | format with `oxfmt`                                                                                 |
| `pnpm bench` / `pnpm bench:browser` | the benchmarks above                                                                                |
| `pnpm changeset`                    | describe a change for the next release                                                              |

The three packages release together through [changesets](https://github.com/changesets/changesets): merging to `main` opens a "Version Packages" PR, and merging that publishes.
