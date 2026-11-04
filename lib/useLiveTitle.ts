import { useEffect } from 'react';
import { displayUnit, type Reading } from './parser';

const APP_NAME = 'Multimeter·Live';

// `reading` is never cleared on disconnect or silence, so connected-and-not-silent — not a
// null reading — is what keeps a stale value out of the tab.
export function useLiveTitle(reading: Reading | null, connected: boolean, silent: boolean) {
  useEffect(() => {
    const value = connected && !silent && reading ? [reading.display, displayUnit(reading.unit)].filter(Boolean).join(' ') : '';
    const title = value ? `${value} · ${APP_NAME}` : APP_NAME;
    document.title = title;
  }, [reading, connected, silent]);
}
