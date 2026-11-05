'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Beeper } from './beep';
import type { ConnectionStatus } from './connection';
import type { Reading } from './parser';

// Connected-but-silent threshold. The ZT703s streams continuously, so 3 s of silence is clearly
// abnormal — meter off / lead broken.
const NO_DATA_MS = 3000;

/**
 * The no-data detector: `noData` = connected but silent past NO_DATA_MS, polled while connected.
 * `current` changes once per batch, so its change is the silence clock's reset; the clock is also
 * seeded on connect (catches a meter that never sends anything). A dismissal lasts for one outage.
 */
export function useNoDataAlarm({ status, current, enabled, audio, beeper }: {
  status: ConnectionStatus;
  current: Reading | null;
  enabled: boolean;
  audio: boolean;
  beeper: RefObject<Beeper | null>;
}) {
  const [noData, setNoData] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const lastDataAtRef = useRef(0);

  useEffect(() => { lastDataAtRef.current = Date.now(); }, [current]);

  useEffect(() => {
    if (status !== 'connected') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear condition when not connected
      setNoData(false);
      return;
    }
    lastDataAtRef.current = Date.now();
    const id = setInterval(() => {
      setNoData(Date.now() - lastDataAtRef.current > NO_DATA_MS);
    }, 750);
    return () => clearInterval(id);
  }, [status]);

  // Re-arm per outage: once the condition clears (data resumed or disconnected), drop any prior
  // dismissal so the next silence shows the warning again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-arm dismissal on clear
    if (!noData) setDismissed(false);
  }, [noData]);

  // One flag for both the overlay and the audio, so the alarm can never sound without the
  // overlay and stops on dismiss / data-resume / disconnect.
  const overlayVisible = enabled && noData && !dismissed;
  useEffect(() => {
    const b = beeper.current;
    if (!b) return;
    if (overlayVisible && audio) b.start();
    else b.stop();
  }, [beeper, overlayVisible, audio]);

  const dismiss = useCallback(() => setDismissed(true), []);
  return { noData, overlayVisible, dismiss };
}
