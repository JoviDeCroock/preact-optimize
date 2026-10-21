---
'preact-optimize': minor
'babel-plugin-preact-optimize': minor
'rolldown-plugin-preact-optimize': minor
---

With `blocks`, a `.map()` that is the only child of an HTML element and returns a keyed block compiles to a list: its rows are matched by key, patched and moved without Preact diffing them, and when the row function reads nothing besides its item that can change between renders, a row isn't rendered again for an item it rendered before.
