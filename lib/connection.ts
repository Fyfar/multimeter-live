export type ConnectionStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected';
export type Transport = 'uart' | 'ble';

// Busy = holding the one connection slot; the other transport's Connect is disabled.
export const isBusy = (s: ConnectionStatus): boolean => s === 'connecting' || s === 'connected';
