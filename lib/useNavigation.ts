'use client';

import { useCallback, useEffect, useState } from 'react';

// The real set of views: a URL hash is validated against it, never trusted.
export const NAV_IDS = ['dashboard', 'data-log', 'pass-fail', 'history', 'settings'] as const;
export type NavId = (typeof NAV_IDS)[number];

const fromHash = (): NavId => {
  const id = window.location.hash.slice(1);
  return (NAV_IDS as readonly string[]).includes(id) ? (id as NavId) : 'dashboard';
};

/**
 * The active view and the open drawer. The URL hash is the source of truth for the view: it
 * survives a reload, gives Back/Forward between views, and deep-links. Read only after mount —
 * the page is prerendered, so `location` does not exist at render time.
 *
 * `sheet` is the open drawer below lg: a view's own panel (open while it equals `view`, so any
 * view change closes it) or the header's Connection card. One value, so only one is open.
 */
export function useNavigation() {
  const [view, setView] = useState<NavId>('dashboard');
  const [sheet, openSheet] = useState<NavId | 'connection' | null>(null);
  const closeSheet = useCallback(() => openSheet(null), []);

  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration from the URL */
    setView(fromHash());
    // Back/Forward across pushState entries fires popstate; an edited address bar fires
    // hashchange. Both resolve through the same validated read, so handling them twice is
    // harmless and missing either is not.
    const sync = () => {
      setView(fromHash());
      openSheet(null);
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  // Presentational only: never touches logging, the trigger, or the port. pushState (not
  // `location.hash =`) so each view is its own history entry AND no hashchange fires — the
  // listener above is left for Back/Forward and manual edits.
  const navigate = useCallback((id: NavId) => {
    setView(id);
    openSheet(null);
    if (window.location.hash.slice(1) !== id) {
      window.history.pushState(null, '', `#${id}`);
    }
  }, []);

  return { view, sheet, openSheet, closeSheet, navigate };
}
