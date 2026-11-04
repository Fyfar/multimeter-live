'use client';

import { CheckCircle2, FileText, History, LayoutDashboard, LogOut, Settings } from 'lucide-react';
import { clsx } from 'clsx';
import { useState } from 'react';
import type { ConnectionStatus, Transport } from '@/lib/connection';
import { BAUD_RATES } from '@/lib/settings';
import { Drawer } from '@/components/Drawer';


export type NavId = 'dashboard' | 'data-log' | 'pass-fail' | 'history' | 'settings';
// Exported so app/page.tsx can validate a URL hash against the real set of views rather
// than trusting whatever the address bar contains.
export const NAV_IDS = ['dashboard', 'data-log', 'pass-fail', 'history', 'settings'] as const;
const NAV_ITEMS: { id: NavId; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'data-log', label: 'Data Log' },
  { id: 'pass-fail', label: 'Pass/Fail' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

const NAV_ICONS: Record<NavId, React.ReactNode> = {
  dashboard: <LayoutDashboard size={15} />,
  'data-log': <FileText size={15} />,
  'pass-fail': <CheckCircle2 size={15} />,
  history: <History size={15} />,
  settings: <Settings size={15} />,
};

const STATUS_VIEW: Record<ConnectionStatus, { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'text-success' },
  connecting: { label: 'Connecting…', className: 'text-amber' },
  disconnected: { label: 'Disconnected', className: 'text-muted' },
  unsupported: { label: 'Disconnected', className: 'text-muted' },
};

const TRANSPORT_LABEL: Record<Transport, string> = { uart: 'UART', ble: 'Bluetooth' };
const UNSUPPORTED_REASON: Record<Transport, string> = {
  uart: 'Web Serial is not supported in this browser.',
  ble: 'Bluetooth is not supported in this browser.',
};

type Conn = {
  status: ConnectionStatus;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted">{label}</span>
      {children}
    </div>
  );
}

