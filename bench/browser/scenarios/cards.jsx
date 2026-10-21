// A parent re-rendering around static child components: `hoistComponents`
// caches the children so they skip re-rendering.
import { useState } from 'preact/hooks';

export const ops = {};

function Card({ title }) {
	return (
		<article class="card">
			<h3>{title}</h3>
			<p>Body text for the card, rendered by a component.</p>
			<button type="button">Open</button>
		</article>
	);
}

export function App() {
	const [tick, setTick] = useState(0);
	ops.tick = () => setTick(t => t + 1);
	return (
		<div class="grid">
			<p class="tick">Tick {tick}</p>
			<Card title="One" />
			<Card title="Two" />
			<Card title="Three" />
			<Card title="Four" />
			<Card title="Five" />
			<Card title="Six" />
			<Card title="Seven" />
			<Card title="Eight" />
			<Card title="Nine" />
			<Card title="Ten" />
		</div>
	);
}
