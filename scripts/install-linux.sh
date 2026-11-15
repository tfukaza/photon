#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Linux || "$EUID" != 0 ]]; then
  echo 'Run this installer as root on Linux.' >&2; exit 1
fi
case "$(uname -m)" in aarch64|x86_64) ;; *) echo 'Supported architectures: ARM64 and x86-64.' >&2; exit 1;; esac
node_binary="${PHOTON_NODE:-$(command -v node)}"
"$node_binary" -e 'if (process.versions.node.split(".")[0] !== "24") process.exit(1)'
for entry in dist/apps/server/src/main.js apps/web/dist/index.html assets/trust.json node_modules; do
  [[ -e "$entry" ]] || { echo "Missing release asset: $entry. Run npm ci, npm run trust:prepare, and npm run build first." >&2; exit 1; }
done
id photon >/dev/null 2>&1 || useradd --system --home-dir /var/lib/photon --shell /usr/sbin/nologin photon
install -d -m 755 /opt/photon /opt/photon/runtime/bin
install -m 755 "$node_binary" /opt/photon/runtime/bin/node
cp -R dist assets node_modules apps package.json package-lock.json /opt/photon/
install -d -o photon -g photon -m 700 /var/lib/photon
install -d -m 755 /etc/photon
if [[ ! -e /etc/photon/photon.env ]]; then
  printf 'PHOTON_DATA_DIR=/var/lib/photon\nPHOTON_MODE=hardware\nPHOTON_HCI_ID=0\n' > /etc/photon/photon.env
fi
chmod 600 /etc/photon/photon.env
install -m 644 scripts/photon.service /etc/systemd/system/photon.service
systemctl daemon-reload
echo 'Installed. Set PHOTON_INTERFACE in /etc/photon/photon.env if required.'
echo 'Start with: systemctl enable --now photon'
echo 'Setup token: sudo -u photon env PHOTON_DATA_DIR=/var/lib/photon /opt/photon/runtime/bin/node /opt/photon/dist/apps/server/src/cli.js setup-token'
