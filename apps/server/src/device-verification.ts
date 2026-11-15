import type { ClientNode } from '@matter/node';
import { OnOffClient } from '@matter/node/behaviors/on-off';
import { DescriptorClient } from '@matter/node/behaviors/descriptor';
import { OnOff } from '@matter/types/clusters';
import { Read } from '@matter/protocol';
import { delay } from './adapter.js';
import { AppError } from './errors.js';

/** Classifies supported load-control device types; remote-only switches are not controllable loads. */
export function deviceControlKind(types: readonly { deviceType: number }[]): 'light' | 'plug' | undefined {
  if (types.some(type => [0x100, 0x101, 0x10c, 0x10d].includes(type.deviceType))) return 'light';
  if (types.some(type => [0x10a, 0x10b].includes(type.deviceType))) return 'plug';
}

/** Selects non-root light or plug endpoints exposing a controllable On/Off server. */
export function supportedControlEndpoints(peer: ClientNode) {
  return [...peer.endpoints].filter(endpoint => Number(endpoint.number) !== 0 && endpoint.maybeStateOf(OnOffClient) &&
    deviceControlKind(endpoint.maybeStateOf(DescriptorClient)?.deviceTypeList ?? []));
}

/**
 * Requires a fresh operational read, never cached/default state, before confirming onboarding.
 * The caller's commissioning signal owns the entire deadline, including this verification.
 */
export async function confirmDeviceConnection(peer: ClientNode, signal: AbortSignal) {
  while (!peer.lifecycle.isConnected || !peer.lifecycle.isSeeded) await delay(100, signal);
  signal.throwIfAborted();
  const endpoint = supportedControlEndpoints(peer)[0];
  if (!endpoint) throw new AppError('UNSUPPORTED', 'The paired device has no supported light or smart-plug controls.');
  let confirmed = false;
  try {
    const request = Read(Read.Attribute({ endpoint: endpoint.number, cluster: OnOff.Cluster, attributes: 'onOff' }));
    const liveRequest = { ...request, includeKnownVersions: true, abort: signal };
    for await (const chunk of peer.interaction.read(liveRequest)) {
      for await (const report of chunk) {
        if (report.kind === 'attr-value' && report.path.endpointId === endpoint.number &&
          report.path.clusterId === OnOff.Cluster.id && report.path.attributeId === OnOff.Cluster.attributes.onOff.id &&
          typeof report.value === 'boolean') confirmed = true;
      }
    }
  } catch {
    signal.throwIfAborted();
    throw new AppError('VERIFICATION_FAILED', 'The device paired, but its live state could not be verified. Keep it powered on and restart Photon to reconnect before pairing again.');
  }
  signal.throwIfAborted();
  if (!confirmed || !peer.lifecycle.isConnected) {
    throw new AppError('VERIFICATION_FAILED', 'The device paired, but did not confirm its live on/off state. Keep it powered on and restart Photon to reconnect before pairing again.');
  }
}
