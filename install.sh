#!/usr/bin/env bash

set -euo pipefail

readonly INSTALL_DIR="/home/sprite/bin"
readonly PASEO_HOME_DIR="/home/sprite/.paseo"
readonly CONTROLLER_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bin/run-paseo-on-sprite"
readonly CONFIG_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config/paseo.config.example.json"

if [[ ! -S /.sprite/api.sock ]]; then
  echo "This installer must run inside a Sprite." >&2
  exit 1
fi

if sprite-env services get paseo >/dev/null 2>&1; then
  echo "A Sprite service named paseo already exists." >&2
  echo "Remove or rename it explicitly before running this fresh-install script." >&2
  exit 1
fi

npm install --global --allow-scripts=node-pty @getpaseo/cli

node_path=$(command -v node)
paseo_path=$(readlink -f "$(command -v paseo)")

install -d -m 755 "${INSTALL_DIR}"
install -m 755 "${CONTROLLER_SOURCE}" "${INSTALL_DIR}/run-paseo-on-sprite"
install -d -m 700 "${PASEO_HOME_DIR}"

if [[ ! -e "${PASEO_HOME_DIR}/config.json" ]]; then
  install -m 600 "${CONFIG_SOURCE}" "${PASEO_HOME_DIR}/config.json"
else
  echo "Preserving existing ${PASEO_HOME_DIR}/config.json"
fi

sprite-env services create paseo \
  --cmd "${INSTALL_DIR}/run-paseo-on-sprite" \
  --env "PASEO_NODE_BIN=${node_path},PASEO_CLI_BIN=${paseo_path},PASEO_STARTUP_GRACE_SECONDS=600,PASEO_IDLE_GRACE_SECONDS=300,PASEO_POLL_SECONDS=15" \
  --dir /home/sprite \
  --duration 10s

echo
echo "Paseo is running. Pair the phone with:"
echo "  paseo daemon pair"
