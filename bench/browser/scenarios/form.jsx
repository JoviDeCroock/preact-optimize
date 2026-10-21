// A controlled input next to static fields: with `hooks`, typing updates the
// signal-backed state without re-rendering the form.
import { useState } from 'preact/hooks';

export const ops = {};

const FIELDS = Array.from({ length: 30 }, (_, i) => `field-${i}`);

export function App() {
	const [text, setText] = useState('');
	const [touched, setTouched] = useState(false);
	ops.type = () => setText(t => (t.length < 40 ? t + 'x' : ''));
	ops.touch = () => setTouched(t => !t);
	return (
		<form class={touched ? 'touched' : ''}>
			<fieldset>
				<legend>Profile</legend>
				{FIELDS.map(name => (
					<label key={name} class="field">
						<span>{name}</span>
						<input name={name} placeholder="Static field" />
					</label>
				))}
			</fieldset>
			<input value={text} onInput={e => setText(e.currentTarget.value)} />
			<p class="hint">
				{text.length} / 40 characters{text.length > 30 ? ' (almost full)' : ''}
			</p>
		</form>
	);
}
