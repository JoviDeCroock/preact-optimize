import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';

export const stats = { saved: [] };

function TodoItem({ todo, onToggle, onRemove }) {
	return (
		<li class={todo.done ? 'done' : ''}>
			<input type="checkbox" checked={todo.done} onChange={() => onToggle(todo.id)} />
			<span>{todo.text}</span>
			<button class="remove" onClick={() => onRemove(todo.id)}>×</button>
		</li>
	);
}

export function App() {
	const [todos, setTodos] = useState([
		{ id: 1, text: 'Write compiler', done: true },
		{ id: 2, text: 'Test compiler', done: false }
	]);
	const [text, setText] = useState('');
	const [filter, setFilter] = useState('all');

	const visible = useMemo(
		() =>
			todos.filter(todo =>
				filter === 'all' ? true : filter === 'done' ? todo.done : !todo.done
			),
		[todos, filter]
	);
	const remaining = todos.filter(todo => !todo.done).length;

	const add = useCallback(
		event => {
			event.preventDefault();
			if (!text) return;
			setTodos(list => [...list, { id: list.length + 1, text, done: false }]);
			setText('');
		},
		[text]
	);
	const toggle = useCallback(id => {
		setTodos(list => list.map(todo => (todo.id === id ? { ...todo, done: !todo.done } : todo)));
	}, []);
	const remove = useCallback(id => {
		setTodos(list => list.filter(todo => todo.id !== id));
	}, []);

	useEffect(() => {
		stats.saved.push(todos.length);
	}, [todos]);

	return (
		<section class="todoapp">
			<header>
				<h1>todos</h1>
				<form onSubmit={add}>
					<input
						class="new"
						placeholder="What needs to be done?"
						value={text}
						onInput={event => setText(event.currentTarget.value)}
					/>
				</form>
			</header>
			<ul class="list">
				{visible.map(todo => (
					<TodoItem key={todo.id} todo={todo} onToggle={toggle} onRemove={remove} />
				))}
			</ul>
			<footer>
				<span class="count">
					{remaining} {remaining === 1 ? 'item' : 'items'} left
				</span>
				<nav>
					{['all', 'active', 'done'].map(name => (
						<button key={name} class={filter === name ? 'selected' : ''} onClick={() => setFilter(name)}>
							{name}
						</button>
					))}
				</nav>
			</footer>
		</section>
	);
}

export const steps = [
	root => input(root.querySelector('.new'), 'Ship it'),
	root => root.querySelector('form').dispatchEvent(new Event('submit')),
	root => root.querySelectorAll('input[type=checkbox]')[1].dispatchEvent(new Event('change')),
	root => root.querySelectorAll('nav button')[1].click(),
	root => root.querySelector('.remove').click(),
	root => root.querySelectorAll('nav button')[0].click()
];

function input(el, value) {
	el.value = value;
	el.dispatchEvent(new Event('input'));
}
