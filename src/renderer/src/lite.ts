// 1.1.2 Light mode, for parts of the screen far from the settings (the player, thumbnails): what is switched off, and
// whether the laptop is on battery. The app shell keeps it up to date.
import { useEffect, useState } from 'react';
import type { LiteFeature, Settings } from '@shared/types';
import { liteOff } from '@shared/types';

let settings: Pick<Settings, 'lite'> | null = null;
let battery = false;
const listeners = new Set<() => void>();
const tell = () => { for (const l of listeners) l(); };

export function setLite(s: Pick<Settings, 'lite'> | null): void { settings = s; tell(); }
export function setBattery(on: boolean): void { battery = on; tell(); }
export const isOff = (f: LiteFeature) => liteOff(settings, f);
export const onBattery = () => battery;

/** Re-draws when Light mode or the power source changes. */
export function useLite(): { off: (f: LiteFeature) => boolean; battery: boolean } {
  const [, setN] = useState(0);
  useEffect(() => { const l = () => setN(n => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return { off: isOff, battery };
}
