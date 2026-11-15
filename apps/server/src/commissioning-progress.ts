import { ControllerCommissioningFlow } from '@matter/protocol';
import type { CommissioningUpdate } from '../../../packages/contracts/src/index.js';

type Reporter = (update: CommissioningUpdate) => void;
const stages: Record<string, { title: string; detail: string }> = {
  GetInitialData: { title: 'Read commissioning capabilities', detail: 'Read device information, fail-safe limits, and supported network features.' },
  'GeneralCommissioning.ArmFailsafe': { title: 'Arm commissioning fail-safe', detail: 'Give the device a bounded window to finish setup or roll back incomplete changes.' },
  'GeneralCommissioning.ConfigureRegulatoryInformation': { title: 'Configure radio region', detail: 'Apply the supplied country and indoor regulatory configuration.' },
  'TimeSynchronization.SynchronizeTime': { title: 'Synchronize time', detail: 'Configure time information if the device supports it.' },
  'OperationalCredentials.DeviceAttestation': { title: 'Verify device attestation', detail: 'Validate the device certificate chain, signed attestation, and certification declaration against the offline trust snapshot.' },
  'OperationalCredentials.Certificates': { title: 'Install fabric credentials', detail: 'Request a certificate signing request and install the trusted root and operational certificate.' },
  AccessControl: { title: 'Configure access control', detail: 'Grant the Photon fabric permission to manage this device.' },
  'NetworkCommissioning.Validate': { title: 'Check network commissioning support', detail: 'Inspect supported network interfaces and existing configuration.' },
  'NetworkCommissioning.Wifi': { title: 'Provision and join Wi-Fi', detail: 'Scan for Wi-Fi, provision credentials, and join the network. The Matter library groups these substeps.' },
  'NetworkCommissioning.Thread': { title: 'Provision Thread network', detail: 'Configure the Thread network using the Matter library.' },
  Reconnect: { title: 'Discover operational device and establish CASE', detail: 'Find the device on the local IP network and establish a certificate-authenticated session. The Matter library groups discovery and CASE.' },
  'GeneralCommissioning.Complete': { title: 'Complete Matter commissioning', detail: 'Ask the device to commit setup and disarm its fail-safe.' },
  'OperationalCredentials.UpdateFabricLabel': { title: 'Set fabric label', detail: 'Apply the Photon label to the device’s fabric entry.' },
};

/** Observes real SDK step results without changing return values or thrown errors. */
export function observeCommissioningStep<T extends { code: number }>(name: string, execute: () => Promise<T>, report: Reporter) {
  const description = stages[name] ?? { title: 'Additional Matter commissioning step', detail: 'The library is executing an additional commissioning action.' };
  const update = { stage: name, ...description };
  return async () => {
    report({ ...update, status: 'running' });
    try {
      const result = await execute();
      // Non-exported CommissioningStepResultCode values in pinned matter.js 0.18.0.
      const outcomes: Record<number, CommissioningUpdate['status']> = { 0: 'completed', 1: 'failed', 2: 'skipped', 3: 'interrupted' };
      const status = outcomes[result.code] ?? 'failed';
      const detail = status === 'skipped' ? 'The device or current connection did not require this stage.'
        : status === 'interrupted' ? 'The library stopped this commissioning flow at this stage.'
        : status === 'failed' ? 'The library did not report success for this stage.' : update.detail;
      report({ ...update, status, detail });
      return result;
    } catch (error) {
      report({ ...update, status: 'failed', detail: 'This stage encountered an error. See the setup result for recovery guidance.' });
      throw error;
    }
  };
}

/** Adds stage boundaries to the normal or known-address simulator commissioning flow. */
export function trackedCommissioningFlow(Base: typeof ControllerCommissioningFlow, report: Reporter, simulator: boolean) {
  return class TrackedCommissioningFlow extends Base {
    /** PASE has authenticated the selected candidate before the SDK enters this flow. */
    override async executeCommissioning() {
      if (!simulator) report({ stage: 'transport', title: 'Connect to discovered candidate', detail: 'The selected candidate established a transport connection and completed PASE.', status: 'completed' });
      if (!simulator) report({ stage: 'discovery', title: 'Discover commissionable devices', detail: 'A candidate was selected by successful setup-code authentication.', status: 'completed' });
      report({ stage: 'pase', title: 'Establish PASE setup session', detail: 'The setup-code handshake established an encrypted session. Device attestation follows separately.', status: 'completed' });
      for (const step of this.commissioningSteps) step.stepLogic = observeCommissioningStep(step.name, step.stepLogic, report);
      await super.executeCommissioning();
      report({ stage: 'initial-state', title: 'Read endpoints and subscribe to state', detail: 'Read the device structure and establish ongoing attribute reports.', status: 'running' });
    }
  };
}
