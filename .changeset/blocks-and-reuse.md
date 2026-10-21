---
'babel-plugin-preact-optimize': minor
'rolldown-plugin-preact-optimize': minor
'preact-optimize': minor
---

Add the experimental `blocks` option: host-only JSX trees render from a cloned DOM template and only patch their dynamic parts. Holes and derived values now reuse their computed across renders while their inputs stay the same, and converted state no longer goes through `useState`, so it adds no hook state to the component.
