'use client';

import { FileText, LayoutDashboard, LogOut, Settings } from 'lucide-react';
import { clsx } from 'clsx';
import type { SerialStatus } from '@/lib/useSerial';

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200];

export type NavId = 'dashboard' | 'data-log' | 'settings';
const NAV_ITEMS: { id: NavId; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'data-log', label: 'Data Log' },
  { id: 'settings', label: 'Settings' },
];

const NAV_ICONS: Record<NavId, React.ReactNode> = {
  dashboard: <LayoutDashboard size={15} />,
  'data-log': <FileText size={15} />,
  settings: <Settings size={15} />,
};

export function Sidebar({
  status,
  baud,
  onBaudChange,
  onConnect,
  onDisconnect,
  error,
  active,
  onNavChange,
}: {
  status: SerialStatus;
  baud: number;
  onBaudChange: (b: number) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  error: string | null;
  active: NavId;
  onNavChange: (id: NavId) => void;
}) {
  const connected = status === 'connected';
  const connecting = status === 'connecting';

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-canvas">
      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 p-3 pt-4">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavChange(item.id)}
            className={clsx(
              'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              item.id === active ? 'bg-accent text-white' : 'text-muted hover:bg-surface hover:text-fg',
            )}
          >
            {NAV_ICONS[item.id]}
            {item.label}
          </button>
        ))}
      </nav>

      {/* Connection Card */}
      <div className="border-t border-border p-3">
        <div className="space-y-3 rounded-lg border border-border bg-panel p-3">
          <h3 className="text-xs font-semibold text-fg">Connection</h3>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Status</span>
              <span className={connected ? 'text-success' : connecting ? 'text-amber' : 'text-muted'}>
                {connected ? 'Connected' : connecting ? 'Connecting…' : 'Disconnected'}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Interface</span>
              <span className="text-fg">UART</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Baud Rate</span>
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
            </div>
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}

          {connected ? (
            <button
              onClick={onDisconnect}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20"
            >
              <LogOut size={12} />
              Disconnect
            </button>
          ) : (
            <button
              onClick={onConnect}
              disabled={status === 'unsupported' || connecting}
              className="w-full rounded-md bg-accent py-1.5 text-xs font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
