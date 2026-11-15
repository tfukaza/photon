# Certificate snapshot provenance

The public certificates in `trust.json` originate from `project-chip/connectedhomeip`, under `credentials/production` and `credentials/development`, at the commit recorded in the snapshot. The snapshot also includes public Matter test PAA certificates exported by `@matter/protocol` 0.18.0. No private keys were copied into this snapshot.

Upstream source: https://github.com/project-chip/connectedhomeip

Matter.js source: https://github.com/matter-js/matter.js

Both source repositories use Apache License 2.0. Certificate subject names and product/vendor identifiers belong to their respective issuers. Test certificates are marked explicitly and are excluded from hardware-mode trust.

Post-quantum certificates are outside this prototype's support and are omitted during snapshot preparation. Runtime revocation freshness is unavailable; the snapshot is an offline trust input, not a certification claim.
