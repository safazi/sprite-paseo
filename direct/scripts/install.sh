#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly INSTALL_DIR="${DIRECT_INSTALL_DIR:-/home/sprite/bin}"
readonly PASEO_HOME_DIR="${PASEO_HOME:-/home/sprite/.paseo}"
readonly CODEX_HOME_DIR="${CODEX_HOME:-/home/sprite/.codex}"
readonly PASEO_VERSION="${PASEO_VERSION:-0.4.0}"
readonly CODEX_VERSION="${CODEX_VERSION:-0.144.3}"
readonly SERVICE_NAME="${PASEO_SERVICE_NAME:-paseo}"

if [[ ! -S /.sprite/api.sock ]]; then
    echo "This installer must run inside a Sprite." >&2
    exit 1
fi

for command_name in node npm sprite-env curl; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
        echo "Required command not found: ${command_name}" >&2
        exit 127
    fi
done

sprite_url="$(
    node -e '
        const { execFileSync } = require("node:child_process");
        const info = JSON.parse(execFileSync("sprite-env", ["info"], { encoding: "utf8" }));
        process.stdout.write(info.sprite_url);
    '
)"

if [[ -z "${sprite_url}" ]]; then
    echo "Could not determine this Sprite URL." >&2
    exit 1
fi

echo "Installing Paseo ${PASEO_VERSION} and Codex ${CODEX_VERSION}..."
npm install --global --allow-scripts=node-pty "@getpaseo/cli@${PASEO_VERSION}"
npm install --global "@openai/codex@${CODEX_VERSION}"

node_path="$(command -v node)"
npm_prefix="$(npm prefix --global)"
paseo_path="${npm_prefix}/bin/paseo"
codex_path="${npm_prefix}/bin/codex"
paseo_provider_manifest="${npm_prefix}/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/protocol/dist/provider-manifest.js"

if [[ ! -x "${paseo_path}" || ! -x "${codex_path}" || ! -f "${paseo_provider_manifest}" ]]; then
    echo "Expected npm executables were not installed under ${npm_prefix}/bin." >&2
    exit 1
fi

# Sprite login shells include ~/.local/bin, while npm's active global prefix may
# live under /.sprite/languages. Keep stable user-facing commands across wakes.
install -d -m 755 /home/sprite/.local/bin
ln -sfn "${paseo_path}" /home/sprite/.local/bin/paseo
ln -sfn "${codex_path}" /home/sprite/.local/bin/codex

install -d -m 755 "${INSTALL_DIR}"
install -m 755 "${SCRIPT_DIR}/run-paseo-direct" "${INSTALL_DIR}/run-paseo-direct"
install -m 755 "${SCRIPT_DIR}/count-active-agents.mjs" "${INSTALL_DIR}/count-active-agents.mjs"
install -m 755 "${SCRIPT_DIR}/configure-paseo.mjs" "${INSTALL_DIR}/configure-paseo.mjs"
install -m 755 "${SCRIPT_DIR}/configure-codex.mjs" "${INSTALL_DIR}/configure-codex.mjs"
install -m 755 "${SCRIPT_DIR}/sync-paseo-schedules.mjs" "${INSTALL_DIR}/sync-paseo-schedules.mjs"
install -m 755 "${SCRIPT_DIR}/write-cloudflare-alarm-config.mjs" "${INSTALL_DIR}/write-cloudflare-alarm-config.mjs"
install -m 755 "${SCRIPT_DIR}/configure-cloudflare-alarm" "${INSTALL_DIR}/configure-cloudflare-alarm"
install -d -m 700 "${PASEO_HOME_DIR}"

"${node_path}" "${INSTALL_DIR}/configure-paseo.mjs" \
    "${PASEO_HOME_DIR}/config.json" \
    "${sprite_url}"

"${node_path}" "${INSTALL_DIR}/configure-codex.mjs" \
    "${CODEX_HOME_DIR}/config.toml" \
    "${paseo_provider_manifest}"

password_configured=true
if ! node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit(config.daemon?.auth?.password ? 0 : 1);
' "${PASEO_HOME_DIR}/config.json"; then
    password_configured=false
    echo "Paseo password setup is waiting for the user; the Sprite URL must remain private."
fi

echo
echo "Codex installed at ${codex_path}. Authenticate it with 'codex login' if needed."

if sprite-env services get "${SERVICE_NAME}" >/dev/null 2>&1; then
    echo "Replacing existing Sprite service '${SERVICE_NAME}' while preserving ${PASEO_HOME_DIR}."
    sprite-env services stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
    sprite-env services delete "${SERVICE_NAME}" >/dev/null
fi

sprite-env services create "${SERVICE_NAME}" \
    --cmd "${INSTALL_DIR}/run-paseo-direct" \
    --env "PASEO_NODE_BIN=${node_path},PASEO_CLI_BIN=${paseo_path},PASEO_HOME=${PASEO_HOME_DIR},PASEO_ACTIVE_AGENT_HELPER=${INSTALL_DIR}/count-active-agents.mjs,PASEO_SCHEDULE_SYNC_HELPER=${INSTALL_DIR}/sync-paseo-schedules.mjs,PASEO_ALARM_CONFIG=${PASEO_HOME_DIR}/cloudflare-alarm.json" \
    --dir /home/sprite \
    --http-port 8080 \
    --duration 10s

if [[ "${password_configured}" != true ]]; then
    echo "Sprite URL left private until Paseo password setup is complete."
fi

echo
echo "Direct Paseo endpoint after the host-side publish step: ${sprite_url}"
echo "Paseo iOS: add a direct host using $(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "${sprite_url}"), port 443, SSL enabled."
echo "Health check after publishing: curl --fail ${sprite_url}/api/health"

if [[ "${password_configured}" != true ]]; then
    echo
    echo "USER ACTION REQUIRED: Open an interactive Sprite terminal and run:"
    echo "  paseo daemon set-password"
    echo "Then tell the installing agent that setup is done. The agent must not run the password flow."
fi

echo
echo "IMPORTANT: Run this OUTSIDE the Sprite, in a terminal where the Sprite CLI is authenticated:"
echo "  sprite config update --url-auth public -s <sprite-name>"
echo "The in-Sprite CLI cannot publish its own URL because it does not have your host CLI authentication."
if [[ "${password_configured}" != true ]]; then
    echo "DO NOT publish until the user confirms that the Paseo password is configured."
fi
