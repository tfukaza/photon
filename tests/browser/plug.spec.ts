import { test, expect } from '@playwright/test';
import type { Device, Operation } from '../../packages/contracts/src/index.js';

test('smart-plug controls show an outlet, omit brightness, and wait for reported state', async ({ page }) => {
  const device: Device = { id: 'plug-node', name: 'Desk plug', availability: 'online', stale: false,
    endpoints: [{ id: '4', kind: 'plug', brightnessSupported: false, power: false, brightness: null }] };
  const operation: Operation = { id: 'plug-command', deviceId: device.id, kind: 'command', status: 'running',
    progress: 'Waiting for the device', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const commands: { path: string; body: unknown }[] = [];
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/setup')) return route.fulfill({ json: { initialized: true, mode: 'hardware' } });
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true } });
    if (path.endsWith('/commands')) {
      commands.push({ path, body: route.request().postDataJSON() });
      return route.fulfill({ status: 202, json: operation });
    }
    const snapshot = { type: 'snapshot', data: { devices: [device], operations: commands.length ? [operation] : [] } };
    return route.fulfill({ contentType: 'text/event-stream', body: `retry: 100\ndata: ${JSON.stringify(snapshot)}\n\n` });
  });
  await page.goto('/');
  await expect(page.getByText('Outlet 4', { exact: true })).toBeVisible();
  await expect(page.getByRole('slider')).toHaveCount(0);
  await page.getByRole('button', { name: 'Turn on Desk plug', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Turn on Desk plug', exact: true })).toBeDisabled();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  expect(commands).toEqual([{ path: '/api/v1/devices/plug-node/endpoints/4/commands', body: { type: 'power', value: true } }]);
  operation.status = 'completed';
  await expect(page.getByRole('button', { name: 'Turn on Desk plug', exact: true })).toBeEnabled();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  device.endpoints[0].power = true;
  await expect(page.getByRole('button', { name: 'Turn off Desk plug', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'test-results/smart-plug-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/smart-plug-mobile.png', fullPage: true });
});
