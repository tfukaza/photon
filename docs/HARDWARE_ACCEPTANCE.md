# Physical and platform acceptance

Status: **Pending.** Application and simulator tests do not replace these runs.

Record date, operator, OS/version, architecture, Node version, Photon revision, Bluetooth adapter/chip/firmware, network interface, light manufacturer/model/firmware, and trust snapshot source commit. For macOS, also record Bluetooth/local-network permission and Matter developer-profile status. Do not record passwords, setup codes, or fabric private keys.

| Check | Result / evidence |
| --- | --- |
| Install and start as the service account on Linux ARM64 | Pending |
| Install and start as the service account on Linux x86-64 | Pending |
| Start in foreground on macOS Apple Silicon; physical BLE onboarding | Pending |
| Start in foreground on macOS Intel; physical BLE onboarding | Pending |
| Reach the UI through SSH forwarding; create the single owner | Pending |
| Reject malformed/wrong setup code; allow retry | Pending |
| Attempt setup with the light absent; no successful setup or fabricated online light | Pending |
| Discover the physical light through hub-side BLE | Pending |
| Provision Wi-Fi and complete attestation/CASE | Passed on macOS ARM64 for the factory-reset Tapo plug, 2026-10-29; operation `e7b85093-7dac-47f8-9851-da22225ef929`. Light/Linux remain pending. |
| Report setup success only after a fresh operational on/off read; keep dialog pending until then | Pending |
| Retain paired device credentials if live verification fails; restart to reconnect | Pending |
| Control on/off and supported brightness | Pending |
| Pair a physical Matter-over-Wi-Fi smart plug; verify outlet presentation, fresh state, on/off, and restart recovery | BLE pairing, fresh on/off read, and hub restart recovery passed on macOS ARM64, 2026-10-29. Physical command effects remain pending. |
| Add an already-configured physical plug over LAN with its sharing code; verify PASE, production attestation, CASE, and fresh on/off state | Passed on macOS ARM64, 2026-10-29; Tapo smart plug. Operation `9a1e809b-5690-485f-9ade-152029f0ea9a`. Reported On; no appliance toggling performed. |
| Observe a physical-switch state change where supported | Pending |
| Close the browser; state management continues | Pending |
| Restart Photon; same device identity reconnects without re-pairing | Passed on macOS ARM64 for both LAN-shared and directly BLE-paired Tapo plug, 2026-10-29; Linux remains pending. |
| Power-cycle the light; availability and control recover | Pending |
| Interrupt onboarding; report failure and recover/reconcile | Pending |
| Block Internet access while retaining LAN; repeat fresh-store onboarding and control | Pending |
| Reset owner password through CLI; old sessions lose access | Pending |

Use a dedicated test light. A clean-store repeat requires removing Photon from that device or factory-resetting that test device before onboarding again. Keep unrelated household fabrics/devices intact. Fresh-store onboarding, rather than only control after an online setup, is required for offline acceptance.

Document failures with sanitized operation statuses and local service logs. A pending or failed row must remain visible in the delivery report.

## macOS diagnostic — 2026-10-29

A real discovery/PASE-only attempt used the user-supplied plug code without provisioning Wi-Fi or installing a fabric on the plug. The Mac reported Bluetooth states `unknown` then `poweredOn`; no matching candidates were discovered during the 30-second search, ending with `DeviceNotDiscoveredError`. PASE was not established. Device model/firmware and range were not confirmed, so this does not isolate the underlying cause or establish physical onboarding acceptance.

The current user's configuration-profile listing did not name a Matter/Bluetooth Central developer profile. Native Wi-Fi queries hid the current SSID. After the user supplied a network name, explicit Keychain import succeeded and the network was saved without exposing its password. A full hardware commissioning retry using that saved network then expired at the 120-second discovery deadline, with no candidate or PASE completion reported. Wi-Fi provisioning and physical onboarding therefore remain unverified. No setup code, network name, or Wi-Fi password is recorded here.

After installation of Apple's device-level Bluetooth developer profile, a system-managed setting check confirmed `EnableBluetoothCentralMatterClientDeveloperMode=1`. The Mac had not restarted since installation (last boot October 19). A subsequent attempt with transport telemetry confirmed adapter `poweredOn`, an actual BLE scan-start report, and no selected candidate/GATT/PASE completion before the 120-second timeout. Operation `6b5dd12e-0073-4847-a9b1-4755deca9ecc` retains the sanitized trace. Older candidate-only records labeled PASE as running prematurely; current code labels them as transport waiting and records actual SDK boundaries separately. Restart activation and a fresh physical pairing window remain required checks.

The user subsequently confirmed that the Tapo plug was already configured. The LAN-sharing path then succeeded: mDNS discovery, PASE, production attestation, operational credentials, CASE, commissioning completion, state subscription, and a forced fresh on/off read all completed. Photon reported one online plug endpoint with confirmed On state and no brightness capability. A subsequent hub restart retained the same device/endpoint identity, recovered online On state without re-pairing, and preserved the completed operation history. Bluetooth first-time provisioning, appliance switching, Internet-blocked hardware setup, and Linux hardware acceptance remain separate pending checks.

On October 29 (local time), after the user reported a full physical factory reset and no subsequent Tapo setup, Photon attempted Bluetooth commissioning using the same user-supplied code and saved Wi-Fi credentials. Operation `9202b5fb-241a-4534-b47a-db1e600be3f6` reached the 120-second deadline and failed with `TIMEOUT`. Telemetry confirmed Bluetooth powered on, scanning started, and a candidate event of unconfirmed transport origin; it did not confirm a BLE advertisement, GATT connection, authenticated PASE, Wi-Fi provisioning, or a fresh operational report. The previous device record was offline/stale with unknown power. This attempt neither validates nor rejects the code; first-time Bluetooth onboarding remains unverified.

Follow-up diagnostics isolated two integration issues: CoreBluetooth candidates had empty addresses despite valid local UUIDs, and outbound PASE selected the incoming-only Bleno peripheral interface. Photon now explicitly disables server BLE transport, enables controller BLE, and normalizes missing macOS addresses to valid local device UUIDs before SDK discovery. With no diagnostic preload, operation `e7b85093-7dac-47f8-9851-da22225ef929` completed in about 21 seconds after the user reopened the initial window by power cycling. The same supplied code authenticated PASE; production attestation, fabric installation, Wi-Fi provisioning, operational CASE, commissioning completion, subscriptions, and a forced fresh OnOff read passed. No Tapo setup was performed after the reported factory reset. The new peer was online and reported On; no appliance switching was attempted. The previous pairing remains offline/stale. No Mac restart was performed during this successful run; upstream profile-install/restart guidance still applies to installation instructions. Exact plug model/firmware remain unconfirmed.

A subsequent normal hub restart retained the directly BLE-paired device identity `1dd3d03f97f99081-2` and recovered an online, non-stale reported Off state without re-pairing. The old factory-reset identity stayed offline. The temporary diagnostic preload was removed; the server runs the built application normally. Typecheck/build, 113 application tests, and the real Matter simulator commissioning/control/restart suite passed.
