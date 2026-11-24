'use client';

// OpenOSC SCPI transport.
//
// The stock ZT703s emits a continuous text stream ("Voltage:-0.0004 V").
// OpenOSC replaces that with a SCPI instrument on the same USB-CDC port:
//   *IDN?                 -> OpenOSC,<profile>,<serial>,<version>
//   SYST:MODE DMM         -> switch screen (USB reconnects)
//   FUNC?                 -> current function, e.g. "VOLT"
//   READ?                 -> next new reading (about 3/s)
//   SYST:DMM:RANG:LIST?   -> count followed by full-scale values
//
// This hook translates SCPI answers into the app's Reading objects, so all
// existing chart/log/Pass-Fail code works unchanged.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionStatus } from './connection';
import type { Mode, Reading } from './parser';

const BAUD = 115200; // CDC ignores baud, but Web Serial requires a value
const TIMEOUT_MS = 2000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ScpiPort = SerialPort;
type Reader = ReadableStreamDefaultReader<Uint8Array>;
type Writer = WritableStreamDefaultWriter<Uint8Array>;

async function openFirstPort(): Promise<ScpiPort | null> {
  if (!navigator.serial) return null;
  const ports = await navigator.serial.getPorts().catch(() => []);
  for (const port of ports) {
    try {
      await port.open({ baudRate: BAUD });
      return port;
    } catch {
      // Held by another tab or already gone; try the next candidate.
    }
  }
  return null;
}

/** One SCPI query. Echoes are ignored; the first non-empty response line wins. */
async function query(port: ScpiPort, reader: Reader, writer: Writer, command: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    await writer.write(encoder.encode(command + '\r\n'));
  } catch {
    return '';
  }
  let pending = '';
  while (Date.now() < deadline) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), TIMEOUT_MS)),
      ]);
    } catch {
      return '';
    }
    if (result.done) break;
    if (result.value) pending += decoder.decode(result.value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.toUpperCase() === command.replace(/\?$/, '').toUpperCase()) continue;
      return line.replace(/^"|"$/g, '');
    }
  }
  return '';
}

const FUNCTION_MODE: Record<string, Mode> = {
  VOLT: 'VOLTAGE', MVOLT: 'VOLTAGE',
  CURR: 'CURRENT', MCURR: 'CURRENT',
  RES: 'RESISTANCE', CAP: 'CAPACITANCE',
  DIOD: 'DIODE', CONT: 'CONTINUITY',
};

function baseUnit(func: string, fullScale: number): string {
  if (func.startsWith('MVOL')) return 'mV';
  if (func.startsWith('MCUR')) return 'mA';
  if (func.startsWith('CURR')) return 'A';
  if (func.startsWith('VOLT')) return fullScale < 1 ? 'mV' : 'V';
  if (func.startsWith('RES')) {
    if (fullScale >= 1e6) return 'MOM';
    if (fullScale >= 1e3) return 'KOM';
    return 'OM';
  }
  if (func.startsWith('CAP')) {
    if (fullScale <= 1e-9) return 'pF';
    if (fullScale <= 1e-6) return 'nF';
    if (fullScale <= 1e-3) return 'uF';
    return 'mF';
  }
  if (func.startsWith('DIOD')) return 'V';
  return 'OM';
}

function decimalsFor(fullScale: number): number {
  if (!Number.isFinite(fullScale) || fullScale <= 0) return 4;
  return Math.min(7, Math.max(0, 4 - Math.floor(Math.log10(fullScale))));
}

