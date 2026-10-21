import { useEffect, useMemo, useState } from 'preact/hooks';

export const stats = { requests: [] };

const ITEMS = ['apple', 'apricot', 'banana', 'blueberry', 'cherry', 'cranberry', 'date'];

function Highlight({ text, query }) {
	const at = text.indexOf(query);
	if (!query || at < 0) return <span>{text}</span>;
	return (
		<span>
			{text.slice(0, at)}
			<mark>{query}</mark>
			{text.slice(at + query.length)}
		</span>
	);
}

export function App() {
	const [query, setQuery] = useState('');
	const [debounced, setDebounced] = useState('');
	const [limit, setLimit] = useState(3);

	useEffect(() => {
		const id = setTimeout(() => setDebounced(query), 0);
		return () => clearTimeout(id);
	}, [query]);

	useEffect(() => {
		stats.requests.push(debounced);
	}, [debounced]);

	const results = useMemo(() => ITEMS.filter(item => item.includes(debounced)), [debounced]);

	return (
		<div class="search">
			<input class="query" value={query} onInput={e => setQuery(e.currentTarget.value)} placeholder="Search fruit" />
			<p class="status">
				{query !== debounced ? 'Searching…' : `${results.length} results for "${debounced}"`}
			</p>
			<ul>
				{results.slice(0, limit).map(item => (
					<li key={item}>
						<Highlight text={item} query={debounced} />
					</li>
				))}
			</ul>
			{results.length > limit && (
				<button class="more" onClick={() => setLimit(limit + 3)}>
					Show {results.length - limit} more
				</button>
			)}
		</div>
	);
}

export const steps = [
	root => input(root.querySelector('.query'), 'a'),
	() => new Promise(r => setTimeout(r, 5)),
	root => root.querySelector('.more') && root.querySelector('.more').click(),
	root => input(root.querySelector('.query'), 'berry'),
	() => new Promise(r => setTimeout(r, 5))
];

function input(el, value) {
	el.value = value;
	el.dispatchEvent(new Event('input'));
}
