'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CaptureEngine } from './capture';
import { toFinite } from './settings';

/** The operator's trigger: the threshold as typed, and the arm switch. Reaches the engine after
 *  commit. `reset` clears both; the engine clears its own copies itself on a mode change. */
export function useTriggerEntry(engine: CaptureEngine) {
  const [threshold, setThreshold] = useState('');
  const [armed, setArmed] = useState(false);
  // Two effects, not one: see `CaptureEngine.setTriggerArmed`.
  useEffect(() => { engine.setTriggerArmed(armed); }, [engine, armed]);
  useEffect(() => { engine.setTriggerThreshold(toFinite(threshold)); }, [engine, threshold]);
  const reset = useCallback(() => {
    setThreshold('');
    setArmed(false);
  }, []);
  return { threshold, setThreshold, armed, setArmed, reset };
}
