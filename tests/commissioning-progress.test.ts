import { expect, it, vi } from 'vitest';
import { observeCommissioningStep } from '../apps/server/src/commissioning-progress.js';

it('reports the actual start and awaits the actual SDK result without changing it', async () => {
  let release!: (result: { code: number; breadcrumb: number }) => void;
  const execute = vi.fn(() => new Promise<{ code: number; breadcrumb: number }>(resolve => { release = resolve; }));
  const report = vi.fn();
  const observed = observeCommissioningStep('OperationalCredentials.DeviceAttestation', execute, report);
  const job = observed();
  expect(execute).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'running', title: 'Verify device attestation' }));
  const result = { code: 0, breadcrumb: 12 };
  release(result);
  await expect(job).resolves.toBe(result);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }));
});

it.each([[0, 'completed'], [1, 'failed'], [2, 'skipped'], [3, 'interrupted'], [999, 'failed']] as const)('maps SDK result %s to %s without inventing success', async (code, status) => {
  const report = vi.fn(); const result = { code, debugText: 'private-raw-device-diagnostic' };
  await expect(observeCommissioningStep('TimeSynchronization.SynchronizeTime', async () => result, report)()).resolves.toBe(result);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ status }));
  expect(JSON.stringify(report.mock.calls)).not.toContain('private-raw-device-diagnostic');
});

it('preserves errors for SDK recovery without exposing raw diagnostics in progress', async () => {
  const failure = new Error('secret-setup-code private-key wifi-password');
  const report = vi.fn();
  const observed = observeCommissioningStep('Reconnect', async () => { throw failure; }, report);
  await expect(observed()).rejects.toBe(failure);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'Reconnect', status: 'failed' }));
  expect(JSON.stringify(report.mock.calls)).not.toContain(failure.message);
});