export function useScpi(onReadings: (readings: Reading[]) => void) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const portRef = useRef<ScpiPort | null>(null);
  const stopRef = useRef(false);
  const onReadingsRef = useRef(onReadings);
  // eslint-disable-next-line react-hooks/refs -- keep the callback fresh without re-creating connect()
  onReadingsRef.current = onReadings;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check
    if (typeof navigator === 'undefined' || !('serial' in navigator)) setStatus('unsupported');
  }, []);

  const teardown = useCallback(async () => {
    stopRef.current = true;
    const port = portRef.current;
    portRef.current = null;
    if (port) await port.close().catch(() => {});
  }, []);

  const connect = useCallback(async () => {
    if (!navigator.serial) {
      setStatus('unsupported');
      return;
    }
    setError(null);
    setStatus('connecting');
    try {
      let port = await navigator.serial.requestPort();
      await port.open({ baudRate: BAUD });
      let reader = port.readable!.getReader();
      let writer = port.writable!.getWriter();

      let id = await query(port, reader, writer, '*IDN?');
      if (!id.startsWith('OpenOSC')) {
        await writer.close().catch(() => {});
        reader.releaseLock();
        await port.close().catch(() => {});
        setError('Selected port is not an OpenOSC instrument.');
        setStatus('disconnected');
        return;
      }
      setDeviceName(id.split(',')[1] ?? 'OpenOSC');

      // Switch to the DMM screen. The USB connection drops and comes back.
      await query(port, reader, writer, 'SYST:MODE DMM');
      try { writer.releaseLock(); } catch { /* already released */ }
      try { reader.releaseLock(); } catch { /* already released */ }
      await port.close().catch(() => {});

      await new Promise((r) => setTimeout(r, 1800));
      const reconnected = await openFirstPort();
      if (!reconnected) throw new Error('Instrument did not reconnect after switching to DMM.');
      port = reconnected;
      reader = port.readable!.getReader();
      writer = port.writable!.getWriter();
      id = await query(port, reader, writer, '*IDN?');
      if (!id.startsWith('OpenOSC')) throw new Error('Could not identify the instrument after reconnect.');

      portRef.current = port;
      stopRef.current = false;
      setStatus('connected');

      let func = await query(port, reader, writer, 'FUNC?');
      let mode: Mode = FUNCTION_MODE[func] ?? 'VOLTAGE';
      let rangeList = await query(port, reader, writer, 'SYST:DMM:RANG:LIST?');
      let ranges = rangeList.split(',').map(Number).filter(Number.isFinite);
      let rangeIndex = 0;
      let poll = 0;

      while (port.readable && !stopRef.current) {
        const valueText = await query(port, reader, writer, 'READ?');
        if (stopRef.current) break;
        if (!valueText) continue;

        // Refresh metadata occasionally so changing the function on the meter works.
        if (poll++ % 20 === 0) {
          func = await query(port, reader, writer, 'FUNC?');
          mode = FUNCTION_MODE[func] ?? mode;
          rangeList = await query(port, reader, writer, 'SYST:DMM:RANG:LIST?');
          ranges = rangeList.split(',').map(Number).filter(Number.isFinite);
          const result = await query(port, reader, writer, 'SYST:DMM:RES?');
          const fields = result.split(',');
          const idx = Number(fields[5]);
          if (Number.isFinite(idx)) rangeIndex = Math.max(0, Math.floor(idx) - 1);
        }

        const value = Number.parseFloat(valueText);
        if (!Number.isFinite(value)) continue;
        const fullScale = ranges[Math.min(rangeIndex, Math.max(0, ranges.length - 2)) + 1] ?? 1;
        const unit = baseUnit(func, fullScale);
        const decimals = decimalsFor(fullScale);
        const result = await query(port, reader, writer, 'SYST:DMM:RES?');
        const dmmStatus = Number(result.split(',')[2]);
        const overload = dmmStatus === 14;
        const reading: Reading = {
          mode,
          value,
          display: value.toFixed(decimals),
          unit,
          isOverload: overload,
          isMeasuring: false,
          ts: Date.now(),
        };
        onReadingsRef.current([reading]);
      }
      try { writer.releaseLock(); } catch { /* already released */ }
      try { reader.releaseLock(); } catch { /* already released */ }
      await port.close().catch(() => {});
      if (portRef.current === port) portRef.current = null;
      setStatus('disconnected');
      setDeviceName(null);
    } catch (e) {
      await teardown();
      setError(e instanceof Error ? e.message : String(e));
      setStatus('disconnected');
    }
  }, [teardown]);

  const disconnect = useCallback(async () => {
    await teardown();
    setError(null);
    setStatus('disconnected');
    setDeviceName(null);
  }, [teardown]);

  const clearError = useCallback(() => setError(null), []);

  return { status, error, deviceName, connect, disconnect, clearError };
}
