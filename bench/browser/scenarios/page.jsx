// A mostly static page with a few signal-driven values: holes bind the
// signals to the DOM, so updates skip rendering the page.
import { signal } from '@preact/signals';

const count = signal(0);
const user = signal({ name: 'Ada', unread: 3 });

export const ops = {
	count: () => count.value++,
	user: () => (user.value = { name: 'Ada', unread: user.peek().unread + 1 })
};

function Section({ title }) {
	return (
		<section class="card">
			<h2>{title}</h2>
			<ul>
				{['one', 'two', 'three', 'four', 'five'].map(item => (
					<li class="item" key={item}>
						<b>{item}</b> <i>static description of {item}</i>
					</li>
				))}
			</ul>
		</section>
	);
}

export function App() {
	return (
		<main>
			<header>
				<h1>Dashboard</h1>
				<nav>
					<a href="/inbox">Inbox ({user.value.unread})</a>
					<a href="/settings">Settings</a>
				</nav>
				<p class="greeting">Hello {user.value.name}</p>
			</header>
			<p class="count" data-count={count.value}>
				Clicked {count.value} times
			</p>
			<Section title="Alpha" />
			<Section title="Beta" />
			<Section title="Gamma" />
			<Section title="Delta" />
			<footer>
				<small>Static footer text that never changes.</small>
			</footer>
		</main>
	);
}
