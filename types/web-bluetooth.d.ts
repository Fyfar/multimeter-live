// Minimal ambient declarations for the Web Bluetooth API, same stance as web-serial.d.ts:
// just the surface lib/useBle.ts uses, no @types/web-bluetooth.

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly value?: DataView;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: number | string): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: number | string): Promise<BluetoothRemoteGATTService>;
}

// Fires `gattserverdisconnected`; the characteristic fires `characteristicvaluechanged`.
interface BluetoothDevice extends EventTarget {
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
}

interface Bluetooth {
  requestDevice(options: {
    filters: { services: (number | string)[] }[];
    optionalServices?: (number | string)[];
  }): Promise<BluetoothDevice>;
}

interface Navigator {
  readonly bluetooth?: Bluetooth;
}
