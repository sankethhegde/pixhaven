// Home page theme switch: ☀️ Light / 🌙 Dark radio buttons (Settings also offers "System").
import { useEffect, useState } from 'react';
import type { Settings } from '@shared/types';
import { api } from '../api';

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function ThemeSwitch({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const [dark, setDark] = useState(prefersDark);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  // With "System", show whichever theme is in effect right now.
  const current = settings.theme === 'system' ? (dark ? 'dark' : 'light') : settings.theme;
  const choose = async (theme: 'light' | 'dark') => onSettings(await api.setSettings({ theme }));

  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-full border border-line bg-panel p-1 gap-1">
      {([['light', '☀️', 'Light'], ['dark', '🌙', 'Dark']] as const).map(([value, emoji, label]) => (
        <label key={value} className={`flex items-center gap-1.5 h-8 px-3 rounded-full text-sm font-medium cursor-pointer transition
          ${current === value ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}>
          {/* onClick, not onChange: with "System" the matching radio already looks checked, and a click must still pin the choice. */}
          <input type="radio" name="theme" value={value} checked={current === value} onChange={() => {}} onClick={() => { if (settings.theme !== value) choose(value); }} className="sr-only" />
          <span aria-hidden="true" className="text-base leading-none">{emoji}</span>{label}
        </label>
      ))}
    </div>
  );
}
