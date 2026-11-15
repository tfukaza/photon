import { test, expect } from '@playwright/test';
import type { SavedWifi } from '../../packages/contracts/src/index.js';

test('remembered Wi-Fi is reused without returning its password and can be changed, forgotten, or imported', async ({ page }) => {
  let network: SavedWifi = { saved: false, importAvailable: true };
  let importDenied = true;
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/setup')) return route.fulfill({ json: { initialized: true, mode: 'hardware' } });
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true } });
    if (path.endsWith('/wifi/import')) {
      if (importDenied) return route.fulfill({ status: 400, json: { error: { message: 'Could not read that Wi-Fi password from Keychain.' } } });
      network = { saved: true, ssid: 'imported-network', importAvailable: true };
      return route.fulfill({ json: network });
    }
    if (path.endsWith('/wifi')) {
      if (route.request().method() === 'DELETE') network = { saved: false, importAvailable: true };
      return route.fulfill({ json: network });
    }
    if (path.endsWith('/commissioning')) {
      const body = route.request().postDataJSON(); submissions.push(body);
      if (body.rememberWifi) network = { saved: true, ssid: body.ssid, importAvailable: true };
      return route.fulfill({ status: 202, json: { id: String(submissions.length), kind: 'commissioning', status: 'completed', progress: 'Completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    }
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"snapshot","data":{"devices":[],"operations":[]}}\n\n' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '+ Add a device', exact: true }).click();
  await expect(page.getByLabel('Remember this Wi-Fi on the hub')).not.toBeChecked();
  await page.getByLabel('Wi-Fi name', { exact: true }).fill('remembered-network');
  await page.getByLabel('Wi-Fi password', { exact: true }).fill('test-private-password');
  await page.getByLabel('Remember this Wi-Fi on the hub').check();
  await page.getByLabel('Matter setup code').fill('34970112332');
  await page.getByLabel('Country code').fill('US');
  await page.getByRole('button', { name: 'Connect device', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '+ Add a device', exact: true }).click();
  await expect(page.getByLabel('Use saved Wi-Fi: remembered-network')).toBeChecked();
  await expect(page.getByLabel('Wi-Fi password', { exact: true })).toHaveCount(0);
  await page.getByLabel('Matter setup code').fill('34970112332');
  await page.getByLabel('Country code').fill('US');
  await page.getByRole('button', { name: 'Connect device', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(submissions[1]).toMatchObject({ useSavedWifi: true });
  expect(submissions[1]).not.toHaveProperty('ssid'); expect(submissions[1]).not.toHaveProperty('wifiPassword');
  await page.getByRole('button', { name: '+ Add a device', exact: true }).click();
  await page.getByLabel('Use saved Wi-Fi: remembered-network').uncheck();
  await expect(page.getByLabel('Wi-Fi name', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Wi-Fi password', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Forget saved Wi-Fi' }).click();
  await expect(page.getByText('Use saved Wi-Fi:', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Import from Mac Keychain' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Could not read');
  await expect(page.getByLabel('Wi-Fi password', { exact: true })).toBeEditable();
  importDenied = false;
  await page.getByLabel('Matter setup code').fill('34970112332');
  await page.getByLabel('Country code').fill('US');
  await page.getByRole('button', { name: 'Import from Mac Keychain' }).click();
  await expect(page.getByLabel('Use saved Wi-Fi: imported-network')).toBeChecked();
  await expect(page.getByLabel('Wi-Fi password', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Matter setup code')).toHaveValue('34970112332');
  await expect(page.getByLabel('Country code')).toHaveValue('US');
});
