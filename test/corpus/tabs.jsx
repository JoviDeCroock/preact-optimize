import { useLayoutEffect, useRef, useState } from 'preact/hooks';

export const stats = { measured: [] };

const TABS = [
	{ id: 'overview', label: 'Overview', body: 'Everything at a glance.' },
	{ id: 'activity', label: 'Activity', body: 'Recent events.' },
	{ id: 'settings', label: 'Settings', body: 'Preferences.' }
];

export function App() {
	const [active, setActive] = useState('overview');
	const [expanded, setExpanded] = useState(false);
	const panel = useRef();
	const current = TABS.find(tab => tab.id === active);

	useLayoutEffect(() => {
		if (panel.current) stats.measured.push(panel.current.textContent.length);
	}, [active, expanded]);

	return (
		<div class="tabs">
			<div role="tablist">
				{TABS.map(tab => (
					<button
						key={tab.id}
						role="tab"
						aria-selected={tab.id === active}
						class={tab.id === active ? 'tab active' : 'tab'}
						onClick={() => setActive(tab.id)}
					>
						{tab.label}
					</button>
				))}
			</div>
			<div role="tabpanel" ref={panel} class="panel">
				<h3>{current.label}</h3>
				<p>{current.body}</p>
				{expanded && <p class="more">More about {current.label.toLowerCase()}.</p>}
				<button class="toggle" onClick={() => setExpanded(!expanded)}>
					{expanded ? 'Less' : 'More'}
				</button>
			</div>
		</div>
	);
}

export const steps = [
	root => root.querySelectorAll('[role=tab]')[1].click(),
	root => root.querySelector('.toggle').click(),
	root => root.querySelectorAll('[role=tab]')[2].click(),
	root => root.querySelector('.toggle').click()
];
