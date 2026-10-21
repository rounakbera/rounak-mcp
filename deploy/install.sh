#!/bin/sh
# Installs the server, tunnel and hourly auto-update as systemd user units (no root needed).
# Re-run after changing any unit file in deploy/.
set -eu
cd "$(dirname "$0")/.."
DIR=$(pwd)
NODE=$(command -v node)
BIN=$(dirname "$NODE")
UNITS="$HOME/.config/systemd/user"
mkdir -p "$UNITS"
for unit in rounak-mcp.service cloudflared-rounak-mcp.service rounak-mcp-update.service rounak-mcp-update.timer; do
  sed "s#@DIR@#$DIR#g; s#@NODE@#$NODE#g; s#@BIN@#$BIN#g" "deploy/$unit" > "$UNITS/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now rounak-mcp cloudflared-rounak-mcp rounak-mcp-update.timer
echo "Installed. To keep them running without an open login session: sudo loginctl enable-linger $USER"
