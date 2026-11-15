import { z } from 'zod';

export const setupInput = z.object({ token: z.string().min(1), password: z.string().min(12).max(256) }).strict();
export const loginInput = z.object({ password: z.string().min(1).max(256) }).strict();
export const wifiInput = z.object({ ssid: z.string().min(1).max(32), password: z.string().max(64) }).strict();
export const wifiImportInput = z.object({ ssid: z.string().min(1).max(32).optional() }).strict();
export interface SavedWifi { saved: boolean; ssid?: string; importAvailable: boolean }
export const commissionInput = z.object({
  code: z.string().min(1).max(32), transport: z.enum(['ble', 'on-network']),
  ssid: z.string().max(32).optional(), wifiPassword: z.string().max(64).optional(),
  useSavedWifi: z.boolean().optional(), rememberWifi: z.boolean().optional(),
  country: z.string().regex(/^[A-Z]{2}$/),
}).strict().superRefine((value, context) => {
  if (value.transport === 'ble' && !value.useSavedWifi && (!value.ssid || value.wifiPassword === undefined)) {
    context.addIssue({ code: 'custom', message: 'Enter the Wi-Fi name and password.' });
  }
  if (value.useSavedWifi && (value.ssid !== undefined || value.wifiPassword !== undefined || value.rememberWifi)) {
    context.addIssue({ code: 'custom', message: 'Choose saved Wi-Fi or supply new network details, not both.' });
  }
  if (value.transport !== 'ble' && (value.ssid !== undefined || value.wifiPassword !== undefined || value.useSavedWifi || value.rememberWifi)) {
    context.addIssue({ code: 'custom', message: 'Wi-Fi credentials and preferences apply only to Bluetooth provisioning.' });
  }
});
export const commandInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('power'), value: z.boolean() }).strict(),
  z.object({ type: z.literal('brightness'), value: z.number().int().min(1).max(100) }).strict(),
]);
export type CommissionInput = z.infer<typeof commissionInput>;
export type CommandInput = z.infer<typeof commandInput>;
export type Availability = 'connecting' | 'online' | 'offline';
export interface ControlEndpoint {
  id: string; kind: 'light' | 'plug'; brightnessSupported: boolean;
  power: boolean | null; brightness: number | null;
}
export interface Device {
  id: string; name: string; availability: Availability; stale: boolean;
  endpoints: ControlEndpoint[];
}
export type OperationStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'interrupted';
export interface CommissioningUpdate {
  stage: string; title: string; detail: string;
  status: 'running' | 'completed' | 'skipped' | 'failed' | 'interrupted';
}
export interface CommissioningEvent extends CommissioningUpdate { at: string }
export interface Operation {
  id: string; kind: 'commissioning' | 'command'; status: OperationStatus;
  progress: string; deviceId?: string; error?: { code: string; message: string };
  createdAt: string; updatedAt: string;
  timeline?: CommissioningEvent[];
}
export interface Snapshot { devices: Device[]; operations: Operation[] }
export type HubEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'device'; data: Device }
  | { type: 'operation'; data: Operation };
