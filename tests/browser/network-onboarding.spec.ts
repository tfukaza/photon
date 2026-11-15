import { test, expect } from '@playwright/test';

test('existing Wi-Fi setup uses a sharing code without network credentials and preserves method selection', async ({ page }) => {
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/setup')) return route.fulfill({ json: { initialized: true, mode: 'hardware' } });
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true } });
    if (path.endsWith('/wifi')) return route.fulfill({ json: { saved: true, ssid: 'saved-network', importAvailable: true } });
    if (path.endsWith('/commissioning')) {
      const body = route.request().postDataJSON(); submissions.push(body);
      if (body.code === '123') return route.fulfill({ status: 400, json: { error: { message: 'Enter a valid Matter sharing code.' } } });
      return route.fulfill({ status: 202, json: { id: 'network-setup', kind: 'commissioning', status: 'failed', progress: 'No matching open commissioning window was found.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    }
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"snapshot","data":{"devices":[],"operations":[]}}\n\n' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '+ Add a device', exact: true }).click();
  await expect(page.getByLabel('Connection method')).toHaveValue('ble');
  await expect(page.getByLabel('Use saved Wi-Fi: saved-network')).toBeChecked();
  await page.getByLabel('Connection method').selectOption('on-network');
  await expect(page.getByRole('dialog')).toContainText('Generate a fresh Matter sharing code');
  await expect(page.getByLabel('Wi-Fi name', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Wi-Fi password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import from Mac Keychain' })).toHaveCount(0);
  await expect(page.getByLabel('Use saved Wi-Fi: saved-network')).toHaveCount(0);
  await page.getByLabel('Matter setup code').fill('123');
  await page.getByLabel('Country code').fill('US');
  await page.getByRole('button', { name: 'Connect device', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('valid Matter sharing code');
  await expect(page.getByLabel('Connection method')).toHaveValue('on-network');
  await page.getByLabel('Matter setup code').fill('34970112332');
  await page.getByLabel('Country code').fill('US');
  await page.getByRole('button', { name: 'Connect device', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Setup not confirmed');
  expect(submissions[1]).toEqual({ code: '34970112332', country: 'US', transport: 'on-network' });
  await page.getByRole('button', { name: 'Back to setup' }).click();
  await expect(page.getByLabel('Connection method')).toHaveValue('on-network');
  await page.getByRole('button', { name: 'Close add device' }).click();
  await page.getByRole('button', { name: '+ Add a device', exact: true }).click();
  await expect(page.getByLabel('Connection method')).toHaveValue('on-network');
  await page.getByLabel('Connection method').selectOption('ble');
  await expect(page.getByLabel('Use saved Wi-Fi: saved-network')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Import from Mac Keychain' })).toBeVisible();
});
