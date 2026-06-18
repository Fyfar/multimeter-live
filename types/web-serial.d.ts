// Minimal ambient declarations for the Web Serial API.
// lib.dom.d.ts does not ship these yet, so we declare just enough surface for
// strict TypeScript to compile — avoids pulling in @types/w3c-web-serial.

interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}

interface Serial {
  requestPort(options?: unknown): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}

interface Navigator {
  readonly serial?: Serial;
}
