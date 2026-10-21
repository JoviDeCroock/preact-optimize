---
'preact-optimize': patch
'babel-plugin-preact-optimize': patch
'rolldown-plugin-preact-optimize': patch
---

Hoisted elements without element children are no longer wrapped in a Fragment, which made lists with small static leaves slower to mount and unmount.
