---
'preact-optimize': patch
'babel-plugin-preact-optimize': patch
'rolldown-plugin-preact-optimize': patch
---

Holes keep reads of locals that are reassigned or have properties written anywhere in render, so a hole re-running after a signal write can't see a later value. Attributes reading an imported or computed module binding (a signal, say) are no longer hoisted. Holes in child position render `NaN` and BigInts like Preact.
