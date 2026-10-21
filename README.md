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

A fresh computed per render is intentional: the closure captures that render's props and state, and the component re-renders (and recreates the hole) whenever those change. Because the computed can re-run after the render returns, a hole keeps its reads in render when they could see a different value by then: a local that is reassigned anywhere (`let total = 0; ... total += x`, `var` loop counters) or has a property assigned or deleted (`o.v = 1`; refs excepted), and a module binding that is not a constant.

Holes in child position go through `$text`, which hands `NaN` and BigInts to `@preact/signals` as strings: its text binding renders falsy values other than `0` as nothing, where Preact renders `NaN` and `0n`.

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

- every element is a lowercase HTML tag other than `svg`, `math`, `select`, `option`, `optgroup`, `textarea`, `template`, `script`, `style` or `slot`, and the root is not also an SVG or MathML element name (`a`, `title`, `mi`, `mrow`...)
- attributes are plain names, each at most once per element, with no spread, `ref`, `dangerouslySetInnerHTML`, `innerHTML`, `innerText`, `textContent`, `is` or `children`, and only the root has a `key`
- children are text, elements, or expressions that contain no JSX and aren't `children`/`props.children`

At runtime a text slot holding a vnode, an array or other object renders the original JSX for that render instead. Server rendering always renders the original JSX.

#### Lists

A `.map()` that is the only child of an HTML element, whose callback takes one parameter and returns a keyed block (after `const`/`let` declarations at most), becomes a list:

```jsx
<tbody>{data.map(row => <tr key={row.id}>...</tr>)}</tbody>
// becomes
$list(<tbody />, data, row => $block([_t, ...], row.id), _t, 1)
```

The element's children are no longer Preact's: rows are matched by key, patched like any block, and only the rows outside the longest run already in order are moved. The last argument says whether the callback is _pure_: it reads nothing that can change between renders other than its parameter. That means module constants and functions, state setters, converted state (read in its slots, as signals), and component functions made only of those. A pure callback isn't called again for an item it rendered before, the way `memo` skips a component whose props are the same, so updating ten rows of a thousand renders ten rows. Otherwise every row renders as before, and only the diff moves out of Preact.

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

From `pnpm bench:browser` (Chrome, minified production bundles, median of 15 runs, ratio to the untransformed build; lower is better):

| Benchmark                   | none     | default | + `hoistComponents` | + `hooks` | + `blocks` |
| --------------------------- | -------- | ------- | ------------------- | --------- | ---------- |
| create 1,000 rows           | 21.90 ms | 1.00    | 1.00                | 1.08      | 0.90       |
| replace 1,000 rows          | 28.60 ms | 0.95    | 0.94                | 1.03      | 0.74       |
| update every 10th row       | 6.20 ms  | 0.95    | 0.98                | 1.21      | 0.69       |
| select a row                | 1.80 ms  | 1.00    | 1.00                | 0.22      | 0.17       |
| swap two rows               | 3.90 ms  | 1.00    | 0.95                | 1.36      | 0.51       |
| remove a row                | 3.60 ms  | 0.97    | 0.97                | 1.39      | 0.53       |
| append 1,000 rows           | 24.90 ms | 0.99    | 1.01                | 1.09      | 0.90       |
| clear 1,000 rows            | 2.20 ms  | 1.09    | 1.00                | 1.27      | 1.00       |
| 100 signal counter writes   | 4.50 ms  | 0.29    | 0.29                | 0.29      | 0.27       |
| 100 signal object writes    | 4.40 ms  | 0.32    | 0.32                | 0.30      | 0.27       |
| 100 keystrokes (`useState`) | 4.60 ms  | 1.02    | 1.00                | 0.41      | 0.41       |
| 200 parent class toggles    | 5.30 ms  | 1.00    | 1.00                | 0.04      | 0.06       |
| 50 parent re-renders        | 1.60 ms  | 1.00    | 0.62                | 0.44      | 0.38       |
| geometric mean              |          | 0.83    | 0.79                | 0.55      | 0.42       |

`hooks` without `blocks` makes list updates slower: a hole per row (`selected === row.id`) costs more on every re-render of the list than it saves on `select`. `blocks` removes that cost.

In the [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) (keyed, `{ hooks, hoistComponents, blocks }`, all five measured in one run), the geometric mean of each CPU benchmark's mean time relative to vanilla JS is 1.14 for preact-optimize, against 1.61 for the same Preact hooks app untransformed, 1.08 for Solid 2 and 1.06 for Vue Vapor. The row list compiles to a pure `$list`, so update every 10th row, select and swap spend 2.3–3.3 ms in script (Solid 2: 1.8–2.6 ms, untransformed: about 15 ms); the remaining gap is mostly in creating rows (run 1k: 6.3 ms script against Solid's 4.0).

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
- **Mutation the analysis can't see.** Writes are found by name (`x = ...`, `x++`, `o.v = ...`, `delete o.v`), not through calls. A hole that re-runs after a signal write sees an object or array as it is then, where Preact keeps showing what the render saw until the next render. That differs when the object is mutated through a method after the JSX was created (`const a = [n]; const el = <p>{a.length + count.value}</p>; a.push(1)`), or, with `hooks`, when converted object state is mutated in place from outside the component (React, too, expects state to be replaced, not mutated).
- **`.value` is a syntactic heuristic.** Non-signal `.value` reads in holes stay correct, but allocate a computed per render. A non-signal `x.value` dependency stays an ordinary dependency.
- **Blocks** are experimental.
  - Hydrating a block replaces the server-rendered contents of its root element instead of adopting them.
  - A block's template passes through `options.vnode` once, not per render, and its slot values never do, so `preact/compat`'s value-dependent normalization (numeric `style` values, for one) doesn't apply, and devtools don't see inside a block. Leave `blocks` off with compat.
  - Static attributes come from the template, so a cloned element can list its attributes in a different order than Preact would set them.
  - As with holes, errors thrown by a slot re-running after a signal write surface from that write.
  - A list reuses a pure row while its item is the same value, so a row doesn't see an item mutated in place, as with `memo`. Errors from a pure row's callback are thrown from the list's element, so a component that is its own error boundary catches them where Preact would pass them to its parent. When a new item's row turns out to hold a vnode in its text, that row is missing for one render: the list re-renders as plain children from then on.
- **Hydration**: Preact 11.0.1 core mis-hydrates adjacent _numeric_ text children (`<i>{0}{0}</i>` over server `<i>00</i>` becomes `000`). This happens without this plugin too; holes just make it more common.

## Numbers

From `pnpm bench` (jsdom, exact counts per update):

| Scenario                                        | none                   | default      | + `hoistComponents` | + `hooks`    |
| ----------------------------------------------- | ---------------------- | ------------ | ------------------- | ------------ |
| Signal text in a 60-node static page            | 135 vnodes             | 0            | 0                   | 0            |
| Typing into a `useState` form, 20 static fields | 66 vnodes, 1 render    | 26, 1 render | 26, 1 render        | 0, 0 renders |
| Parent state + 20 static child components       | 125 vnodes, 22 renders | 125, 22      | 25, 2               | 4, 2         |

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
