'use client';

import { useEffect } from 'react';

/**
 * The browser asks before the page unloads while there are rows, saved or not: a saved session
 * still needs an explicit Restore, so a misclicked reload interrupts the run either way.
 * Registered ONLY while there is something to lose: a permanently-registered beforeunload
 * handler is a signal to the browser in its own right (bfcache eligibility, PWA install
 * heuristics), so an idle app must not carry one. This also covers the service worker's Reload
 * button, which goes through window.location.reload() and is this app's most likely cause of
 * session loss.
 */
export function useUnloadGuard(hasRows: boolean): void {
  useEffect(() => {
    if (!hasRows) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older browsers still gate the dialog on this
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasRows]);
}
