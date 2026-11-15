import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './errors.js';
import { wifiInput } from '../../../packages/contracts/src/index.js';

type NativeCommand = (file: string, args: string[]) => Promise<string>;
const execFileAsync = promisify(execFile);

/** Captures native command output in memory, with no shell, credential arguments, or raw error logging. */
async function executeNative(file: string, args: string[]) {
  const { stdout } = await execFileAsync(file, args, { timeout: 60_000, maxBuffer: 64 * 1024, encoding: 'utf8' });
  return stdout;
}

/**
 * Imports an explicitly requested Wi-Fi network from the Mac login Keychain.
 * macOS may require user approval; unavailable/redacted network names require an explicit SSID.
 */
export async function importMacWifi(ssid?: string, platform = process.platform, run: NativeCommand = executeNative) {
  if (platform !== 'darwin') throw new AppError('WIFI_IMPORT_UNAVAILABLE', 'Keychain Wi-Fi import is available only on the Mac running Photon.');
  if (!ssid) {
    try {
      const ports = await run('/usr/sbin/networksetup', ['-listallhardwareports']);
      const device = ports.match(/Hardware Port: (?:Wi-Fi|AirPort)\r?\nDevice: (\S+)/)?.[1];
      if (device) {
        const network = await run('/usr/sbin/networksetup', ['-getairportnetwork', device]);
        const name = network.match(/^Current (?:Wi-Fi|AirPort) Network: (.+)\r?$/m)?.[1];
        if (name && name !== '<redacted>') ssid = name;
      }
    } catch { /* Native errors may include sensitive output; expose only the actionable message below. */ }
    if (!ssid) throw new AppError('WIFI_NAME_REQUIRED', 'macOS did not reveal the current Wi-Fi name. Enter the Wi-Fi name and try Keychain import again, or enter the password manually.');
  }
  try {
    const output = await run('/usr/bin/security', ['find-generic-password', '-D', 'AirPort network password', '-a', ssid, '-w']);
    return wifiInput.parse({ ssid, password: output.replace(/\r?\n$/, '') });
  } catch {
    throw new AppError('WIFI_IMPORT_FAILED', 'Could not read that Wi-Fi password from Keychain. Approve macOS access if prompted, or enter and remember the password manually.');
  }
}
