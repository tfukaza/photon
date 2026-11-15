import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ManualPairingCodeCodec } from '@matter/types';
import type { CommissionInput, CommandInput, Device, HubEvent, Operation, Snapshot, CommissioningUpdate } from '../../../packages/contracts/src/index.js';
import type { DeviceAdapter } from './adapter.js';
import type { Config } from './config.js';
import { Store } from './store.js';
import { AppError, publicError } from './errors.js';

/** Validates pairing data before any radio or operation side effects. */
export function decodeSetupCode(code: string) {
  try { return ManualPairingCodeCodec.decode(code.replace(/[\s-]/g, '')); }
  catch { throw new AppError('INVALID_CODE', 'Enter a valid Matter manual setup code.'); }
}

/** Owns application operations and reported state, independently of HTTP and Matter objects. */
export class Hub extends EventEmitter {
  private state = new Map<string, Device>();
  private operations = new Map<string, Operation>();
  private commissioning = false;
  private stopping = false;
  private jobs = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  private commandQueues = new Map<string, Promise<void>>();

  constructor(readonly store: Store, readonly adapter: DeviceAdapter, private config: Config) {
    super();
    for (const operation of store.operations()) {
      if (operation.status === 'accepted' || operation.status === 'running') {
        operation.status = 'interrupted'; operation.progress = 'Hub restarted. Check the device before retrying.';
        operation.updatedAt = new Date().toISOString();
        this.finishStages(operation, 'interrupted'); store.saveOperation(operation);
      }
      this.operations.set(operation.id, operation);
    }
    for (const row of store.deviceRecords()) {
      this.state.set(row.id, { ...row, availability: 'connecting', stale: true, endpoints: [] });
    }
  }

  /** Starts background device management even with no connected browser. */
  async start() { await this.adapter.start(device => this.report(device)); }

  /** Reconciles protocol-owned peers with application metadata and publishes confirmed state. */
  private report(device: Device) {
    if (this.stopping) return;
    this.store.rememberDevice(device);
    const record = this.store.deviceRecords().find(row => row.id === device.id);
    const reported = { ...device, name: record?.name ?? device.name };
    this.state.set(device.id, structuredClone(reported));
    this.emit('event', { type: 'device', data: structuredClone(reported) } satisfies HubEvent);
  }

  /** Captures the complete recoverable UI state synchronously on the event loop. */
  snapshot(): Snapshot {
    return structuredClone({ devices: [...this.state.values()], operations: [...this.operations.values()] });
  }

  /** Gets sanitized operation status after a browser reconnect. */
  operation(id: string) {
    const operation = this.operations.get(id);
    if (!operation) throw new AppError('NOT_FOUND', 'Operation not found.', 404);
    return structuredClone(operation);
  }

  /** Creates a discoverable operation before scheduling its asynchronous execution. */
  private createOperation(kind: Operation['kind'], deviceId?: string) {
    if (this.stopping) throw new AppError('STOPPING', 'The hub is shutting down.', 503);
    const now = new Date().toISOString();
    const operation: Operation = { id: randomUUID(), kind, status: 'accepted', progress: 'Queued', createdAt: now, updatedAt: now, deviceId };
    this.operations.set(operation.id, operation);
    this.publish(operation);
    return operation;
  }

  /** Writes status before notifying clients, so reconnects always see the published result. */
  private publish(operation: Operation) {
    operation.updatedAt = new Date().toISOString();
    this.store.saveOperation(operation);
    this.emit('event', { type: 'operation', data: structuredClone(operation) } satisfies HubEvent);
  }

  /** Appends sanitized transport milestones to the operation's persisted event history. */
  private recordStage(operation: Operation, update: CommissioningUpdate) {
    (operation.timeline ??= []).push({ ...update, at: new Date().toISOString() });
    operation.progress = `${update.title}: ${update.detail}`;
  }

  /** Closes unfinished stages when the operation stops, including on timeout and process restart. */
  private finishStages(operation: Operation, status: 'failed' | 'interrupted', detail = operation.progress) {
    const message = operation.progress;
    const active = new Map<string, CommissioningUpdate>();
    for (const event of operation.timeline ?? []) {
      if (event.status === 'running') active.set(event.stage, event);
      else active.delete(event.stage);
    }
    for (const event of active.values()) this.recordStage(operation, { ...event, status, detail });
    operation.progress = message;
  }

