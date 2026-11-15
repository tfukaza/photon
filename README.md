# Photon prototype

A local Matter controller with a SolidJS browser interface. This milestone supports a single owner, manual-code onboarding of Matter Wi-Fi lights and smart plugs, on/off, supported brightness, live state, and pairing recovery after restarting the hub. Thread management, color, rooms, QR scanning, and backups follow later.

Supported load types include Matter On/Off Plug-in Unit (`0x010A`) and Dimmable Plug-in Unit (`0x010B`), alongside the existing light types. Plug cards display an outlet symbol and on/off controls; brightness appears only when the endpoint exposes Level Control. Remote-only wall buttons/switches are not controllable loads and are not supported by this milestone.

## Develop and run

Use Node.js 24.12+ within the 24.x series. SQLite uses Node's built-in experimental `node:sqlite` module. Native Bluetooth and file-lock dependencies may need Python 3, make, a C/C++ toolchain, and platform development headers.

```sh
npm ci
npm run build
npm run cli -- setup-token
npm start
```

Open [Photon on localhost](http://127.0.0.1:3000), enter the CLI token, and choose a password of at least 12 characters. For a Linux hub, forward the UI with `ssh -L 3000:127.0.0.1:3000 user@hub` and use the same localhost URL on your computer. The HTTP server intentionally binds only to loopback. Matter communicates directly over the hub's LAN interface.

Hardware mode is the default. Its `.photon` directory has its own owner account and real pairings; `.photon-preview` is separate and must not be copied into it. If moving from the preview, stop that server, run `PHOTON_DATA_DIR=.photon node dist/apps/server/src/cli.js setup-token`, then start `PHOTON_DATA_DIR=.photon PHOTON_MODE=hardware npm start`. Create the hardware owner with this new token.

For application-only development, set `PHOTON_MODE=fake` before starting the backend. This uses a fake adapter, not the Matter protocol. `npm run dev` watches the backend; `npm run dev:web` runs Vite on localhost:5173 and proxies API requests. Build and production serving need no Vite process or external assets.

To temporarily skip owner setup and passwords while testing real lights locally, run:

```sh
PHOTON_DEV_NO_AUTH=1 PHOTON_MODE=hardware PHOTON_DATA_DIR=.photon npm start
```

The UI opens directly to the dashboard and displays a password-free testing notice. This option applies to API requests and live events, keeps the server on localhost, and does not change existing accounts, sessions, or pairings. Restart without `PHOTON_DEV_NO_AUTH=1` to restore normal authentication. Reload the browser after changing this startup option so its testing notice and login controls match the server. Only the exact value `1` enables it; it is disabled by default.

## Test on a Mac

Photon runs directly on macOS with Apple Silicon or Intel Node.js; build dependencies on the same architecture as your Node runtime. Install Node.js 24.12+ (24.x) and Apple's Command Line Tools (`xcode-select --install`) before `npm ci`. Linux's systemd installer is not needed on a laptop.

For a quick UI preview without a light or Bluetooth permissions:

```sh
npm ci
npm run build
PHOTON_DATA_DIR=.photon-preview npm run cli -- setup-token
PHOTON_DATA_DIR=.photon-preview PHOTON_MODE=fake npm start
```

Open http://127.0.0.1:3000 and use the printed token to create your owner account. Add a simulated light using manual code `34970112332`. This mode tests the application only. For real Matter exchanges without physical hardware, follow [Simulator and checks](#simulator-and-checks); it uses a separate hub data directory so its fabric and test certificates stay separate from hardware runs. Stop the preview with Control-C before starting another hub on port 3000. Preview data stays in `.photon-preview` across restarts.

For a physical Wi-Fi Matter light, use the normal `npm start` hardware mode and your Mac's Bluetooth controller:

- Turn Bluetooth on and grant Bluetooth access to the terminal or application launching Node in **System Settings → Privacy & Security → Bluetooth**.
- Install Apple's [Bluetooth Central Matter Client Developer Mode profile](https://developer.apple.com/services-account/download?path=/iOS/iOS_Logs/EnableBluetoothCentralMatterClientDeveloperMode.mobileconfig) and restart the Mac, as required by [matter.js's macOS Bluetooth guidance](https://github.com/matter-js/matter.js/blob/main/docs/TROUBLESHOOTING.md#additional-macos-bluetooth-information). Apple's download may require signing in. This is a development prerequisite; Photon does not install profiles or change macOS permissions.
- Allow local-network access for the launching application if macOS prompts. Keep the Mac and light on the same LAN with local IPv6/mDNS available; allow Node through the firewall if prompted. If automatic interface selection fails, set `PHOTON_INTERFACE` to the active interface (often `en0`).

On macOS, `PHOTON_HCI_ID` is ignored: the native CoreBluetooth backend selects the controller. The Mac acts as a BLE central for commissioning; the simulator runs over IP and does not need macOS BLE advertising. Photon disables the hub's incoming BLE peripheral transport and explicitly enables the controller transport. A compatibility shim uses CoreBluetooth's local device UUID when Noble supplies an empty/unknown address; it does not replace Matter authentication. Direct Bluetooth commissioning, Wi-Fi provisioning, production attestation, CASE, and a fresh on/off read passed with a factory-reset Tapo smart plug on the development Apple Silicon Mac. Physical light, Linux, and Intel Mac checks remain pending in [hardware acceptance](docs/HARDWARE_ACCEPTANCE.md).

## Real light on Linux

Start with Debian 12+/64-bit Raspberry Pi OS or Ubuntu 24.04, a working Bluetooth HCI adapter, and a Matter-over-Wi-Fi light. The hub needs local IPv6 unicast and multicast reachability and mDNS. Internet IPv6 and cloud accounts are unnecessary. Keep the hub on the same LAN as the light; guest Wi-Fi isolation and VLAN boundaries can prevent pairing and control.

On Debian/Ubuntu install the build and Bluetooth prerequisites before `npm ci`:

```sh
sudo apt-get install build-essential python3 libbluetooth-dev libudev-dev bluez
```

Enable the adapter using your distribution's Bluetooth tools. Put the light or smart plug in factory-new pairing mode near the hub. In the UI select **Add a device**, enter its manual Matter code, Wi-Fi name/password, and two-letter regulatory country. The browser sends setup information to the hub; it does not provide Bluetooth. Setup codes and Wi-Fi credentials are excluded from operation records and logs. Wi-Fi credentials are remembered only by explicit opt-in as described below.

Select **Remember this Wi-Fi on the hub** to save one network for future onboarding. Later attempts default to **Use saved Wi-Fi** and resolve the password on the server; HTTP responses never return it. Uncheck that option to use another network, or select **Forget saved Wi-Fi**. Remembering occurs when setup is accepted, even if that device later fails to pair. An in-flight attempt keeps its resolved network if the saved entry changes.

On macOS, **Import from Mac Keychain** can read an existing Wi-Fi password after explicit request and any macOS approval. If the OS hides the current SSID, enter the network name before importing. Photon does not override privacy restrictions or approve prompts. Import failures leave the prior remembered network intact.

The prototype stores the opted-in network in a dedicated table in the local SQLite database, protected by a `0700` data directory and `0600` database permissions. This is local credential storage without an additional encryption layer; protect the complete data directory. Forgetting removes the saved entry, while credentials already being used by an active setup remain in that operation’s memory until it finishes.

Accepting the setup request is not success. Photon keeps the dialog open through commissioning and an explicit fresh on/off read over the operational Matter connection, within the original 120-second setup deadline. You can close the dialog or browser and reopen **View setup progress** while setup continues. Fake mode carries a persistent UI-preview notice and labels its connection/results as simulated; the real Matter simulator has a separate notice.

The **Matter setup timeline** records actual transport/SDK milestones with timestamps: discovery candidates, PASE setup-code authentication, device capabilities, fail-safe, regulatory/time setup, device attestation, fabric credentials, access control, Wi-Fi provisioning, operational discovery/CASE, finalization, subscriptions, and the fresh state read. Stages report started/completed/skipped/failed/interrupted outcomes; the current stage shows elapsed waiting time. Wi-Fi scan/provision/join and operational discovery/CASE are grouped at the boundaries exposed by the library, rather than claiming packet-level visibility. Candidate discovery alone does not verify device identity. Simulator discovery/Wi-Fi bypasses are explicitly skipped, and fake mode reports only simulated work.

New timelines are persisted with setup operations and available under **Recent activity → View setup details** after closing the dialog or restarting Photon. Older operations retain their existing summary without an invented timeline. Raw protocol logs, setup codes, Wi-Fi credentials, and certificate/key material are not streamed into this view.

Bluetooth attempts also record adapter/scanner readiness, GATT connection attempts/retries/timeouts, Matter service/characteristic discovery, C2 notification subscription, BTP handshake request/response, data-arrival observations, and missing transport acknowledgements. These are translated from allowlisted diagnostic templates in the pinned SDK; payloads, addresses, native error strings, and arbitrary log objects are never formatted into the report. Repeated identical observations are limited to ten copies per type, with an explicit truncation event; later distinct failures and authentication results remain visible. A candidate advertisement now means **Connect to discovered candidate**, not proof that PASE has started. **Open diagnostic JSON** exposes the same sanitized operation record through `/api/v1/operations/:id` for troubleshooting.

If pairing finishes but live verification fails, Photon keeps the fabric credentials and shows the light as unavailable. Keep the light powered on and restart Photon using the same data directory to reconnect; do not immediately factory-reset or repeatedly pair it. A setup timeout can leave the pairing outcome uncertain, so check recent activity and the recovered device before retrying.

## Add an already-configured Matter device

For a plug already working in Tapo or another Matter controller, choose **Add a device → Connection method → Already set up on Wi-Fi**. Open the existing controller's sharing/Matter setup-code screen to generate a current code and open its commissioning window, then enter that code in Photon. For Tapo, see **Device Settings → Device Info → Matter Setup Code** (the exact navigation can vary by app version). The printed original code may not apply after another Matter ecosystem has commissioned the device.

Keep Photon and the device on the same LAN with mDNS and local IP connectivity. This path discovers and authenticates over the network, skips Wi-Fi provisioning, and never sends saved Wi-Fi credentials. It uses normal production certificate validation and the same live-state verification as Bluetooth setup. The existing controller and its fabric are retained. Do not select simulator mode or factory-reset a working device to use this flow.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PHOTON_DATA_DIR` | `.photon` | Persistent app and Matter data; keep the complete directory |
| `PHOTON_PORT` | `3000` | Loopback HTTP port |
| `PHOTON_MODE` | `hardware` | `hardware`, `simulator`, or explicit application-test `fake` |
| `PHOTON_DEV_NO_AUTH` | disabled | Set to `1` to skip setup/login for local testing |
| `PHOTON_INTERFACE` | automatic | LAN interface for Matter discovery, e.g. `eth0` |
| `PHOTON_HCI_ID` | `0` | Linux Bluetooth adapter index; ignored on macOS |
| `PHOTON_TRUST_FILE` | `assets/trust.json` | Packaged offline trust snapshot |

Only one controller process can hold a data directory. Do not delete or reinitialize Matter storage to troubleshoot a connection: it contains the identity needed to retain pairings. A timeout means the outcome may be uncertain; Photon keeps transport work serialized and reconciles any resulting peer.

## Service installation

Build on the target Linux machine, or unpack a release produced for the same OS/architecture. The installer copies the local Node runtime and release into `/opt/photon`, creates the `photon` account/data directory, and installs a systemd unit. Review it before running:

```sh
sudo env PHOTON_NODE="$(command -v node)" bash scripts/install-linux.sh
sudo systemctl enable --now photon
sudo journalctl -u photon -f
sudo -u photon env PHOTON_DATA_DIR=/var/lib/photon /opt/photon/runtime/bin/node /opt/photon/dist/apps/server/src/cli.js setup-token
```

Edit `/etc/photon/photon.env` for the network interface/HCI index, then restart the service. The service grants only the network capabilities needed for Linux HCI access (`CAP_NET_RAW`, `CAP_NET_ADMIN`) and restricts filesystem writes to its data directory. It does not run as root. Confirm adapter permissions with your installed Noble version if BLE initialization fails; do not enable broad root access as a workaround.

For a transferable runtime archive, run `npm run release` on each target OS/architecture. It installs production dependencies into a temporary release directory. It does not replace development dependencies in your checkout. Linux ARM64 and x86-64 builds and startup must be verified independently.

## Simulator and checks

The simulator is a separate real matter.js process with dimmable-light and on/off smart-plug endpoints and persistent credentials. Its loopback-only test-control port is not part of Photon's application API.

```sh
npm run simulator
# In another terminal, with a separate hub data directory:
PHOTON_MODE=simulator PHOTON_DATA_DIR=.photon-sim-hub npm run cli -- setup-token
PHOTON_MODE=simulator PHOTON_DATA_DIR=.photon-sim-hub npm start
```

Read the simulator's manual pairing code at [its local state endpoint](http://127.0.0.1:3001/state). Its test endpoints `POST /power` and `POST /plug-power` simulate pressing the light and plug switches respectively. Simulator mode explicitly accepts packaged test certificates; hardware mode does not.

The simulator profile commissions the known IPv6 loopback address `::1` on port 5540 (`PHOTON_SIM_MATTER_PORT` overrides it for both processes). This keeps the protocol test independent of same-host multicast discovery. It exercises real PASE/CASE, commands, subscriptions, and protocol persistence; discovery through BLE/mDNS on the actual LAN remains a hardware acceptance requirement.

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run test:protocol
```

Browser acceptance uses the production UI and fake adapter. Protocol acceptance starts fresh simulator and hub processes, commissions a real Matter test device, exercises commands/external state changes, and restarts both processes. A subprocess guard rejects remote HTTP requests and fails the run on attempted lookups. This checks application-level HTTP independence, rather than replacing an OS firewall or physical offline test. These checks do not establish physical Bluetooth, Linux architecture support, or blocked-Internet hardware acceptance. Record those runs in [hardware acceptance](docs/HARDWARE_ACCEPTANCE.md).

## Offline trust and runtime limits

`assets/trust.json` contains a versioned snapshot of upstream production PAA roots, certification-declaration signers, and explicitly separated development roots, including the public simulator roots bundled with matter.js 0.18.0. Hardware mode filters out development certificates. Its origin commit and preparation time are included in the snapshot.

`npm run trust:prepare` refreshes the snapshot during release preparation, using the public `project-chip/connectedhomeip` certificate repository at a fixed commit. Runtime services use offline seeding and never fetch DCL, GitHub, remote UI assets, telemetry, or updates. Post-quantum certificates exceeding the prototype's supported certificate size are omitted explicitly by the preparation script.

Unknown roots and cryptographic attestation failures reject onboarding. Current certificate revocation freshness is unavailable offline and is disclosed in the UI. This is a prototype trust policy, not a claim of Matter certification. Validate onboarding with a clean data directory and Internet access blocked before declaring offline hardware acceptance.

## Password recovery

Run the local CLI under the same account and data directory as the service. Supply the new password through standard input rather than process arguments:

```sh
read -rs -p 'New password: ' photon_password; printf '\n'
printf '%s' "$photon_password" | sudo -u photon env PHOTON_DATA_DIR=/var/lib/photon /opt/photon/runtime/bin/node /opt/photon/dist/apps/server/src/cli.js reset-password
unset photon_password
```

The reset invalidates stored sessions while preserving pairings. Existing event streams detect cross-process session revocation on their next heartbeat. User-facing backup/restore is deferred. SQLite and Matter upgrades must preserve their respective data directories; do not mix schema ownership or manually edit protocol credentials.

The project's open-source license remains to be selected. Third-party packages and the bundled certificate inputs retain their upstream licenses and notices.
