// Minimal ambient declarations for the Web Serial API.
// lib.dom.d.ts does not ship these yet, so we declare just enough surface for
// strict TypeScript to compile — avoids pulling in @types/w3c-web-serial.

// All the identity the API exposes: no serial number, no device path. Two physically
// distinct adapters of the same model are therefore indistinguishable here.
interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
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
