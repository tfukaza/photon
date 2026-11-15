import '@matter/nodejs';
import { Environment, Seconds, causedBy } from '@matter/general';
import { ServerNode, ControllerBehavior, ClientNode, ChangeNotificationService, DclBehavior, NetworkClient } from '@matter/node';
import { OnOffClient } from '@matter/node/behaviors/on-off';
import { LevelControlClient } from '@matter/node/behaviors/level-control';
import { BasicInformationClient } from '@matter/node/behaviors/basic-information';
import { DescriptorClient } from '@matter/node/behaviors/descriptor';
import { ControllerCommissioningFlow, FabricAuthority, PasscodeMismatchError, Subscribe, Read } from '@matter/protocol';
import { GeneralCommissioning } from '@matter/types/clusters';
import type { Device, CommissionInput, CommandInput, ControlEndpoint, CommissioningUpdate } from '../../../packages/contracts/src/index.js';
import type { DeviceAdapter } from './adapter.js';
import type { Config } from './config.js';
import { decodeSetupCode } from './hub.js';
import { installTrust } from './trust.js';
import { AppError } from './errors.js';
import { simulatorCommissioningFlow } from './simulator-flow.js';
import { confirmDeviceConnection, deviceControlKind, supportedControlEndpoints } from './device-verification.js';
import { trackedCommissioningFlow } from './commissioning-progress.js';
import { observeMatterTelemetry } from './matter-telemetry.js';
import { join } from 'node:path';
import { installMacBleIdentity } from './macos-ble.js';

/** Converts application percentage brightness to Matter's 1..254 level range. */
export function matterLevel(percent: number) { return Math.max(1, Math.round(percent * 254 / 100)); }

/** Converts Matter's reported level to an application percentage, retaining unknown state. */
export function brightnessPercent(level: number | null | undefined) {
  return level == null ? null : Math.round(level * 100 / 254);
}

/** Requests prompt liveness reports from mains-powered lights and plugs. */
function deviceSubscription() {
  return Subscribe({ minIntervalFloor: Seconds(0), maxIntervalCeiling: Seconds(5), fabricFilter: true }, Read.Attribute(), Read.Event({}));
}

/** Owns the fabric, protocol persistence, and device subscriptions for a single hub process. */
export class MatterAdapter implements DeviceAdapter {
  private node?: ServerNode;
  private fabricId = '';
  private reported = new Map<string, Device>();
  private report: (device: Device) => void = () => {};
  private cleanup: (() => void)[] = [];
  private watched = new WeakSet<ClientNode>();
  private unverified = new WeakSet<ClientNode>();
  private refreshQueued = false;
  private closed = false;
  private certificateService?: Awaited<ReturnType<typeof installTrust>>;
  private telemetryCleanup = new Set<() => void>();

  constructor(private config: Config) {}

  /** Configures storage and BLE before constructing the controller, then reconnects persisted peers. */
  async start(report: (device: Device) => void) {
    this.report = report;
    const env = Environment.default;
    env.vars.set('storage.path', join(this.config.dataDir, 'matter'));
    env.vars.set('storage.driver', 'sqlite');
    env.vars.set('runtime.signals', false);
    env.vars.set('runtime.exit', false);
    env.vars.set('log.level', 'error');
    if (this.config.interface) env.vars.set('mdns.networkinterface', this.config.interface);
    env.vars.set('ble.enable', this.config.mode === 'hardware');
    if (process.platform === 'linux') env.vars.set('ble.hci.id', this.config.hciId);
    if (this.config.mode === 'hardware') {
      if (process.platform !== 'linux' && process.platform !== 'darwin') {
        throw new Error('Hardware commissioning requires Linux or macOS.');
      }
      await import('@matter/nodejs-ble');
    }
    try {
      this.certificateService = await installTrust(env, this.config.trustFile, this.config.mode === 'simulator');
      this.node = await ServerNode.create(ServerNode.RootEndpointWithoutGroupcast.with(ControllerBehavior, DclBehavior), {
        id: 'photon', environment: env,
        commissioning: { enabled: false },
        // The hub makes outbound BLE connections; registering a peripheral transport
        // lets the SDK select that incoming-only interface ahead of the controller.
        network: { ble: false },
        controller: { adminFabricLabel: 'Photon', ble: this.config.mode === 'hardware' },
        dcl: { offline: true, acceptTestCertificates: this.config.mode === 'simulator', fetchTestCertificates: this.config.mode === 'simulator', fetchGithubCertificates: false },
      });
      if (this.config.mode === 'hardware' && process.platform === 'darwin') {
        const { require } = await import('@matter/nodejs-ble/require');
        this.cleanup.push(installMacBleIdentity(require('@stoprocent/noble')));
      }
      const authority = await this.node.env.load(FabricAuthority);
      const fabric = await authority.defaultFabric({ adminFabricLabel: 'Photon' });
      this.fabricId = fabric.fabricId.toString(16);
      const refresh = () => this.scheduleRefresh();
      const changes = this.node.env.get(ChangeNotificationService).change;
      changes.on(refresh); this.cleanup.push(() => changes.off(refresh));
      const added = (peer: ClientNode) => { this.unverified.add(peer); this.watchPeer(peer); this.scheduleRefresh(); };
      this.node.peers.added.on(added); this.cleanup.push(() => this.node?.peers.added.off(added));
      for (const peer of this.node.peers) {
        this.watchPeer(peer);
        await peer.act(agent => { agent.get(NetworkClient).state.defaultSubscription = deviceSubscription(); });
      }
      await this.node.start();
      this.refresh();
    } catch (error) { await this.close(); throw error; }
  }

