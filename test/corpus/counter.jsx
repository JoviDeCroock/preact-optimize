import { useReducer } from 'preact/hooks';

function reducer(state, action) {
	switch (action.type) {
		case 'inc':
			return { ...state, count: state.count + state.step, history: [...state.history, state.count] };
		case 'step':
			return { ...state, step: action.step };
		case 'undo':
			return state.history.length
				? { ...state, count: state.history[state.history.length - 1], history: state.history.slice(0, -1) }
				: state;
	}
	return state;
}

export function App() {
	const [state, dispatch] = useReducer(reducer, { count: 0, step: 1, history: [] });
	return (
		<div class="counter">
			<h2>Counter</h2>
			<output>{state.count}</output>
			<label>
				Step
				<select value={state.step} onChange={e => dispatch({ type: 'step', step: +e.currentTarget.value })}>
					<option value="1">1</option>
					<option value="5">5</option>
					<option value="10">10</option>
				</select>
			</label>
			<button class="inc" onClick={() => dispatch({ type: 'inc' })}>
				+{state.step}
			</button>
			<button class="undo" disabled={!state.history.length} onClick={() => dispatch({ type: 'undo' })}>
				Undo
			</button>
			<small>{state.history.length} changes</small>
		</div>
	);
}

export const steps = [
	root => root.querySelector('.inc').click(),
	root => {
		const select = root.querySelector('select');
		select.value = '5';
		select.dispatchEvent(new Event('change'));
	},
	root => root.querySelector('.inc').click(),
	root => root.querySelector('.undo').click()
];
