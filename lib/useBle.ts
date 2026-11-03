'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createByteFeed, type Reading } from './parser';
import type { ConnectionStatus } from './connection';

// Transparent-UART profile of JDY-23 / HM-10-style modules (docs/hardware.md). Matched by
// service, not name: AT+NAME renames modules and clones share the profile.
const SERVICE = 0xffe0;
const DATA_CHAR = 0xffe1;
const IN_USE_HINT = 'The module may be in use by another client (e.g. a phone app).';

function isSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

// `release` tears the attempt down at whatever stage it reached; replaced once a device exists.
type Attempt = { cancelled: boolean; release: () => void };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Web Bluetooth counterpart of useSerial: same `{status, error, connect, disconnect,
 * clearError}` contract plus `deviceName`. Read-only — nothing is ever written to the data
 * characteristic; startNotifications() writes only the standard CCCD.
 */
export function useBle(onReadings: (readings: Reading[]) => void) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  // The current attempt or connection — the slot. Set before the first await so a double
  // click cannot start two; `cancelled` is how a pending connect() learns that Disconnect
  // or unmount ended it mid-await, at any stage including the open chooser.
  const attemptRef = useRef<Attempt | null>(null);

  const onReadingsRef = useRef(onReadings);
  useEffect(() => { onReadingsRef.current = onReadings; });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check
    if (!isSupported()) setStatus('unsupported');
  }, []);

  const end = useCallback(() => {
    const a = attemptRef.current;
    if (!a) return;
    attemptRef.current = null;
    a.cancelled = true;
    a.release();
  }, []);

  const connect = useCallback(async () => {
    const bluetooth = navigator.bluetooth;
    if (!bluetooth) {
      setStatus('unsupported');
      return;
    }
    if (attemptRef.current) return;
    const attempt: Attempt = { cancelled: false, release: () => {} };
    attemptRef.current = attempt;
    setError(null);
    setStatus('connecting');

    let device: BluetoothDevice;
    try {
      // optionalServices repeats the filter on purpose: unverified that a filter's
      // services are accessible without it, and omitting it would fail every connect.
      device = await bluetooth.requestDevice({
        filters: [{ services: [SERVICE] }],
        optionalServices: [SERVICE],
      });
    } catch (e) {
      if (attempt.cancelled) return;
      end();
      setStatus('disconnected');
      // Chooser dismissed is the operator's choice, not an error.
      if (!/cancel/i.test(errorText(e))) setError(errorText(e));
      return;
    }
    if (attempt.cancelled) return;

    const feed = createByteFeed((readings) => onReadingsRef.current(readings));
    let char: BluetoothRemoteGATTCharacteristic | null = null;
    let connected = false;
    const onValue = (e: Event) => {
      const v = (e.target as BluetoothRemoteGATTCharacteristic).value;
      if (v) feed.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    };
    // A drop while connecting rejects the pending GATT call; the catch below reports it.
    const onDrop = () => {
      if (!connected) return;
      end();
      setStatus('disconnected');
      setDeviceName(null);
      setError('Bluetooth connection lost.');
    };
    const detach = () => {
      device.removeEventListener('gattserverdisconnected', onDrop);
      char?.removeEventListener('characteristicvaluechanged', onValue);
    };
    attempt.release = () => {
      // Listeners off first: Chrome fires gattserverdisconnected for our own disconnect
      // too. Unconditional: it also aborts a pending gatt.connect(), and is a no-op idle.
      detach();
      device.gatt?.disconnect();
    };
    device.addEventListener('gattserverdisconnected', onDrop);

    try {
      if (!device.gatt) throw new Error('Device has no GATT server.');
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE).catch((e: unknown) => {
        if (e instanceof Error && e.name === 'NotFoundError') {
          throw new Error(`${device.name ?? 'This device'} is not a supported serial module (no FFE0 service).`);
        }
        throw e;
      });
      char = await service.getCharacteristic(DATA_CHAR);
      char.addEventListener('characteristicvaluechanged', onValue);
      await char.startNotifications();
      if (attempt.cancelled) {
        detach(); // listener added after end() released; the GATT link is already down
        return;
      }
      connected = true;
      setDeviceName(device.name ?? 'BLE module');
      setStatus('connected');
    } catch (e) {
      if (attempt.cancelled) {
        detach();
        return;
      }
      end();
      setStatus('disconnected');
      setError(`${errorText(e)} ${IN_USE_HINT}`);
    }
  }, [end]);

  const disconnect = useCallback(() => {
    end();
    setError(null);
    setDeviceName(null);
    setStatus('disconnected');
  }, [end]);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => end, [end]);

  // A connected client keeps the module awake and stops it advertising to anyone else. Chrome
  // drops the link when it destroys the page, but that waits on teardown and never happens for
  // a page kept in the back/forward cache, so release it explicitly as the page goes away.
  // `pagehide`, not `beforeunload`: it fires only once leaving is certain, and keeps bfcache.
  useEffect(() => {
    window.addEventListener('pagehide', disconnect);
    return () => window.removeEventListener('pagehide', disconnect);
  }, [disconnect]);

  return { status, error, connect, disconnect, clearError, deviceName };
}
