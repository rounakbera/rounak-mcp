#!/bin/sh
# Installs both services as systemd user units (no root needed).
set -eu
cd "$(dirname "$0")/.."
DIR=$(pwd)
NODE=$(command -v node)
UNITS="$HOME/.config/systemd/user"
mkdir -p "$UNITS"
for unit in gmail-mcp cloudflared-gmail-mcp; do
  sed "s#@DIR@#$DIR#g; s#@NODE@#$NODE#g" "deploy/$unit.service" > "$UNITS/$unit.service"
done
systemctl --user daemon-reload
systemctl --user enable --now gmail-mcp cloudflared-gmail-mcp
echo "Installed. To keep them running without an open login session: sudo loginctl enable-linger $USER"
