# Photon initial spec

Photon is an open-source, Matter-first smart home hub installed on user-owned hardware, such as a Raspberry Pi.

## Agreed direction

- **Local only:** Setup, management, and device control operate on the local network without a cloud service or cloud account dependency.
- **Platform agnostic:** Independent of a particular smart-home ecosystem, with Linux on ARM64 and x86-64 for hub deployment and native macOS for laptop development/testing.
- **Web interface:** The hub serves a browser UI for onboarding, managing, and controlling devices.
- **Initial language:** TypeScript. Keep a clear API boundary between frontend and backend so either can evolve independently.
- **Hardware:** Support compatible radio adapters as needed; exact hardware support remains to be defined.
- **Initial device types:** Matter lights and smart plugs.

## Backend foundation

- **Scope:** The backend is the complete, always-running hub service. It owns device discovery, onboarding and removal, device records and capabilities, names and rooms, command execution, reported state and availability, persistence, authentication, and host/radio integration management.
- **Runtime and language:** Node.js with TypeScript.
- **Prototype runtime:** Node.js 24.12+ within the 24.x series; npm workspaces and locked dependencies.
- **Prototype HTTP framework:** Fastify. Treat framework choice as replaceable and prioritize validating the hub's behavior.
- **Matter implementation:** matter.js is one internal protocol integration, isolated behind a dedicated backend interface so it can be replaced independently.
- **Frontend separation:** The web UI handles presentation and user interaction through an explicit API. Device management and ongoing device connections continue when all browsers are closed. The UI does not depend on backend implementation code or matter.js objects.
- **Serving:** The backend serves the static frontend, application API, and device-state updates.
- **Backend replacement:** The initial backend is a prototype intended to be replaceable. A later implementation may use Rust for the complete hub backend or individual components; the eventual stack remains open.

## Frontend delivery

- **Framework and language:** SolidJS with TypeScript.
- **Rendering:** Client-side rendering (CSR), with the frontend built ahead of deployment and served as static assets by the backend.
- **Loading:** Bundle the entire first-release UI for upfront loading, without lazy-loaded routes.
- **Local assets:** Ship all required scripts, styles, and other UI assets with Photon; no runtime CDN dependencies.
- **Priorities:** Minimize the complete production bundle and simplify frontend serving through static assets and CSR. The backend retains full hub responsibilities. Vite is the build tool.

## Implemented prototype milestone

- **Journey:** Create the owner, onboard a Wi-Fi Matter light or smart plug through a manual code, control on/off and supported brightness, and retain pairing across a hub restart. Plug-in units have dedicated outlet presentation and capability-based controls.
- **Existing devices:** Support on-network commissioning through a current sharing code from the existing controller. Discover over local mDNS/IP, retain production attestation, skip Wi-Fi credentials/provisioning, and preserve existing controller fabrics.
- **Access:** HTTP bound to localhost, with SSH forwarding for remote access. Local LAN HTTPS setup is deferred.
- **Deployment:** Native Linux service on ARM64/x86-64; foreground macOS execution on Apple Silicon/Intel, using CoreBluetooth for commissioning. macOS requires Bluetooth permission and Apple's Matter developer profile; Linux HCI adapter selection does not apply there.
- **Validation:** Application/browser checks use a fake adapter; separate protocol tests use a real matter.js device simulator at a known IPv6 loopback address. Physical BLE discovery and offline Wi-Fi-light acceptance require separate hardware runs on each supported platform. macOS Intel execution remains pending.
- **Deferred from this milestone:** Color, rooms, QR scanning, Thread, backup/restore, and updates. The broader first-release direction below remains planned.

## Application API

- **Requests:** Versioned HTTP/JSON API under `/api/v1` for queries, commands, and configuration.
- **Live updates:** One authenticated Server-Sent Events (SSE) connection per active UI client for device state, availability, and operation progress.
- **Contracts:** Keep JSON request, response, and event shapes explicit and independent of backend implementation types. For the prototype, use lightweight definitions and validation; defer comprehensive OpenAPI documentation and client generation until useful.
- **Operations:** Long-running tasks such as onboarding return an operation ID; progress and results remain queryable after a browser disconnect. Commands distinguish accepted, completed, and failed states.
- **Reconnect recovery:** Resynchronize state after a stream interruption so the UI recovers missed changes.
- **Ownership:** The backend owns device behavior and state; the API exposes application concepts independently of matter.js and SQLite internals.

## First-release device controls

- **Lights:** On/off, brightness, color temperature, and color. Show only controls supported by the device.
- **Smart plugs:** On/off control and current on/off state. Energy monitoring is deferred.
- **Both:** Naming, room assignment, connection status, and state updates when controlled elsewhere.

## Network support sequence

- **First working prototype:** Matter over Wi-Fi/Ethernet.
- **First release:** Include Matter over Thread as well.
- **Later:** Zigbee support is deferred.

## Thread network management

- **Default:** Photon sets up and manages OpenThread Border Router on the host using a supported USB Thread radio.
- **Hardware compatibility:** Specific adapters and firmware requirements remain to be defined.
- **External border routers:** Compatibility is not yet scoped.

## Device commissioning

- **First release:** Bluetooth commissioning runs on the Photon host using a compatible Bluetooth adapter.
- **Web UI:** Users scan or enter a device's setup code; the backend performs commissioning and supplies network configuration when needed.
- **Setup range:** Devices using Bluetooth commissioning must be within Bluetooth range of the host. The browser device does not supply the Bluetooth connection.
- **Phone-side commissioning:** Not included in the first release.

## Local access

- **First release:** One local owner account, created during initial setup.
- **Authentication:** Password-based login with persistent browser sessions; no email address, cloud account, or internet connection required. Explicit `PHOTON_DEV_NO_AUTH=1` skips setup/login for local testing only, without changing stored credentials or pairings; normal authentication remains the default.
- **Recovery:** Provide a local password-recovery procedure; its mechanism remains to be defined.
- **Later:** Separate household accounts and permission levels are deferred.

## Persistence and backups

- **Application storage:** SQLite via Node's built-in `node:sqlite`, with versioned SQL migrations. The prototype stores device identities, owner-account data, sessions, and sanitized operations; rooms/settings follow their features.
- **Protocol persistence:** Use matter.js's supported SQLite persistence for Matter credentials and protocol state; OpenThread Border Router manages Thread network persistence. Keep protocol-owned state separate from Photon's application schema.
- **Normal operation:** Persist device pairings, credentials, and settings across hub restarts.
- **Wi-Fi reuse:** Explicit opt-in remembers one network in the protected local app database. The browser receives only saved-network metadata; commissioning resolves the password server-side. macOS Keychain import is explicit and subject to OS permissions. Setup codes and Wi-Fi secrets never enter operation history/SSE.
- **Later:** User-facing backup and restore, including manual and scheduled backups, are deferred beyond the first release.

## Still open

- Later-release schema and API extensions. Routine implementation choices can use practical prototype defaults.
- Detailed onboarding and recovery flows, and supported Thread and Bluetooth radio hardware.
- Distribution, updates, security model, and open-source license.

## Next discussion

Focus remaining planning on installation, hardware compatibility, and the first device-control journey; resolve routine prototype tooling during implementation.