  /** Starts one onboarding job; explicit opt-in may remember Wi-Fi outside the operation history. */
  commission(input: CommissionInput) {
    decodeSetupCode(input.code);
    if (this.config.mode === 'simulator' && input.transport !== 'on-network') throw new AppError('TRANSPORT', 'Use on-network setup for the simulator.');
    if (this.commissioning) throw new AppError('BUSY', 'Another device is being added. Wait for it to finish.', 409);
    let resolved = input;
    if (input.useSavedWifi) {
      const network = this.store.savedWifi();
      if (!network) throw new AppError('WIFI_NOT_SAVED', 'No Wi-Fi network is saved. Enter the network details first.');
      resolved = { ...input, ssid: network.ssid, wifiPassword: network.password };
    }
    const operation = this.createOperation('commissioning');
    this.commissioning = true;
    let transport: Promise<string> | undefined;
    const job = this.run(operation, this.config.commissionTimeoutMs, async signal => {
      if (input.rememberWifi && input.ssid && input.wifiPassword !== undefined) {
        try { this.store.saveWifi(input.ssid, input.wifiPassword); }
        catch { throw new AppError('WIFI_SAVE_FAILED', 'Could not remember the Wi-Fi network. No pairing was started. Check data-directory access, or retry with Remember Wi-Fi unchecked.'); }
      }
      operation.progress = 'Discovering and commissioning the device'; this.publish(operation);
      transport = this.adapter.commission(resolved, signal, update => {
        if (!signal.aborted && operation.status === 'running') { this.recordStage(operation, update); this.publish(operation); }
      });
      const id = await transport;
      if (!signal.aborted) operation.deviceId = id;
    }).finally(async () => {
      await transport?.catch(() => {});
      this.commissioning = false;
    });
    this.track(job);
    return structuredClone(operation);
  }

  /** Queues commands per endpoint; one slow device does not block another device. */
  command(id: string, endpointId: string, command: CommandInput) {
    const device = this.state.get(id);
    if (!device) throw new AppError('NOT_FOUND', 'Device not found.', 404);
    if (device.availability !== 'online' || device.stale) throw new AppError('OFFLINE', 'The device is unavailable. Wait for it to reconnect.', 409);
    const endpoint = device.endpoints.find(item => item.id === endpointId);
    if (!endpoint) throw new AppError('NOT_FOUND', 'Control endpoint not found.', 404);
    if (command.type === 'brightness' && !endpoint.brightnessSupported) throw new AppError('UNSUPPORTED', 'This device does not support brightness.');
    const operation = this.createOperation('command', id);
    const key = `${id}/${endpointId}`;
    const previous = this.commandQueues.get(key) ?? Promise.resolve();
    const job = previous.then(async () => {
      let transport: Promise<void> | undefined;
      await this.run(operation, this.config.commandTimeoutMs, signal => {
        transport = this.adapter.command(id, endpointId, command, signal);
        return transport;
      });
      await transport?.catch(() => {});
    });
    this.commandQueues.set(key, job);
    this.track(job.finally(() => { if (this.commandQueues.get(key) === job) this.commandQueues.delete(key); }));
    return structuredClone(operation);
  }

  /** Runs a bounded operation; late transport completion cannot replace terminal state. */
  private async run(operation: Operation, timeout: number, action: (signal: AbortSignal) => Promise<void>) {
    if (this.stopping) return;
    const controller = new AbortController(); this.controllers.add(controller);
    const timeoutMessage = operation.kind === 'commissioning'
      ? 'Setup was not confirmed in time. The device may already be paired; keep it powered on and restart Photon to reconnect before pairing again.'
      : 'The device did not respond in time. Check its state before retrying.';
    const timer = setTimeout(() => controller.abort(new AppError('TIMEOUT', timeoutMessage)), timeout);
    let abortListener: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      operation.status = 'running'; operation.progress = 'Waiting for the device'; this.publish(operation);
      await Promise.race([action(controller.signal), aborted]);
      controller.signal.throwIfAborted();
      operation.status = 'completed'; operation.progress = 'Completed';
      this.finishStages(operation, 'interrupted', 'Setup completed with the selected device. This earlier observation did not report its own completion and may belong to a superseded candidate; no transport success is inferred.');
    } catch (error) {
      operation.status = this.stopping ? 'interrupted' : 'failed';
      operation.error = publicError(error); operation.progress = operation.error.message;
      this.finishStages(operation, operation.status);
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', abortListener); this.controllers.delete(controller);
      if (!this.stopping) this.publish(operation);
    }
  }

  /** Keeps running tasks alive independently of the initiating browser request. */
  private track(job: Promise<void>) { this.jobs.add(job); void job.finally(() => this.jobs.delete(job)); }

  /** Stops work before releasing transport state and persistence. */
  async close() {
    this.stopping = true;
    for (const controller of this.controllers) controller.abort(new AppError('INTERRUPTED', 'The hub stopped.'));
    await this.adapter.close();
    await Promise.allSettled([...this.jobs]);
    for (const operation of this.operations.values()) {
      if (['accepted', 'running', 'interrupted'].includes(operation.status)) {
        operation.status = 'interrupted'; operation.progress = 'Hub stopped. Check the device before retrying.';
        this.store.saveOperation(operation);
      }
    }
    this.removeAllListeners();
  }
}
