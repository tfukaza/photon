import '@matter/nodejs';
import { Environment } from '@matter/general';
import { ServerNode } from '@matter/node';
import { DimmableLightDevice } from '@matter/node/devices/dimmable-light';
import { OnOffPlugInUnitDevice } from '@matter/node/devices/on-off-plug-in-unit';
import { OnOffServer } from '@matter/node/behaviors/on-off';
import { LevelControlServer } from '@matter/node/behaviors/level-control';
import { VendorId } from '@matter/types';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const env = Environment.default;
env.vars.set('storage.path', resolve(process.env.PHOTON_SIM_DATA_DIR ?? '.photon-simulator'));
env.vars.set('storage.driver', 'sqlite');
env.vars.set('log.level', 'error');
env.vars.set('runtime.signals', false);
if (process.env.PHOTON_INTERFACE) env.vars.set('mdns.networkinterface', process.env.PHOTON_INTERFACE);
const node = await ServerNode.create({ id: 'simulator', commissioning: { passcode: 20202021, discriminator: 3840 },
  network: { port: Number(process.env.PHOTON_SIM_MATTER_PORT ?? 5540) },
  basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000, productName: 'Photon simulator', vendorName: 'Photon',
    nodeLabel: 'Simulator light', serialNumber: 'photon-simulator-1', uniqueId: 'photon-simulator-1' } });
const light = await node.add(DimmableLightDevice, { id: 'light', onOff: { onOff: false }, levelControl: { currentLevel: 127 } });
const plug = await node.add(OnOffPlugInUnitDevice, { id: 'plug', onOff: { onOff: false } });
await node.start();
const control = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET' && request.url === '/state') {
    response.end(JSON.stringify({ code: node.state.commissioning.pairingCodes.manualPairingCode,
      power: light.stateOf(OnOffServer).onOff, level: light.stateOf(LevelControlServer).currentLevel, plugPower: plug.stateOf(OnOffServer).onOff,
      commissioned: node.lifecycle.isCommissioned }));
  } else if (request.method === 'POST' && request.url === '/power') {
    await light.set({ onOff: { onOff: !light.stateOf(OnOffServer).onOff } });
    response.end('{}');
  } else if (request.method === 'POST' && request.url === '/plug-power') {
    await plug.set({ onOff: { onOff: !plug.stateOf(OnOffServer).onOff } });
    response.end('{}');
  } else { response.statusCode = 404; response.end('{}'); }
});
control.listen(Number(process.env.PHOTON_SIM_PORT ?? 3001), '127.0.0.1', () => console.log('Photon Matter simulator ready'));
let stopped = false;
/** Stops the simulated device without erasing its fabric membership. */
async function stop() {
  if (stopped) return;
  stopped = true;
  control.close(); await node.close();
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
