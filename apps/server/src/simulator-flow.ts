import { ControllerCommissioningFlow, PeerSet } from '@matter/protocol';
import type { ServerNode } from '@matter/node';

/**
 * Supplies the simulator's known operational address after node-ID allocation, bypassing only
 * multicast discovery. PASE, attestation, credential installation, and CASE remain real Matter flows.
 */
export function simulatorCommissioningFlow(controller: ServerNode, port: number) {
  return class SimulatorCommissioningFlow extends ControllerCommissioningFlow {
    /** Seeds the operational target only after the controller has reserved its identity. */
    override async executeCommissioning() {
      controller.env.get(PeerSet).for(this.interaction.address).descriptor.operationalAddress = { ip: '::1', port, type: 'udp' };
      await super.executeCommissioning();
    }
  };
}
