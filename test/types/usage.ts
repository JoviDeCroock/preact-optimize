// Type-level usage of the published declarations; `pnpm typecheck` compiles
// it, nothing runs it.
import babelPlugin, { type PreactOptimizePlugin } from 'babel-plugin-preact-optimize';
import rolldownPlugin, { type OptimizeReport } from 'rolldown-plugin-preact-optimize';
import { $static } from 'preact-optimize/static';
import { $derive, $hole, $text, $useMemo, $useReducer, $useState } from 'preact-optimize/signals';
import { $block, $template } from 'preact-optimize/block';
import { analyze, type Plan } from 'preact-optimize/compiler';
import { signal, type ReadonlySignal, type Signal } from '@preact/signals';
import { jsx } from 'preact/jsx-runtime';

const report = (file: string, r: OptimizeReport) => r.diagnostics.map(d => `${file}:${d.line} ${d.reason}`);

const babel: PreactOptimizePlugin = babelPlugin({}, { hooks: true, blocks: true, report });
babel.name satisfies string;

const vite = rolldownPlugin({ hoistComponents: true, include: /\.tsx$/, report });
vite.enforce satisfies 'pre';
// @ts-expect-error unknown option
rolldownPlugin({ hoisting: true });

const count = signal(1);
const text: number = $hole(() => count.value * 2);
const child: number = $text(() => count.value * 2);
const doubled: ReadonlySignal<number> = $derive(() => count.value * 2);

const [n, setN] = $useState(() => 0);
n satisfies Signal<number>;
setN(v => v + 1);
const [state, dispatch] = $useReducer((s: number, a: 'inc') => s + 1, 0);
dispatch('inc');
// @ts-expect-error not an action
dispatch('dec');
const memo: ReadonlySignal<string> = $useMemo(() => String(state.value), [], [state]);

const tpl = $template(s => jsx('p', { class: s[0], children: s[1] }), [0]);
$block([tpl, () => (count.value ? 'on' : 'off'), text + child], 'key');
$static(jsx('i', {}));

declare const program: unknown;
const plan: Plan = analyze(program, '', { hooks: true });
plan.wraps.map(w => w.kind);

export { doubled, memo };
