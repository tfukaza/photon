# Future specification tasks

These are planning items, not implemented behavior or a change to the current prototype scope.

## Matter onboarding: ask about the device's current setup

- [ ] Start onboarding with a plain-language question: **“How is this device set up today?”**
  - **New or factory-reset device:** Not configured yet; guide the user through opening initial pairing mode, entering/scanning the Matter code, and provisioning the network when needed.
  - **Already connected to another smart-home system:** Explain how to open Matter sharing/pairing in the existing controller, obtain the current code, and add Photon without removing the existing system.
  - **Already on Wi-Fi or Thread, but not connected to a Matter controller:** Cover devices provisioned through a manufacturer's app or another mechanism. Guide the user to open a Matter commissioning window and pair over the existing network when supported; do not assume Wi-Fi setup means a Matter association already exists.
  - **Not sure:** Offer discovery and guided questions without requiring protocol knowledge.
- [ ] Treat these answers as guidance, then verify what discovery and the commissioning handshake can establish. Do not infer another controller's ownership solely from network connectivity, a blinking LED, or a generic failure.
- [ ] Keep network membership and Matter authorization separate in the specification. A Thread border router supplies IP connectivity; it does not by itself assign the device to a Matter controller/fabric.
- [ ] For each path, define prerequisites, pairing-window instructions, discovery transport, progress messages, actionable failures, and recovery steps. Explain that knowing a code does not guarantee that a commissioning window is open.
- [ ] Show whether Photon is discovering over Bluetooth or the local network, whether it actually authenticated the device, and whether it is configuring a network or using an existing connection. Only report stages the backend can verify.
- [ ] Keep Thread onboarding as a future specification item; define existing-network/border-router compatibility before promising support.

## Automatically display vendor and model

- [ ] Show vendor and model automatically during device discovery, selection, setup progress, and the final result, as soon as the relevant information is available. Keep this information visible on dashboard entries and device details alongside the user's chosen name.
- [ ] Prefer device-reported Basic Information VendorName and ProductName after connection. Where early discovery provides only VendorID/ProductID, use bundled/local metadata to resolve readable names when available; do not require a cloud lookup.
- [ ] Distinguish preliminary discovery labels from information confirmed through authenticated setup. Show a clear unknown-vendor/model fallback when metadata is absent, and update labels as setup learns more without blocking onboarding.
- [ ] Help users distinguish candidates of different brands/models; do not imply that vendor/model alone distinguishes two identical units. Preserve user-assigned names when metadata arrives or changes.
- [ ] Validate labels throughout setup, missing metadata, multiple candidates, two identical models, offline operation, and persistence after restart.

## Pairing windows, sharing, and re-adding devices

- [ ] Explain the difference between the setup code and the commissioning window. A timer may expire while the displayed code remains unchanged; expiration does not remove an established pairing.
- [ ] Specify a local **“Share with another Matter system”** action so an authorized Photon instance can open a timed commissioning window and provide the appropriate code.
- [ ] Define removal separately from hiding a dashboard entry or retrying an interrupted operation. Explain when removal revokes Photon's authorization and how the user can add the device again afterward.
- [ ] Cover recovery when another authorized controller remains, when Photon was the last Matter fabric, and when Photon's protocol credentials have been lost. Verify device-specific last-fabric behavior rather than assuming an automatic reset or open pairing window.
- [ ] Document first-time setup without the manufacturer's app, including supported physical pairing/reset procedures. Keep reset a deliberate recovery action and verify instructions against the exact model.

## Device identity and replacement after reset

- [ ] Give each Photon device a stable application ID independent of its current Matter fabric/node ID. Re-pairing should be able to replace a protocol association while preserving the dashboard entry, name, room, and compatible automation references.
- [ ] Collect authenticated Basic Information identity metadata during successful onboarding: VendorID, ProductID, UniqueID, and SerialNumber when available. Keep identity data local and out of routine telemetry. Evaluate an attestation-certificate/public-key fingerprint as additional evidence, including certificate lifecycle limitations, before using it for matching.
- [ ] Account for the specification's identity boundaries: Matter Node IDs are fabric scoped; Basic Information UniqueID changes on factory reset in current specifications; serial numbers are optional. Codes, IP addresses, model names, and an offline old entry alone do not establish that two pairings represent the same physical device.
- [ ] Automatically reconcile a new pairing with an old entry only after successful commissioning and fresh state verification, with a documented, sufficiently reliable and unambiguous identity match. Validate manufacturer serial quality and collisions before trusting a vendor/product/serial tuple for automatic replacement.
- [ ] When identity evidence is missing or ambiguous, ask **“Is this replacing an existing device?”** and let the user select an old entry. Never silently merge two identical plugs based on model or availability.
- [ ] Retire/archive the old local association instead of creating a second visible tile; retain recovery/history information. Do not send removal commands to the newly paired device as part of local cleanup. Define endpoint/capability mapping before preserving automation references.
- [ ] Test reset and re-add, two identical plugs, missing/duplicated serials, changed UniqueID, failed onboarding, ambiguous matches, and restart persistence. Older Photon records may lack the metadata required for automatic matching.

## Research and acceptance examples

- [ ] Use the Tapo smart plug as a worked example. Record its exact model and firmware, distinguish Tapo's native setup from Matter commissioning, and verify what reopening its Matter-code screen changes. An unchanged code alone does not establish which commissioning-window method it uses.
- [ ] Validate new-device setup, an existing-network device with no Matter fabric, sharing from another controller, an expired window, retry after failure, and removal/re-addition. Include an unknown-state path with useful guidance instead of a generic handshake error.

### Research references

- [TP-Link Matter setup options, including setup without Tapo](https://www.tp-link.com/us/support/faq/3520/)
- [Tapo Matter setup and 15-minute pairing guidance](https://www.tapo.com/us/faqs/how-to-set-up-matter-devices-with-alexa-google-apple-and-smartthings/)
- [Matter discovery over Bluetooth and existing IP networks](https://developers.home.google.com/matter/primer/commissionable-and-operational-discovery)
- [Matter SDK multi-admin and commissioning-window procedure](https://project-chip.github.io/connectedhomeip-doc/development_controllers/chip-tool/chip_tool_guide.html#multi-admin-scenario)
- [Google Matter deduplication guidance and UniqueID reset behavior](https://developers.home.google.com/matter/device-deduplication)
