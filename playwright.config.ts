import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHOTON_E2E_DIR ??= mkdtempSync(join(tmpdir(), 'photon-browser-'));
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:14000', trace: 'retain-on-failure' },
  webServer: { command: 'node dist/apps/server/src/main.js', url: 'http://127.0.0.1:14000/api/v1/setup', reuseExistingServer: false,
    env: { PHOTON_MODE: 'fake', PHOTON_PORT: '14000', PHOTON_DATA_DIR: process.env.PHOTON_E2E_DIR } },
});
