'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createParser, type Reading } from './parser';
import { clearPortRecord, loadPortRecord, savePortRecord } from './settings';

export type SerialStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected';

// How long a candidate port gets to produce its first parseable reading before we give up
// on it and try the next.
//
// CALIBRATION KNOB — bench-derived, not arbitrary. Measured against a ZT703s on a CP2102:
// a live port takes ~1 s to its first PARSED reading, because the parser emits nothing
// until a second packet delimits the first (docs/hardware.md). 2500 is ~2.5x that, which
// is the margin, not slack: an earlier 1200 was only ~20% over the measured latency and
// would have intermittently rejected the real port and fallen through to disconnected.
//
// The upper bound is only how long a WRONG candidate stalls the reconnect before the next
// is tried. It is deliberately NOT bounded by the 3 s no-data threshold: the probe holds
// status at 'connecting', and the no-data detector returns early unless status is
// 'connected', so that warning cannot fire during a probe at any value.
//
// Re-measure if the meter's packet rate changes.
const PROBE_MS = 2500;

function isSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

// Per-read-loop state. `stop` is deliberately NOT keepReadingRef: that ref means "the
// single connection slot is claimed", and during a probe the slot stays claimed across
// several read loops as failed candidates are torn down one after another. Conflating the
// two would release the slot between candidates and let a user-initiated connect() start
// a second port mid-probe.
//
// `live` marks the loop that IS the current connection. A probe loop starts not-live and
// is promoted on success. Only a live loop may react to the device vanishing by releasing
// the slot — otherwise a candidate unplugged mid-probe would free the slot underneath the
// probe that is still walking the remaining candidates.
type LoopControl = { stop: boolean; live: boolean };

/**
 * Web Serial lifecycle hook. All access to navigator.serial is guarded so that
 * SSR / `next build` prerendering never touches a browser-only API.
 */
