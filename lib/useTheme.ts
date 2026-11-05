'use client';

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

/** Starts 'dark' to match the static HTML; the pre-paint script in layout.tsx has already applied
 *  the stored theme, so the mount effect reads that instead of storage. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot hydration
    if (document.documentElement.dataset.theme === 'light') setTheme('light');
  }, []);
  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { window.localStorage.setItem('multimeter-live:theme', next); } catch { /* still applies this page */ }
    setTheme(next);
  }, [theme]);
  return { theme, toggleTheme };
}
