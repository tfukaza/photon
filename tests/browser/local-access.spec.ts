import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('password-free local testing opens directly to controls and stays signed in after reload', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'photon-no-auth-'));
  const child = spawn(process.execPath, ['dist/apps/server/src/main.js'], { env: { ...process.env,
    PHOTON_DEV_NO_AUTH: '1', PHOTON_MODE: 'fake', PHOTON_PORT: '14010', PHOTON_DATA_DIR: directory }, stdio: 'ignore' });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await expect.poll(async () => {
      try { return (await fetch('http://127.0.0.1:14010/api/v1/setup', { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, { timeout: 10_000 }).toBe(true);
    await page.goto('http://127.0.0.1:14010/');
    await expect(page.getByRole('heading', { name: 'Home controls' })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: 'Password-free local testing' })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Setup token')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await page.getByRole('button', { name: '+ Add a simulated device', exact: true }).click();
    await page.getByLabel('Matter setup code').fill('34970112332');
    await page.getByLabel('Country code').fill('US');
    await page.getByRole('button', { name: 'Simulate connection', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Simulated device added' })).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Test light' })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: 'Password-free local testing' })).toBeVisible();
    expect(await page.context().cookies()).toEqual([]);
  } finally {
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
    const result = await exited;
    clearTimeout(timeout);
    await rm(directory, { recursive: true, force: true });
    expect(result).toEqual({ code: 0, signal: null });
  }
});