  /** Tracks lifecycle transitions even when no attribute changes accompany a lost connection. */
  private watchPeer(peer: ClientNode) {
    if (this.watched.has(peer)) return;
    this.watched.add(peer);
    const changed = () => this.scheduleRefresh();
    peer.lifecycle.connectionStateChanged.on(changed);
    this.cleanup.push(() => peer.lifecycle.connectionStateChanged.off(changed));
  }

  /** Coalesces protocol changes into a consistent application snapshot after the current transaction. */
  private scheduleRefresh() {
    if (this.refreshQueued || this.closed) return;
    this.refreshQueued = true;
    queueMicrotask(() => { this.refreshQueued = false; if (!this.closed) this.refresh(); });
  }

  /** Returns the fabric-scoped operational identity rather than an ephemeral discovery identifier. */
  private id(peer: ClientNode) {
    const address = peer.state.commissioning.peerAddress;
    return address ? `${this.fabricId}-${address.nodeId.toString(16)}` : undefined;
  }

  /** Reads supported application clusters while retaining unavailable state after disconnection. */
  private refresh() {
    if (!this.node || this.closed) return;
    for (const peer of this.node.peers.commissioned) {
      this.watchPeer(peer);
      const id = this.id(peer);
      if (!id) continue;
      const online = peer.lifecycle.isConnected && !this.unverified.has(peer);
      const endpoints: ControlEndpoint[] = [];
      if (peer.lifecycle.isSeeded) {
        for (const endpoint of supportedControlEndpoints(peer)) {
          const onoff = endpoint.maybeStateOf(OnOffClient);
          if (!onoff || Number(endpoint.number) === 0) continue;
          const level = endpoint.maybeStateOf(LevelControlClient);
          const kind = deviceControlKind(endpoint.maybeStateOf(DescriptorClient)?.deviceTypeList ?? []);
          if (!kind) continue;
          endpoints.push({ id: String(endpoint.number), kind, brightnessSupported: !!level,
            power: online ? onoff.onOff : null,
            brightness: online ? brightnessPercent(level?.currentLevel) : null });
        }
      }
      const device: Device = { id, name: peer.maybeStateOf(BasicInformationClient)?.productName || 'Matter device',
        availability: online ? 'online' : 'offline', stale: !online, endpoints };
      if (JSON.stringify(this.reported.get(id)) !== JSON.stringify(device)) {
        this.reported.set(id, device); this.report(structuredClone(device));
      }
    }
  }

