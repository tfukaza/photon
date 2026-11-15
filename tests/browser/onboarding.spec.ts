import { test, expect } from '@playwright/test';
import type { Operation } from '../../packages/contracts/src/index.js';

test('hardware onboarding clears secrets, waits for confirmation, and recovers progress after closing and reloading', async ({ page }) => {
  let accepted = false;
  let release!: () => void;
  const submission = new Promise<void>(resolve => { release = resolve; });
  const operation: Operation = { id: 'pending-setup', kind: 'commissioning', status: 'running',
    progress: 'Discovering and commissioning the device', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    timeline: [{ stage: 'discovery', title: 'Discover commissionable devices', detail: 'Searching for a candidate; no identity verified yet.', status: 'running', at: new Date().toISOString() }] };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/setup')) return route.fulfill({ json: { initialized: true, mode: 'hardware' } });
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true } });
    if (path.endsWith('/commissioning')) {
      await submission; accepted = true;
      return route.fulfill({ status: 202, json: operation });
    }
    if (path.endsWith('/events')) {
      const snapshot = { type: 'snapshot', data: { devices: [], operations: accepted ? [operation] : [] } };
      return route.fulfill({ contentType: 'text/event-stream', body: `retry: 100\ndata: ${JSON.stringify(snapshot)}\n\n` });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '+ Add a device', exact: true }).click();
  await expect(page.getByRole('note')).toHaveCount(0);
  await page.getByLabel('Matter setup code').fill('34970112332');
  await page.getByLabel('Wi-Fi name').fill('test-network');
  await page.getByLabel('Wi-Fi password').fill('test-network-password');
  await page.getByLabel('Country code').fill('US');
  await page.getByRole('button', { name: 'Connect device', exact: true }).click();
  await expect(page.getByLabel('Matter setup code')).toHaveValue('');
  await expect(page.getByLabel('Wi-Fi password')).toHaveValue('');
  release();
  await expect(page.getByRole('dialog')).toContainText('Connecting to the device…');
  await expect(page.getByRole('dialog').getByLabel('Matter setup timeline')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Open diagnostic JSON' })).toHaveAttribute('href', '/api/v1/operations/pending-setup');
  await expect(page.getByRole('dialog').locator('.stage-event')).toHaveCount(1);
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Waiting at this stage');
  await expect(page.getByRole('heading', { name: 'Device connected', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Wi-Fi password')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close add device' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'View setup progress' }).click();
  await expect(page.getByRole('dialog')).toContainText('Discovering and commissioning the device');
  operation.progress = 'Waiting for Bluetooth connection; PASE is not authenticated yet';
  operation.timeline!.push(
    { stage: 'transport', title: 'Connect to discovered candidate', detail: 'Advertisement found; waiting for a transport connection.', status: 'running', at: new Date().toISOString() },
    { stage: 'ble-connect', title: 'Connect to Bluetooth candidate', detail: 'The library is starting a GATT connection attempt.', status: 'running', at: new Date().toISOString() },
  );
  await expect(page.getByRole('dialog')).toContainText('GATT connection attempt');
  await expect(page.getByRole('dialog').getByText('Establish PASE setup session', { exact: true })).toHaveCount(0);
  operation.progress = 'Paired; verifying the device’s live state';
  operation.timeline!.push(
    { stage: 'discovery', title: 'Discover commissionable devices', detail: 'Candidate authenticated by PASE.', status: 'completed', at: new Date().toISOString() },
    { stage: 'transport', title: 'Connect to discovered candidate', detail: 'Transport established.', status: 'completed', at: new Date().toISOString() },
    { stage: 'ble-connect', title: 'Connect to Bluetooth candidate', detail: 'GATT connection reached service discovery.', status: 'completed', at: new Date().toISOString() },
    { stage: 'pase', title: 'Establish PASE setup session', detail: 'Encrypted setup session established.', status: 'completed', at: new Date().toISOString() },
    { stage: 'TimeSynchronization.SynchronizeTime', title: 'Synchronize time', detail: 'The device did not require this stage.', status: 'skipped', at: new Date().toISOString() },
    { stage: 'verify-state', title: 'Verify live device state', detail: 'Waiting for a fresh operational on/off read.', status: 'running', at: new Date().toISOString() },
  );
  await expect(page.getByRole('dialog')).toContainText(operation.progress);
  await expect(page.getByRole('dialog').locator('.stage-skipped')).toContainText('Synchronize time');
  await expect(page.getByRole('dialog').locator('.stage-running').last()).toContainText('Verify live device state');
  await expect(page.getByRole('heading', { name: 'Device connected', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/onboarding-timeline-desktop.png', fullPage: true });
  operation.timeline!.push({ stage: 'verify-state', title: 'Verify live device state', detail: 'A fresh on/off report was received.', status: 'completed', at: new Date().toISOString() });
  operation.status = 'completed'; operation.progress = 'Completed';
  await expect(page.getByRole('heading', { name: 'Device connected', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.reload();
  await page.getByText('View setup details', { exact: true }).click();
  await expect(page.locator('details .stage-event')).toHaveCount(operation.timeline!.length);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/onboarding-timeline-mobile.png', fullPage: true });
});

test('real simulator mode has a distinct notice and asynchronous failure remains retryable', async ({ page }) => {
  const operation: Operation = { id: 'failed-setup', kind: 'commissioning', status: 'failed',
    progress: 'The device paired, but its live state could not be verified. Keep it powered on and restart Photon to reconnect before pairing again.',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    timeline: [{ stage: 'verify-state', title: 'Verify live device state', detail: 'No live on/off report was received.', status: 'failed', at: new Date().toISOString() }] };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/setup')) return route.fulfill({ json: { initialized: true, mode: 'simulator' } });
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true } });
    if (path.endsWith('/commissioning')) return route.fulfill({ status: 202, json: operation });
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'snapshot', data: { devices: [], operations: [] } })}\n\n` });
  });
  await page.goto('/');
  await expect(page.getByRole('note')).toContainText('Matter simulator — connects to a separate test-device process');
  await page.getByRole('button', { name: '+ Add a device', exact: true }).click();
  await page.getByLabel('Matter setup code').fill('34970112332');
  await page.getByLabel('Country code').fill('US');
  await page.getByRole('button', { name: 'Connect device', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Setup not confirmed');
  await expect(page.getByRole('dialog').locator('.stage-failed')).toContainText('No live on/off report was received.');
  await expect(page.getByRole('dialog').getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toContainText('restart Photon to reconnect before pairing again');
  await page.getByRole('button', { name: 'Back to setup' }).click();
  await expect(page.getByLabel('Matter setup code')).toBeEditable();
});
