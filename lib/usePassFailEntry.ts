'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CaptureEngine } from './capture';
import { parseEntry, type ToleranceMode } from './passfail';

// Quiet period before an entry is final. Typing "10" passes through "1", and judging that
// intermediate flashes FAIL at 1% on the way to 10%.
const PF_INPUT_DEBOUNCE_MS = 350;

/**
 * Pass/Fail entry, held as the operator's raw strings so SI forms survive typing (`4.5k` must not
 * be mangled on its way through `4.`). The inputs stay live; everything downstream (echo, band,
 * live verdict, capture) reads the debounced `*Settled` copies, so a half-typed value is never
 * judged. `reset` clears the settled copies synchronously too.
 */
export function usePassFailEntry(engine: CaptureEngine) {
  const [reference, setReference] = useState('');
  const [tolerance, setTolerance] = useState('');
  const [toleranceMode, setToleranceMode] = useState<ToleranceMode>('percent');
  const [referenceSettled, setReferenceSettled] = useState('');
  const [toleranceSettled, setToleranceSettled] = useState('');

  // Each field independently. The cleanup cancels the pending commit on every keystroke, so the
  // value lands only once typing pauses.
  useEffect(() => {
    const id = setTimeout(() => setReferenceSettled(reference), PF_INPUT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [reference]);
  useEffect(() => {
    const id = setTimeout(() => setToleranceSettled(tolerance), PF_INPUT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [tolerance]);

  useEffect(() => {
    const { ref, tol, band } = parseEntry(referenceSettled, toleranceSettled, toleranceMode);
    engine.setPassFailConfig(ref, tol, band, toleranceMode);
  }, [engine, referenceSettled, toleranceSettled, toleranceMode]);

  const reset = useCallback(() => {
    setReference('');
    setTolerance('');
    setReferenceSettled('');
    setToleranceSettled('');
  }, []);

  return {
    reference, setReference, referenceSettled,
    tolerance, setTolerance, toleranceSettled,
    toleranceMode, setToleranceMode,
    reset,
  };
}
