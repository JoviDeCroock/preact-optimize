import { createContext } from 'preact';
import { useContext, useMemo, useState } from 'preact/hooks';
import { computed, signal } from '@preact/signals';

// A store of signals in a context value that is never recreated.
function createStore() {
	const rows = signal([
		{ id: 1, name: 'alpha', value: 30 },
		{ id: 2, name: 'beta', value: 12 },
		{ id: 3, name: 'gamma', value: 54 }
	]);
	const total = computed(() => rows.value.reduce((sum, row) => sum + row.value, 0));
	return { rows, total };
}

export const store = createStore();
const Store = createContext(store);

function Summary() {
	const { rows, total } = useContext(Store);
	return (
		<dl class="summary">
			<dt>Rows</dt>
			<dd>{rows.value.length}</dd>
			<dt>Total</dt>
			<dd>{total.value}</dd>
			<dt>Average</dt>
			<dd>{rows.value.length ? Math.round(total.value / rows.value.length) : 0}</dd>
		</dl>
	);
}

function Bars() {
	const { rows, total } = useContext(Store);
	return (
		<div class="bars">
			{rows.value.map(row => (
				<div key={row.id} class="bar" style={{ width: (row.value / total.value) * 100 + '%' }}>
					{row.name}
				</div>
			))}
		</div>
	);
}

function Table() {
	const { rows } = useContext(Store);
	const [sort, setSort] = useState('name');
	const [desc, setDesc] = useState(false);
	const sorted = useMemo(() => {
		const list = [...rows.peek()];
		list.sort((a, b) => (a[sort] > b[sort] ? 1 : -1) * (desc ? -1 : 1));
		return list;
	}, [sort, desc, rows.value]);
	return (
		<table>
			<thead>
				<tr>
					<th onClick={() => setSort('name')} class={sort === 'name' ? 'active' : ''}>Name</th>
					<th onClick={() => setSort('value')} class={sort === 'value' ? 'active' : ''}>Value</th>
					<th>
						<button class="dir" onClick={() => setDesc(d => !d)}>{desc ? '↓' : '↑'}</button>
					</th>
				</tr>
			</thead>
			<tbody>
				{sorted.map(row => (
					<tr key={row.id}>
						<td>{row.name}</td>
						<td>{row.value}</td>
						<td />
					</tr>
				))}
			</tbody>
		</table>
	);
}

export function App() {
	return (
		<Store.Provider value={store}>
			<main class="dashboard">
				<h1>Dashboard</h1>
				<Summary />
				<Bars />
				<Table />
			</main>
		</Store.Provider>
	);
}

export const steps = [
	(root, module) => (module.store.rows.value = [...module.store.rows.value, { id: 4, name: 'delta', value: 8 }]),
	root => root.querySelectorAll('th')[1].click(),
	root => root.querySelector('.dir').click(),
	(root, module) => (module.store.rows.value = module.store.rows.value.slice(1))
];