export function useSerial(onReadings: (readings: Reading[]) => void) {
  const [status, setStatus] = useState<SerialStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const keepReadingRef = useRef(false);
  const ctlRef = useRef<LoopControl | null>(null);

  // Always call the latest callback without re-creating connect().
  const onReadingsRef = useRef(onReadings);
  onReadingsRef.current = onReadings;

  // Browser capability detection must run after mount: navigator is undefined
  // during SSR/prerender, so we start 'disconnected' and downgrade on the client.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check
    if (!isSupported()) setStatus('unsupported');
  }, []);

  const readLoop = useCallback(
    async (port: SerialPort, ctl: LoopControl, onFirstData?: () => void) => {
      const parser = createParser();
      const decoder = new TextDecoder();
      let sawData = false;

      while (port.readable && !ctl.stop) {
        const reader = port.readable.getReader();
        readerRef.current = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              const readings = parser.push(decoder.decode(value, { stream: true }));
              if (readings.length) {
                // Readings parsed during a successful probe are real measurements, not
                // test traffic — they go to the consumer like any other batch.
                if (!sawData) { sawData = true; onFirstData?.(); }
                onReadingsRef.current(readings);
              }
            }
          }
        } catch (e) {
          // Suppress the AbortError thrown by reader.cancel() during a normal disconnect
          // or when a failed probe candidate is torn down. `live` is the second half of
          // that: a candidate that opens and then faults (device pulled, node that never
          // carries data) is a failed GUESS, not a failure the operator needs told about
          // — auto-reconnect is specified to end silently. Only the promoted loop, and
          // connect()'s own loop, may raise a banner.
          if (!ctl.stop && ctl.live) {
            setError(e instanceof Error ? e.message : String(e));
          }
        } finally {
          reader.releaseLock();
          readerRef.current = null;
        }
      }

      // If the loop exited because the device disconnected (not via disconnect() and not
      // via a probe teardown), reset session state so connect() is not permanently blocked.
      if (!ctl.stop && ctl.live && portRef.current === port) {
        keepReadingRef.current = false;
        portRef.current = null;
        ctlRef.current = null;
        port.close().catch(() => {}); // best-effort; device may have already gone
        setStatus('disconnected');
      }
    },
    [],
  );

  // Stop the active read loop and close the active port, without touching status or the
  // slot claim. Shared by disconnect() and by the probe's per-candidate teardown.
  const teardown = useCallback(async () => {
    if (ctlRef.current) ctlRef.current.stop = true;
    try {
      // Must wait for cancel() to resolve before close(): cancel() causes the pending
      // read() to complete, which schedules releaseLock() as a microtask. Calling close()
      // synchronously (before that microtask runs) throws "Cannot close a port with an
      // active reader" and silently leaks the port.
      await readerRef.current?.cancel();
    } catch {
      /* reader already gone */
    }
    try {
      await portRef.current?.close();
    } catch {
      /* port already closed */
    }
    portRef.current = null;
    ctlRef.current = null;
  }, []);

  // Open one candidate and wait for it to prove itself by delivering a parseable reading.
  // Resolves true if it did. A port that opens but stays silent (a macOS dial-in node, or
  // some other device that happens to share the meter's VID/PID) resolves false.
  const probe = useCallback(
    async (port: SerialPort, baudRate: number): Promise<boolean> => {
      try {
        await port.open({ baudRate });
      } catch {
        return false; // already held by another tab, or gone since enumeration
      }
      portRef.current = port;
      const ctl: LoopControl = { stop: false, live: false };
      ctlRef.current = ctl;

      const gotData = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), PROBE_MS);
        void readLoop(port, ctl, () => finish(true)).then(() => finish(false));
      });

      if (!gotData) {
        await teardown();
        return false;
      }
      ctl.live = true; // promoted: from here it is the connection, not a candidate
      return true;
    },
    [readLoop, teardown],
  );

  const rememberPort = useCallback((port: SerialPort, baudRate: number) => {
    const info = port.getInfo();
    if (info.usbVendorId !== undefined && info.usbProductId !== undefined) {
      savePortRecord({
        usbVendorId: info.usbVendorId,
        usbProductId: info.usbProductId,
        baudRate,
      });
    }
  }, []);

  const connect = useCallback(
    async (baudRate: number) => {
      if (!isSupported()) {
        setStatus('unsupported');
        return;
      }
      if (keepReadingRef.current) return; // already connected, connecting, or probing
      const serial = navigator.serial;
      if (!serial) return; // narrowing for TS; isSupported() already guarantees this
      keepReadingRef.current = true; // claim the slot before any await
      try {
        setError(null);
        setStatus('connecting');
        const port = await serial.requestPort();
        await port.open({ baudRate });
        portRef.current = port;
        const ctl: LoopControl = { stop: false, live: true };
        ctlRef.current = ctl;
        setStatus('connected');
        rememberPort(port, baudRate);
        void readLoop(port, ctl); // fire-and-forget; loop ends on disconnect
      } catch (e) {
        keepReadingRef.current = false;
        const msg = e instanceof Error ? e.message : String(e);
        // User dismissed the port picker — not an error worth surfacing.
        if (!msg.includes('No port selected')) {
          setError(msg);
        }
        setStatus('disconnected');
      }
    },
    [readLoop, rememberPort],
  );

  // Only ever called by the operator pressing Disconnect — nothing internal routes here,
  // so it is safe to read as an explicit intent to stop using this device. Forgetting the
  // record is what makes that intent survive a reload: otherwise the next load would grab
  // the port straight back, which matters when the port was freed FOR something else.
  // A later manual connect re-records it.
  const disconnect = useCallback(async () => {
    keepReadingRef.current = false;
    await teardown();
    clearPortRecord();
    setStatus('disconnected');
  }, [teardown]);

  // Reconnect to the last-used device on load, without a port chooser. Best-effort by
  // design: having no previously-authorized port is the normal first-run state, not a
  // fault, so every failure path here ends silently at 'disconnected'.
  useEffect(() => {
    if (!isSupported()) return;
    const record = loadPortRecord();
    if (!record) return;
    const serial = navigator.serial;
    if (!serial) return;
    if (keepReadingRef.current) return;
    keepReadingRef.current = true; // hold the slot for the WHOLE probe sequence

    let cancelled = false;
    void (async () => {
      try {
        setStatus('connecting');
        const ports = await serial.getPorts();
        // Identity is VID/PID and nothing else — Web Serial exposes no serial number and
        // no device path, so several candidates can be indistinguishable here. Never pick
        // by index: which one is the meter's data endpoint is decided by the probe.
        const candidates = ports.filter((p) => {
          const info = p.getInfo();
          return info.usbVendorId === record.usbVendorId
            && info.usbProductId === record.usbProductId;
        });
        for (const port of candidates) {
          if (cancelled) break;
          if (await probe(port, record.baudRate)) {
            if (cancelled) break;
            setStatus('connected');
            return; // slot stays claimed; remaining candidates are never opened
          }
        }
      } catch {
        /* enumeration refused or unavailable — fall through to disconnected */
      }
      keepReadingRef.current = false;
      if (!cancelled) setStatus('disconnected');
    })();

    return () => {
      cancelled = true;
    };
  }, [probe]);

  // Clean up on unmount so the port never stays locked.
  useEffect(() => {
    return () => {
      keepReadingRef.current = false;
      if (ctlRef.current) ctlRef.current.stop = true;
      const reader = readerRef.current;
      const port = portRef.current;
      if (reader) {
        // Must wait for cancel() to resolve before close() — see teardown() above.
        reader.cancel().catch(() => {}).finally(() => port?.close().catch(() => {}));
      } else {
        port?.close().catch(() => {});
      }
    };
  }, []);

  return { status, error, connect, disconnect };
}