// Status, the transport's own rows, error, and Connect/Disconnect — shared by both transports.
// `cancellable`: Disconnect also ends a connect in progress (BLE only; a UART disconnect
// mid-probe would forget the remembered port).
function ConnectionBody({ conn, disabledReason, cancellable, children }: {
  conn: Conn; disabledReason: string | null; cancellable: boolean; children: React.ReactNode;
}) {
  const { status, error } = conn;
  const connecting = status === 'connecting';
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Row label="Status">
          <span className={STATUS_VIEW[status].className}>{STATUS_VIEW[status].label}</span>
        </Row>
        {children}
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      {status === 'connected' ? (
        <button
          onClick={conn.disconnect}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20"
        >
          <LogOut size={12} />
          Disconnect
        </button>
      ) : connecting && cancellable ? (
        <button
          onClick={conn.disconnect}
          className="w-full rounded-md border border-border py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface hover:text-fg"
        >
          Cancel
        </button>
      ) : (
        <button
          onClick={conn.connect}
          disabled={disabledReason !== null || connecting}
          className="w-full rounded-md bg-accent py-1.5 text-xs font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      )}
      {disabledReason && status !== 'connected' && (
        <p className="text-xs text-muted">{disabledReason}</p>
      )}
    </div>
  );
}

function UartRows({ connected, connecting, baud, onBaudChange }: {
  connected: boolean; connecting: boolean; baud: number; onBaudChange: (b: number) => void;
}) {
  return (
    <Row label="Baud Rate">
      {connected ? (
        <span className="font-mono text-fg">{baud} bps</span>
      ) : (
        <select
          value={baud}
          onChange={(e) => onBaudChange(Number(e.target.value))}
          disabled={connecting}
          className="rounded-sm border border-border bg-surface px-1.5 py-0.5 text-xs text-fg disabled:opacity-50"
        >
          {BAUD_RATES.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      )}
    </Row>
  );
}

// No baud control: the speed is the module's own setting, not something the app can set.
function BleRows({ status, deviceName }: { status: ConnectionStatus; deviceName: string | null }) {
  return (
    <>
      <Row label="Module UART">
        <span className="font-mono text-fg">115200 bps</span>
      </Row>
      {status === 'connected' && deviceName ? (
        <Row label="Device">
          <span className="truncate pl-2 text-fg">{deviceName}</span>
        </Row>
      ) : (
        <p className="text-[11px] leading-snug text-muted">
          Not listed? Power the meter, close other apps using the module.
        </p>
      )}
    </>
  );
}

export function Sidebar({
  uart,
  ble,
  baud,
  onBaudChange,
  deviceName,
  activeTransport,
  active,
  onNavChange,
  connectionOpen,
  onConnectionClose,
}: {
  uart: Conn;
  ble: Conn;
  baud: number;
  onBaudChange: (b: number) => void;
  deviceName: string | null;
  activeTransport: Transport | null;
  active: NavId;
  onNavChange: (id: NavId) => void;
  connectionOpen: boolean;
  onConnectionClose: () => void;
}) {
  const [picked, setPicked] = useState<Transport>('uart');
  // Locked to the busy transport, so the shown body is never the blocked one: the only
  // reason its Connect can be disabled is browser support.
  const shown = activeTransport ?? picked;
  const conn = shown === 'uart' ? uart : ble;

  return (
    // Compact: a bar along the bottom (the body row is flex-col-reverse there, so it stays
    // in normal flow — no fixed positioning). Medium: an icon rail. lg: today's sidebar.
    <aside className="flex shrink-0 border-border bg-canvas max-sm:h-14 max-sm:border-t sm:w-14 sm:flex-col sm:border-r lg:w-52">
      {/* Navigation */}
      <nav className="flex flex-1 gap-0.5 max-sm:p-1 sm:flex-col sm:p-2 sm:pt-4 lg:p-3 lg:pt-4">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavChange(item.id)}
            aria-current={item.id === active ? 'page' : undefined}
            className={clsx(
              'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              'max-sm:flex-1 max-sm:flex-col max-sm:justify-center max-sm:gap-0.5 max-sm:px-1 max-sm:py-1 max-sm:text-[10px] sm:max-lg:justify-center sm:max-lg:px-0',
              item.id === active ? 'bg-accent text-white' : 'text-muted hover:bg-surface hover:text-fg',
            )}
          >
            {NAV_ICONS[item.id]}
            {/* sr-only in the rail: still the button's accessible name. */}
            <span className="sm:max-lg:sr-only">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Connection — below lg a drawer opened from the header status, which names it. */}
      <Drawer
        as="div"
        open={connectionOpen}
        onClose={onConnectionClose}
        label="Connection"
        className="lg:border-t lg:border-border lg:p-3"
      >
        <div className="space-y-3 rounded-lg border border-border bg-panel p-3 max-lg:m-3">
          <h3 className="hidden text-xs font-semibold text-fg lg:block">Connection</h3>
          <div role="group" aria-label="Transport" className="flex gap-1">
            {(['uart', 'ble'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setPicked(t)}
                disabled={activeTransport !== null && activeTransport !== t}
                aria-pressed={shown === t}
                aria-describedby={activeTransport && activeTransport !== t ? 'transport-locked' : undefined}
                className={clsx(
                  'flex-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  shown === t
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-muted hover:bg-surface hover:text-fg',
                )}
              >
                {TRANSPORT_LABEL[t]}
              </button>
            ))}
          </div>
          {activeTransport && (
            <p id="transport-locked" className="text-[11px] leading-snug text-muted">
              Disconnect {TRANSPORT_LABEL[activeTransport]} to switch.
            </p>
          )}
          <ConnectionBody
            conn={conn}
            disabledReason={conn.status === 'unsupported' ? UNSUPPORTED_REASON[shown] : null}
            cancellable={shown === 'ble'}
          >
            {shown === 'uart' ? (
              <UartRows
                connected={uart.status === 'connected'}
                connecting={uart.status === 'connecting'}
                baud={baud}
                onBaudChange={onBaudChange}
              />
            ) : (
              <BleRows status={ble.status} deviceName={deviceName} />
            )}
          </ConnectionBody>
        </div>
      </Drawer>
    </aside>
  );
}
