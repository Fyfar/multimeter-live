'use client';

import { useEffect, useRef } from 'react';
import { createBeeper, type Beeper } from './beep';

/** The page's one beeper (one AudioContext), shared by verdict tones and the no-data alarm.
 *  Created client-side after mount, disposed on unmount; null until then. */
export function useBeeper() {
  const ref = useRef<Beeper | null>(null);
  useEffect(() => {
    ref.current = createBeeper();
    return () => {
      ref.current?.dispose();
      ref.current = null;
    };
  }, []);
  return ref;
}
