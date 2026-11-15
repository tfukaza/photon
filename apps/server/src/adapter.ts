import type { CommissionInput, CommandInput, Device, CommissioningUpdate } from '../../../packages/contracts/src/index.js';
import { AppError } from './errors.js';

/** Transport contract: emits reported state independently from command acknowledgement. */
export interface DeviceAdapter {
  start(report: (device: Device) => void): Promise<void>;
  commission(input: CommissionInput, signal: AbortSignal, progress?: (update: CommissioningUpdate) => void): Promise<string>;
  command(id: string, endpoint: string, command: CommandInput, signal: AbortSignal): Promise<void>;
  devices(): Device[];
  close(): Promise<void>;
}

/** Deterministic transport for application/browser tests, never selected in hardware mode. */
export class FakeAdapter implements DeviceAdapter {
  private report: (device: Device) => void = () => {};
  private light?: Device;
  commissionDelayMs = 5;
  commandDelayMs = 0;

  /** Installs the application's observer. */
  async start(report: (device: Device) => void) { this.report = report; }

  /** Creates a simulated application device without using the Matter protocol. */
  async commission(_input: CommissionInput, signal: AbortSignal, progress?: (update: CommissioningUpdate) => void) {
    progress?.({ stage: 'simulation', title: 'Simulated connection', detail: 'UI preview only; no discovery or Matter handshake is performed.', status: 'running' });
    await delay(this.commissionDelayMs, signal);
    this.light = { id: 'fake-light', name: 'Test light', availability: 'online', stale: false,
      endpoints: [{ id: '1', kind: 'light', brightnessSupported: true, power: false, brightness: 50 }] };
    this.report(structuredClone(this.light));
    progress?.({ stage: 'simulation', title: 'Simulated connection', detail: 'The preview device was created. No physical light was contacted.', status: 'completed' });
    return this.light.id;
  }

  /** Applies a desired state, including application-level brightness percentages. */
  async command(id: string, endpoint: string, command: CommandInput, signal: AbortSignal) {
    await delay(this.commandDelayMs, signal);
    if (!this.light || this.light.id !== id || this.light.endpoints[0].id !== endpoint) throw new AppError('NOT_FOUND', 'Light not found.', 404);
    if (command.type === 'power') this.light.endpoints[0].power = command.value;
    else this.light.endpoints[0].brightness = command.value;
    this.report(structuredClone(this.light));
  }

  /** Returns independent copies of currently known transport state. */
  devices() { return this.light ? [structuredClone(this.light)] : []; }

  /** Injects externally reported state for lifecycle tests. */
  update(device: Device) { this.light = structuredClone(device); this.report(structuredClone(device)); }

  /** Releases the observer. */
  async close() { this.report = () => {}; }
}

/** Waits without allowing aborted work to continue making transport changes. */
export function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
