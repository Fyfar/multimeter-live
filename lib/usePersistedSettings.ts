'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';

/** Settings, starting at defaults so the static-export HTML matches the first client render. */
export function usePersistedSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const updateSettings = useCallback(
    (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );

  // Restoring is deliberately inert: no setting starts logging, arms the trigger, or opens a port.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot hydration
    setSettings(loadSettings());
  }, []);

  // Skips the first run (mount, still defaults) so stored values are not clobbered before the
  // hydration above has applied them.
  const persistReadyRef = useRef(false);
  useEffect(() => {
    if (!persistReadyRef.current) { persistReadyRef.current = true; return; }
    saveSettings(settings);
  }, [settings]);

  return { settings, updateSettings };
}
