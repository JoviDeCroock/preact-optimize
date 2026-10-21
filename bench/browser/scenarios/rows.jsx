// js-framework-benchmark's keyed Preact hooks app, unchanged apart from the
// buttons: idiomatic `useState` code the compiler has to cope with.
import { useState } from 'preact/hooks';

const A = ['pretty', 'large', 'big', 'small', 'tall', 'short', 'long', 'handsome', 'plain', 'quaint', 'clean'];
const C = ['red', 'yellow', 'blue', 'green', 'pink', 'brown', 'purple', 'white', 'black', 'orange'];
const N = ['table', 'chair', 'house', 'bbq', 'desk', 'car', 'pony', 'cookie', 'sandwich', 'burger', 'pizza'];

let seed = 1;
let id = 1;
const random = max => (seed = (seed * 16807) % 2147483647) % max;
const buildData = count =>
	Array.from({ length: count }, () => ({
		id: id++,
		label: `${A[random(A.length)]} ${C[random(C.length)]} ${N[random(N.length)]}`
	}));

export const ops = {};

export function App() {
	const [data, setData] = useState([]);
	const [selected, setSelected] = useState(null);

	ops.create = () => setData(buildData(1000));
	ops.append = () => setData(prev => [...prev, ...buildData(1000)]);
	ops.update = () => setData(prev => prev.map((row, i) => (i % 10 ? row : { id: row.id, label: row.label + ' !!!' })));
	ops.select = () => setSelected(data[4].id);
	ops.swap = () =>
		setData(prev => {
			const next = prev.slice();
			const tmp = next[1];
			next[1] = next[998];
			next[998] = tmp;
			return next;
		});
	ops.remove = () => setData(prev => prev.filter((_, i) => i !== 4));
	ops.clear = () => setData([]);

	const remove = id => setData(prev => prev.filter(row => row.id !== id));

	return (
		<div class="container">
			<div class="jumbotron">
				<div class="row">
					<div class="col-md-6">
						<h1>Preact Hooks keyed</h1>
					</div>
				</div>
			</div>
			<table class="table table-hover table-striped test-data">
				<tbody>
					{data.map(row => (
						<tr key={row.id} class={selected === row.id ? 'danger' : ''}>
							<td class="col-md-1">{row.id}</td>
							<td class="col-md-4">
								<a onClick={() => setSelected(row.id)}>{row.label}</a>
							</td>
							<td class="col-md-1">
								<a onClick={() => remove(row.id)}>
									<span class="glyphicon glyphicon-remove" aria-hidden="true" />
								</a>
							</td>
							<td class="col-md-6" />
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
