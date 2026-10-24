---
'preact-optimize': patch
'babel-plugin-preact-optimize': patch
'rolldown-plugin-preact-optimize': patch
---

Writing a signal's `.value` (`draft.value = e.target.value`, `model.selected.value = id`) no longer keeps every read through that name in render. Such writes only count as mutation when the name is also declared with something that could be a new object every render, such as an object literal or a non-hook call. On a signals-first app this moves 595 of 650 render-time reads out of render, up from 241 of 417, mostly eager unwraps like `const user = session.user.value` that now become derived values.