  /** Provisions a new device over BLE or adds an existing device over its local IP network. */
  async commission(input: CommissionInput, signal: AbortSignal, progress: (update: CommissioningUpdate) => void = () => {}) {
    if (!this.node) throw new AppError('NOT_READY', 'The Matter controller is not ready.', 503);
    const payload = decodeSetupCode(input.code);
    if (payload.shortDiscriminator === undefined) throw new AppError('INVALID_CODE', 'The manual code has no device discriminator.');
    const simulator = this.config.mode === 'simulator';
    let candidateReported = false;
    const candidate = (peer: ClientNode) => {
      if (candidateReported || peer.lifecycle.isCommissioned || signal.aborted) return;
      candidateReported = true;
      progress({ stage: 'discovery', title: 'Discover commissionable devices', detail: 'A candidate advertisement was found. Its identity has not been authenticated yet; scanning and setup-code authentication may continue.', status: 'running' });
      progress({ stage: 'transport', title: 'Connect to discovered candidate', detail: 'A candidate was found. Waiting for its transport connection and authenticated PASE session; advertisement alone does not prove either.', status: 'running' });
    };
    const closeTelemetry = observeMatterTelemetry(progress, signal, input.transport);
    this.telemetryCleanup.add(closeTelemetry);
    try {
      if (!simulator) this.node.peers.added.on(candidate);
      progress({ stage: 'discovery', title: 'Discover commissionable devices', detail: simulator
        ? 'Using the simulator’s configured loopback address; BLE and multicast discovery are bypassed.'
        : input.transport === 'on-network'
          ? 'Searching the local network using mDNS for a device with an open Matter commissioning window. Bluetooth is not used.'
          : 'Searching over Bluetooth for a candidate matching the setup-code discriminator.', status: simulator ? 'skipped' : 'running' });
      if (input.transport === 'on-network') {
        progress({ stage: 'NetworkCommissioning.Wifi', title: 'Provision and join Wi-Fi', detail: simulator ? 'Not applicable: the simulator is already reachable over IP.' : 'Not needed: the device is already on the network. No Wi-Fi credentials will be sent.', status: 'skipped' });
      }
      if (simulator) {
        progress({ stage: 'pase', title: 'Establish PASE setup session', detail: 'Authenticating the real Matter simulator using its setup code.', status: 'running' });
      }
      const Base = simulator ? simulatorCommissioningFlow(this.node, this.config.simulatorMatterPort ?? 5540) : ControllerCommissioningFlow;
      const options = {
        commissioningFlowImpl: trackedCommissioningFlow(Base, progress, simulator),
        passcode: payload.passcode, shortDiscriminator: payload.shortDiscriminator,
        discoveryCapabilities: { ble: input.transport === 'ble', onIpNetwork: input.transport === 'on-network' },
        wifiNetwork: input.transport === 'ble' ? { wifiSsid: input.ssid!, wifiCredentials: input.wifiPassword! } : undefined,
        regulatoryCountryCode: input.country, regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.Indoor,
        abort: signal, timeout: Seconds(120), autoSubscribe: true,
        defaultSubscription: deviceSubscription(),
        onAttestationFailure: (findings: import('@matter/protocol').AttestationFinding[]) => findings.every(finding => finding.level !== 'error' ||
          (this.config.mode === 'simulator' && finding.type === 'TrustedAsTestCertificate')),
      };
      let peer: ClientNode;
      if (this.config.mode === 'simulator') {
        const address = { ip: '::1', port: this.config.simulatorMatterPort ?? 5540, type: 'udp' as const };
        peer = await this.node.peers.forDescriptor({ addresses: [address] });
        await peer.commission(options);
      } else peer = await this.node.peers.commission(options);
      progress({ stage: 'initial-state', title: 'Read endpoints and subscribe to state', detail: 'The library returned the commissioned device and initialized its state subscription.', status: 'completed' });
      this.unverified.add(peer);
      this.refresh();
      const id = this.id(peer);
      if (!id) throw new AppError('PAIRING_INCOMPLETE', 'Pairing did not produce a device identity.');
      progress({ stage: 'verify-state', title: 'Verify live device state', detail: 'Read on/off directly over the operational connection; cached state does not count.', status: 'running' });
      await confirmDeviceConnection(peer, signal);
      this.unverified.delete(peer);
      this.refresh();
      progress({ stage: 'verify-state', title: 'Verify live device state', detail: 'A fresh on/off report was received from the connected device.', status: 'completed' });
      return id;
    } catch (error) {
      this.refresh();
      if (causedBy(error, PasscodeMismatchError)) throw new AppError('WRONG_CODE', 'The setup code did not match the device. Check the code and pairing mode.');
      if (error instanceof AppError) throw error;
      throw new AppError('COMMISSIONING_FAILED', 'Could not add the device. Check pairing mode, Bluetooth access, Wi-Fi details, and local IPv6 connectivity.');
    } finally {
      closeTelemetry(); this.telemetryCleanup.delete(closeTelemetry);
      if (!simulator) this.node?.peers.added.off(candidate);
    }
  }

  /** Issues a single desired-state command; subscriptions independently report resulting state. */
  async command(id: string, endpointId: string, command: CommandInput, signal: AbortSignal) {
    signal.throwIfAborted();
    const peer = this.node?.peers.commissioned.find(candidate => this.id(candidate) === id);
    if (!peer?.lifecycle.isConnected) throw new AppError('OFFLINE', 'The device is unavailable.', 409);
    const endpoint = peer.endpoints.for(Number(endpointId));
    if (command.type === 'power') {
      await endpoint.act(agent => command.value ? agent.get(OnOffClient).on() : agent.get(OnOffClient).off());
    } else {
      await endpoint.act(agent => agent.get(LevelControlClient).moveToLevel({
        level: matterLevel(command.value), transitionTime: 0, optionsMask: { executeIfOff: true }, optionsOverride: { executeIfOff: true },
      }));
    }
    signal.throwIfAborted();
  }

  /** Returns detached copies, suitable for application reconciliation. */
  devices() { return structuredClone([...this.reported.values()]); }

  /** Closes observers, protocol resources, and certificate storage without erasing the fabric. */
  async close() {
    this.closed = true;
    for (const close of this.telemetryCleanup) close();
    this.telemetryCleanup.clear();
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    await this.node?.close();
    await this.certificateService?.close();
  }
}
