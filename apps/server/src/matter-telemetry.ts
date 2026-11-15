import { Logger, LogDestination, LogLevel } from '@matter/general';
import type { CommissioningUpdate } from '../../../packages/contracts/src/index.js';
import { randomUUID } from 'node:crypto';

interface Rule { facility: string; pattern: RegExp; events: CommissioningUpdate[] }

/** Builds a fixed, credential-free event from a known SDK boundary. */
function event(stage: string, title: string, detail: string, status: CommissioningUpdate['status']): CommissioningUpdate {
  return { stage, title, detail, status };
}

// These templates match pinned matter.js 0.18.0. Captured strings are never copied to telemetry.
const rules: Rule[] = [
  { facility: 'NobleBleClient', pattern: /^Found peripheral [^\r\n]+ \([^\r\n]*\): /, events: [event('ble-advertisement', 'Observe Bluetooth advertisement', 'A peripheral advertisement reached the library. Matter service data and setup-code matching are not yet confirmed.', 'completed')] },
  { facility: 'NobleBleClient', pattern: /^Peripheral [^\r\n]+ is not connectable \.\.\. ignoring$/, events: [event('ble-advertisement-connectability', 'Check Bluetooth connectability', 'A peripheral advertisement was not connectable and was ignored.', 'skipped')] },
  { facility: 'BleScanner', pattern: /^(?:Re-)?Discovered device [^\r\n]+ data: /, events: [event('ble-matter-advertisement', 'Validate Matter advertisement', 'The library decoded valid Matter service data. This alone does not establish a match to the supplied setup code or authenticate the device.', 'completed')] },
  { facility: 'NobleBleClient', pattern: /^Start BLE scanning for Matter Services \.\.\.$/, events: [event('ble-scan', 'Scan for Matter Bluetooth advertisements', 'The Bluetooth scanner was asked to start looking for Matter services.', 'running')] },
  { facility: 'NobleBleClient', pattern: /^Bluetooth adapter is powered on, BLE discovery started$/, events: [event('ble-scan', 'Scan for Matter Bluetooth advertisements', 'The adapter reported that BLE scanning started.', 'running')] },
  { facility: 'NobleBleClient', pattern: /^Stop BLE scanning for Matter Services \.\.\.$/, events: [event('ble-scan', 'Scan for Matter Bluetooth advertisements', 'The scanner was asked to stop. This does not imply successful authentication.', 'completed')] },
  { facility: 'NobleBleClient', pattern: /^BLE discovery deferred until the Bluetooth adapter reports "poweredOn"/, events: [event('ble-radio', 'Wait for Bluetooth adapter', 'Scanning is deferred until the adapter is powered on and this process has Bluetooth permission.', 'running')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: Connect to Peripheral now \(try \d+, state [a-zA-Z]+\)$/, events: [event('ble-connect', 'Connect to Bluetooth candidate', 'The library is starting a GATT connection attempt to a discovered candidate.', 'running')] },
  { facility: 'BleChannel', pattern: /^Timeout while connecting to peripheral [^\r\n]+$/, events: [event('ble-connect', 'Connect to Bluetooth candidate', 'The GATT connection attempt timed out before service discovery. PASE has not been confirmed.', 'failed')] },
  { facility: 'BleChannel', pattern: /^Timeout while interviewing peripheral [^\r\n]+$/, events: [event('ble-services', 'Discover Bluetooth services', 'The GATT service/characteristic discovery attempt timed out.', 'failed')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: connection attempt failed, try again$/, events: [event('ble-connect', 'Retry Bluetooth connection', 'A candidate connection failed; the library is retrying. Native error text is omitted.', 'running')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+ disconnected while trying to connect \(reason [^\r\n]+\), try again$/, events: [event('ble-connect', 'Retry Bluetooth connection', 'The candidate disconnected during connection establishment; the library is retrying.', 'running')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: Found services: /, events: [event('ble-connect', 'Connect to Bluetooth candidate', 'The GATT connection reached service discovery.', 'completed'), event('ble-services', 'Discover Bluetooth services', 'Service discovery returned; checking the required Matter characteristics next.', 'running')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: Found C1 characteristic$/, events: [event('ble-c1', 'Find Matter write characteristic', 'The Matter C1 characteristic is available for outgoing data.', 'completed')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: Found C2 characteristic$/, events: [event('ble-c2', 'Find Matter notification characteristic', 'The Matter C2 characteristic is available for incoming notifications.', 'completed')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: Missing required Matter characteristics\. Ignore\.$/, events: [event('ble-services', 'Discover Bluetooth services', 'This candidate lacks required Matter characteristics and was ignored.', 'failed')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: Sending BTP handshake request: /, events: [event('ble-services', 'Discover Bluetooth services', 'The required Matter characteristics were found.', 'completed'), event('btp-handshake', 'Negotiate Bluetooth transport (BTP)', 'A BTP handshake write is being attempted; waiting for the peer’s response.', 'running')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: Subscribing to C2 characteristic$/, events: [event('ble-notifications', 'Subscribe to Bluetooth notifications', 'The library is attempting to subscribe to incoming C2 notifications.', 'running')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: Received Matter handshake response: /, events: [event('ble-notifications', 'Subscribe to Bluetooth notifications', 'A BTP handshake response arrived on C2.', 'completed'), event('btp-handshake', 'Exchange Bluetooth transport handshake (BTP)', 'A BTP handshake response arrived. The SDK must still validate/adopt it; response receipt alone does not prove a usable transport or PASE authentication.', 'completed')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: Handshake Response not received\. Disconnect from peripheral$/, events: [event('btp-handshake', 'Negotiate Bluetooth transport (BTP)', 'The BTP handshake timed out before a usable response was received.', 'failed')] },
  { facility: 'BtpSessionHandler', pattern: /^Got Matter message to send via BLE transport: /, events: [event('ble-outgoing', 'Send Matter data over Bluetooth', 'A Matter message was queued for BLE transport. The payload is not recorded.', 'completed')] },
  { facility: 'BleChannel', pattern: /^Peripheral [^\r\n]+: received data on C2: /, events: [event('ble-incoming', 'Receive Bluetooth data', 'C2 data arrived from a candidate. Contents and device identifiers are omitted.', 'completed')] },
  { facility: 'BtpSessionHandler', pattern: /^Acknowledgement for the sent sequence number was not received \.\.\. disconnect$/, events: [event('btp-ack', 'Wait for Bluetooth transport acknowledgement', 'The peer did not acknowledge a transmitted BTP packet; the library is disconnecting.', 'failed')] },
  { facility: 'PaseClient', pattern: /^Paired successfully$/, events: [event('pase', 'Establish PASE setup session', 'The SDK reported a successful setup-code handshake for a candidate. Device attestation is still separate.', 'completed')] },
  { facility: 'CommissioningConnection', pattern: /^Address [^\r\n]+ unreachable for [^\r\n]+$/, events: [event('candidate-retry', 'Candidate connection was unreachable', 'A candidate address did not respond; discovery or other candidate attempts may continue.', 'failed')] },
];

/** Translates only allowlisted log templates; never formats payloads, errors, or diagnostic objects. */
export function translateMatterTelemetry(facility: string, first: unknown): CommissioningUpdate[] {
  if (typeof first !== 'string') return [];
  if (facility === 'NobleBleClient' && first.startsWith('Noble state changed to ')) {
    const state = first.slice('Noble state changed to '.length);
    const descriptions: Record<string, string> = { poweredOn: 'Bluetooth is powered on.', poweredOff: 'Bluetooth is powered off.', unauthorized: 'macOS denied Bluetooth permission to this process.', unsupported: 'Bluetooth is unsupported.', resetting: 'Bluetooth is resetting.', unknown: 'Bluetooth state is not known yet.' };
    if (!Object.hasOwn(descriptions, state)) return [];
    return [event('ble-radio', 'Bluetooth adapter state', descriptions[state], state === 'poweredOn' ? 'completed' : state === 'unauthorized' || state === 'unsupported' ? 'failed' : 'running')];
  }
  return rules.find(rule => rule.facility === facility && rule.pattern.test(first))?.events.map(update => ({ ...update })) ?? [];
}

/**
 * Installs an attempt-scoped SDK sink that persists only sanitized transport milestones.
 * Repeated copies of each event are capped independently, so packet noise cannot suppress later failures.
 */
export function observeMatterTelemetry(report: (update: CommissioningUpdate) => void, signal: AbortSignal, transport: 'ble' | 'on-network' = 'ble') {
  const name = `photon-commissioning-${randomUUID()}`;
  let closed = false;
  const repetitions = new Map<string, number>();
  const destination = LogDestination({ name, level: LogLevel.FATAL,
    facilityLevels: Object.fromEntries((transport === 'ble'
      ? ['NobleBleClient', 'BleScanner', 'BleChannel', 'BtpSessionHandler', 'PaseClient', 'CommissioningConnection']
      : ['PaseClient', 'CommissioningConnection']).map(facility => [facility, LogLevel.DEBUG])),
    add(message) {
      if (closed || signal.aborted) return;
      if (transport === 'on-network' && !['PaseClient', 'CommissioningConnection'].includes(message.facility)) return;
      for (const update of translateMatterTelemetry(message.facility, message.values[0])) {
        const key = `${update.stage}:${update.status}:${update.detail}`;
        const count = repetitions.get(key) ?? 0;
        if (count >= 10) {
          if (count === 10) {
            repetitions.set(key, 11);
            report(event(`telemetry-limit-${update.stage}`, 'Limit repeated transport observations', 'Ten copies of this event were recorded. Further identical copies are omitted; other event types and failures remain visible.', 'skipped'));
          }
          continue;
        }
        repetitions.set(key, count + 1);
        report(update);
      }
    },
  });
  /** Removes only this attempt’s sink without changing any existing logging destination. */
  const close = () => {
    if (closed) return;
    closed = true; signal.removeEventListener('abort', close);
    if (Object.hasOwn(Logger.destinations, name) && Logger.destinations[name] === destination) delete Logger.destinations[name];
  };
  if (!signal.aborted) { Logger.destinations[name] = destination; signal.addEventListener('abort', close, { once: true }); }
  return close;
}
