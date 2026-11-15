import { test, expect, type Page } from '@playwright/test';
import type { Device } from '../../packages/contracts/src/index.js';

/** Exercises presentation states without commissioning hardware or changing an owner account. */
async function preview(page: Page, state: { initialized: boolean; authenticated: boolean; devices: Device[] }) {
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/setup')) return route.fulfill({ json: { initialized: state.initialized, mode: 'hardware' } });
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: state.authenticated } });
    if (path.endsWith('/wifi')) return route.fulfill({ json: { saved: false, importAvailable: false } });
    const snapshot = { type: 'snapshot', data: { devices: state.devices, operations: [] } };
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(snapshot)}\n\n` });
  });
}

test('dark access screens and local Geist load with external requests blocked', async ({ page, browser }) => {
  const externalRequests: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') {
      externalRequests.push(url.origin);
      return route.abort();
    }
    return route.fallback();
  });
  const state = { initialized: false, authenticated: false, devices: [] };
  await preview(page, state);
  await page.emulateMedia({ colorScheme: 'light' });
  const fontResponse = page.waitForResponse(response => response.url().endsWith('/fonts/geist/Geist-Variable.woff2'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  expect((await fontResponse).ok()).toBe(true);
  expect(await page.evaluate(async () => (await document.fonts.load('400 16px Geist')).length)).toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: 'Photon', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up Photon' })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
  await page.screenshot({ path: 'test-results/access-setup-desktop.png', fullPage: true });
  await page.locator('.photon-wordmark').screenshot({ path: 'test-results/wordmark-1x.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/access-setup-mobile.png', fullPage: true });
  state.initialized = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeFocused();
  await page.screenshot({ path: 'test-results/access-signin-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/access-signin-desktop.png', fullPage: true });
  expect(externalRequests).toEqual([]);

  const retina = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  try {
    const retinaPage = await retina.newPage();
    await preview(retinaPage, state);
    await retinaPage.goto('http://127.0.0.1:14000/');
    await retinaPage.locator('.photon-wordmark').screenshot({ path: 'test-results/wordmark-mobile-2x.png' });
  } finally { await retina.close(); }
});

test('device grids and onboarding remain usable at narrow, tablet, and desktop widths', async ({ page }) => {
  const state: { initialized: boolean; authenticated: boolean; devices: Device[] } = {
    initialized: true, authenticated: true, devices: [],
  };
  await preview(page, state);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Let’s turn something on.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/empty-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '+ Add a device', exact: true }).click();
  await expect(page.getByLabel('Connection method')).toBeVisible();
  await page.screenshot({ path: 'test-results/onboarding-form-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/onboarding-form-mobile.png', fullPage: true });
  const connect = page.getByRole('button', { name: 'Connect device', exact: true });
  await connect.scrollIntoViewIfNeeded();
  await expect(connect).toBeInViewport();
  expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/onboarding-form-mobile-scrolled.png', fullPage: true });
  await page.getByRole('button', { name: 'Close add device' }).click();
  state.devices = Array.from({ length: 5 }, (_, index): Device => ({
    id: `preview-${index}`, name: index === 0 ? 'Living room / unusually-long-device-name-without-spaces' : `Device ${index + 1}`,
    availability: index === 3 ? 'offline' : 'online', stale: index === 3,
    endpoints: index === 4 ? [] : [{ id: '1', kind: index === 1 ? 'plug' : 'light',
      brightnessSupported: index !== 1, power: index % 2 === 0, brightness: 65 }],
  }));
  await page.reload();
  await expect(page.getByRole('heading', { name: state.devices[0]!.name })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on Device 4', exact: true })).toBeDisabled();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/device-grid-${width}.png`, fullPage: true });
  }
});
