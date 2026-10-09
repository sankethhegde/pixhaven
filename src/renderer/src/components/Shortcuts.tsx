// Keyboard shortcuts (v2.1): one list, shown by "?" in the Library and in Settings.
import { useEffect } from 'react';
import { Icon } from './ui';

export const SHORTCUTS: { area: string; keys: [string, string][] }[] = [
  {
    area: 'Library',
    keys: [
      ['← → ↑ ↓', 'Move between photos and videos (Shift: select as you go)'],
      ['Enter', 'Open the photo or video'],
      ['Space', 'Select or unselect'],
      ['Ctrl+A', 'Select everything shown'],
      ['Esc', 'Clear the selection or the search'],
      ['1 – 5, 0', 'Stars for the selection (0 clears)'],
      ['L', 'Labels & stars for the selection'],
      ['F2', 'Rename'],
      ['Ctrl+F or /', 'Search'],
      ['Backspace, Alt+←', 'Back'],
      ['Alt+→', 'Forward'],
      ['Alt+↑', 'Up one folder'],
      ['F5', 'Refresh'],
      ['P', 'Play all (labelled view or a playlist)'],
      ['?', 'This list'],
    ],
  },
  {
    area: 'Photo viewer',
    keys: [
      ['← →', 'Previous / next'],
      ['1 – 5, 0', 'Stars (0 clears)'],
      ['S', 'Labels & stars panel'],
      ['+ / −', 'Zoom in / out'],
      ['Ctrl+0', 'Fit to window'],
      ['Esc', 'Close'],
    ],
  },
  {
    area: 'Video player',
    keys: [
      ['Space or K', 'Play / pause'],
      ['← →', 'Back / forward 5 s (Shift: 30 s)'],
      ['J / L', 'Back / forward 10 s'],
      ['↑ ↓', 'Volume'],
      ['M', 'Mute'],
      ['F', 'Full screen'],
      ['< >', 'Slower / faster'],
      ['N / P', 'Next / previous video'],
      ['1 – 5, 0', 'Stars (0 clears)'],
      ['S', 'Labels & stars panel'],
      ['Esc', 'Close'],
    ],
  },
];

export function ShortcutList({ columns = 3 }: { columns?: number }) {
  return (
    <div className="grid gap-6" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {SHORTCUTS.map(g => (
        <div key={g.area}>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">{g.area}</div>
          <div className="space-y-1.5">
            {g.keys.map(([k, what]) => (
              <div key={k + what} className="flex items-start gap-3 text-sm">
                <kbd className="shrink-0 min-w-[5.5rem] text-xs font-mono rounded-md border border-line bg-panel-2 px-1.5 py-0.5 text-center">{k}</kbd>
                <span className="text-muted leading-snug">{what}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === '?') { onClose(); e.preventDefault(); e.stopPropagation(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div className="w-[920px] max-w-[95vw] max-h-[85vh] overflow-y-auto rounded-2xl bg-panel border border-line shadow-2xl p-6" onClick={e => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="flex items-center mb-5">
          <div className="font-semibold">Keyboard shortcuts</div>
          <button className="ml-auto h-8 w-8 rounded-lg hover:bg-panel-2 flex items-center justify-center" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <ShortcutList />
      </div>
    </div>
  );
}
