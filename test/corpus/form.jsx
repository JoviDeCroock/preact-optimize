import { useEffect, useRef, useState } from 'preact/hooks';

export const stats = { submitted: null };

const EMAIL = /^[^@\s]+@[^@\s]+$/;

function Field({ label, error, children }) {
	return (
		<label class="field">
			<span class="label">{label}</span>
			{children}
			{error && <span class="error">{error}</span>}
		</label>
	);
}

export function App() {
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [touched, setTouched] = useState(false);
	const first = useRef();

	const nameError = touched && !name ? 'Required' : null;
	const emailError = touched && !EMAIL.test(email) ? 'Invalid email' : null;
	const strength = password.length > 10 ? 'strong' : password.length > 5 ? 'ok' : 'weak';
	const valid = !!name && EMAIL.test(email) && password.length > 5;

	useEffect(() => {
		if (first.current) first.current.dataset.focused = 'yes';
	}, []);

	return (
		<form
			class="signup"
			onSubmit={event => {
				event.preventDefault();
				setTouched(true);
				if (valid) stats.submitted = { name, email };
			}}
		>
			<h2>Create an account</h2>
			<p class="hint">All fields are required.</p>
			<Field label="Name" error={nameError}>
				<input ref={first} class="name" value={name} onInput={e => setName(e.currentTarget.value)} />
			</Field>
			<Field label="Email" error={emailError}>
				<input class="email" type="email" value={email} onInput={e => setEmail(e.currentTarget.value)} />
			</Field>
			<Field label="Password">
				<input class="password" type="password" value={password} onInput={e => setPassword(e.currentTarget.value)} />
				<meter class={'strength ' + strength} value={password.length} max="12" />
			</Field>
			<button type="submit" disabled={!valid && touched}>
				Sign up
			</button>
		</form>
	);
}

export const steps = [
	root => root.querySelector('form').dispatchEvent(new Event('submit')),
	root => input(root.querySelector('.name'), 'Ada'),
	root => input(root.querySelector('.email'), 'ada@'),
	root => input(root.querySelector('.email'), 'ada@example.com'),
	root => input(root.querySelector('.password'), 'correct horse'),
	root => root.querySelector('form').dispatchEvent(new Event('submit'))
];

function input(el, value) {
	el.value = value;
	el.dispatchEvent(new Event('input'));
}
