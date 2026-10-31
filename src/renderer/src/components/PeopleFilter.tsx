// v2.12: search and sort a list of people (Photos → People, and Sort's review). The chosen order is remembered.
import { useMemo, useState } from 'react';
import type { PersonSummary } from '@shared/types';
import { Icon } from './ui';

export type PeopleOrder = 'most' | 'fewest' | 'number' | 'name';
const ORDERS: { value: PeopleOrder; label: string }[] = [
  { value: 'most', label: 'Most photos' }, { value: 'fewest', label: 'Fewest photos' },
  { value: 'number', label: 'Person number' }, { value: 'name', label: 'Name (A–Z)' },
];
const KEY = 'people.order';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** People whose name (or number) contains the search, exact matches first, in the chosen order. */
export function findPeople(list: PersonSummary[], query: string, order: PeopleOrder): PersonSummary[] {
  const q = query.trim().toLowerCase();
  const hit = q ? list.filter(p => p.label.toLowerCase().includes(q) || String(p.num) === q) : list;
  const cmp: Record<PeopleOrder, (a: PersonSummary, b: PersonSummary) => number> = {
    most: (a, b) => b.photos - a.photos || a.num - b.num,
    fewest: (a, b) => a.photos - b.photos || a.num - b.num,
    number: (a, b) => a.num - b.num,
    name: (a, b) => collator.compare(a.label, b.label),
  };
  const exact = (p: PersonSummary) => (q && (p.label.toLowerCase() === q || String(p.num) === q) ? 0 : 1);
  return [...hit].sort((a, b) => exact(a) - exact(b) || cmp[order](a, b));
}

export function usePeopleFilter() {
  const [query, setQuery] = useState('');
  const [order, setOrderState] = useState<PeopleOrder>(() => {
    try { const v = localStorage.getItem(KEY) as PeopleOrder | null; return v && ORDERS.some(o => o.value === v) ? v : 'most'; } catch { return 'most'; }
  });
  const setOrder = (o: PeopleOrder) => { setOrderState(o); try { localStorage.setItem(KEY, o); } catch { /* not remembered */ } };
  return { query, setQuery, order, setOrder, searching: query.trim() !== '' };
}

export function useFoundPeople(list: PersonSummary[], f: ReturnType<typeof usePeopleFilter>) {
  return useMemo(() => findPeople(list, f.query, f.order), [list, f.query, f.order]);
}

export function PeopleFilter({ f }: { f: ReturnType<typeof usePeopleFilter> }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="relative w-56">
        <Icon name="search" size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input value={f.query} onChange={e => f.setQuery(e.target.value)} placeholder="Search people" aria-label="Search people"
          onKeyDown={e => { if (e.key === 'Escape') f.setQuery(''); }}
          className="w-full h-8 rounded-lg bg-panel-2 border border-line pl-8 pr-7 text-sm outline-none focus:border-accent" />
        {f.searching && (
          <button onClick={() => f.setQuery('')} aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center text-muted hover:text-fg"><Icon name="x" size={13} /></button>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-muted">Sort by
        <select value={f.order} onChange={e => f.setOrder(e.target.value as PeopleOrder)} aria-label="Sort people"
          className="h-8 rounded-lg bg-panel-2 border border-line px-2 text-sm text-fg">
          {ORDERS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    </div>
  );
}
