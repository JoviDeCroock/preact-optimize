import { useEffect, useState } from 'preact/hooks';

export const stats = { listeners: 0 };

function Modal({ title, onClose, children }) {
	useEffect(() => {
		const onKey = event => event.key === 'Escape' && onClose();
		stats.listeners++;
		document.addEventListener('keydown', onKey);
		return () => {
			stats.listeners--;
			document.removeEventListener('keydown', onKey);
		};
	}, [onClose]);
	return (
		<div class="backdrop" onClick={onClose}>
			<div class="modal" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
				<h2>{title}</h2>
				{children}
			</div>
		</div>
	);
}

export function App() {
	const [open, setOpen] = useState(false);
	const [count, setCount] = useState(0);
	const close = () => setOpen(false);
	return (
		<div class="page">
			<p>Opened {count} times</p>
			<button
				class="open"
				onClick={() => {
					setOpen(true);
					setCount(count + 1);
				}}
			>
				Open
			</button>
			{open && (
				<Modal title="Hello" onClose={close}>
					<p>Press Escape to close.</p>
				</Modal>
			)}
		</div>
	);
}

export const steps = [
	root => root.querySelector('.open').click(),
	() => document.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape' })),
	root => root.querySelector('.open').click(),
	root => root.querySelector('.backdrop').click()
];
