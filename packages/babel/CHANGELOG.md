# babel-plugin-preact-optimize

## 0.1.0

### Minor Changes

- [`84c0d72`](https://github.com/JoviDeCroock/preact-optimize/commit/84c0d7200a3c48bfa911e2abaa7fbd4c13b90246) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add the experimental `blocks` option: host-only JSX trees render from a cloned DOM template and only patch their dynamic parts. Converted state no longer goes through `useState`, so it adds no hook state to the component.

- [`6cf6be1`](https://github.com/JoviDeCroock/preact-optimize/commit/6cf6be1a774945f4a21e5e77ca194a9fe007a478) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - With `blocks`, a `.map()` that is the only child of an HTML element and returns a keyed block compiles to a list: its rows are matched by key, patched and moved without Preact diffing them, and when the row function reads nothing besides its item that can change between renders, a row isn't rendered again for an item it rendered before.

### Patch Changes

- [`b237c0e`](https://github.com/JoviDeCroock/preact-optimize/commit/b237c0e1afd9a980d8caf311f08f68d833369e4d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Holes keep reads of locals that are reassigned or have properties written anywhere in render, so a hole re-running after a signal write can't see a later value. Attributes reading an imported or computed module binding (a signal, say) are no longer hoisted. Holes in child position render `NaN` and BigInts like Preact.

- [`0f007ff`](https://github.com/JoviDeCroock/preact-optimize/commit/0f007ff63ffeb4a0b8a62355711125269a5362d4) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Hoisted elements without element children are no longer wrapped in a Fragment, which made lists with small static leaves slower to mount and unmount.

- [`2c6ce14`](https://github.com/JoviDeCroock/preact-optimize/commit/2c6ce143125e6dd91782f0d495c1a712af3cccea) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Writing a signal's `.value` (`draft.value = e.target.value`, `model.selected.value = id`) no longer keeps every read through that name in render. Such writes only count as mutation when the name is also declared with something that could be a new object every render, such as an object literal or a non-hook call. On a signals-first app this moves 595 of 650 render-time reads out of render, up from 241 of 417, mostly eager unwraps like `const user = session.user.value` that now become derived values.
- Updated dependencies [[`84c0d72`](https://github.com/JoviDeCroock/preact-optimize/commit/84c0d7200a3c48bfa911e2abaa7fbd4c13b90246), [`b237c0e`](https://github.com/JoviDeCroock/preact-optimize/commit/b237c0e1afd9a980d8caf311f08f68d833369e4d), [`0f007ff`](https://github.com/JoviDeCroock/preact-optimize/commit/0f007ff63ffeb4a0b8a62355711125269a5362d4), [`6cf6be1`](https://github.com/JoviDeCroock/preact-optimize/commit/6cf6be1a774945f4a21e5e77ca194a9fe007a478), [`2c6ce14`](https://github.com/JoviDeCroock/preact-optimize/commit/2c6ce143125e6dd91782f0d495c1a712af3cccea)]:
  - preact-optimize@0.1.0
