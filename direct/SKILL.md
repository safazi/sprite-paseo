---
name: direct
description: Set up, configure, verify, or repair a Sprite that runs Paseo and Codex together in direct mode, with Paseo exposed through the Sprite HTTPS service and active agent turns keeping the Sprite awake. Use when a user wants direct Paseo access to their own Sprite, wants to install Paseo on a Sprite without the relay, or needs to troubleshoot this repository's direct-mode setup.
---

# Set Up a Paseo Sprite

Configure Paseo as the Sprite HTTP service on port 8080. Use the bundled installer instead of recreating the configuration manually.

## Prepare

1. Confirm the current environment is a Sprite by checking for `/.sprite/api.sock`.
2. Inspect `sprite-env services list` and `~/.paseo/config.json` when present. Tell the user if an existing `paseo` service will be replaced; the installer preserves Paseo state and authentication under `~/.paseo`.
3. Never print the Paseo password, Codex credentials, environment variables, or the contents of private agent-state files.
4. Use a strong, unique Paseo password. The required host-side publish step makes the Sprite URL public at the transport layer; Paseo still authenticates its API and WebSocket. The bundled web UI is disabled; `/api/health` remains unauthenticated.
5. The user owns the interactive `paseo daemon set-password` flow. Never run it for them, operate its prompt, ask for the password, or retrieve the resulting password from configuration.

## Install

Resolve this skill's directory from the loaded `SKILL.md`, then run:

```bash
<skill-directory>/scripts/install.sh
```

The installer performs these operations:

- install the tested Paseo and Codex CLI versions;
- merge direct-mode settings without deleting existing Paseo state or authentication;
- make Codex full access the default Paseo mode without requiring an agent profile;
- enable Codex's interactive user-question tool globally;
- disable the Paseo relay and bundled web UI;
- register Paseo as the Sprite HTTP service on `0.0.0.0:8080`;
- keep the Sprite alive with a short-expiry task only while an agent is working; and
- print the host-side command required to make the Sprite URL public.

To override the tested versions only when the user requests specific versions, set `PASEO_VERSION` and `CODEX_VERSION` for the installer invocation.

## User password checkpoint

If the installer reports that no Paseo password is configured, keep the Sprite URL private and tell the user to open an interactive Sprite terminal and run:

```bash
paseo daemon set-password
```

Then stop and wait for the user to confirm completion. A reply such as `done` is sufficient; do not ask them to disclose the password. The agent must not execute this command through `sprite exec` or an automated console session.

After the user confirms, restart the managed service with `sprite-env services restart paseo`, then continue to the host-side publish step. Treat the user's confirmation as the checkpoint; do not inspect the stored password.

## Publish the Sprite URL from the host

The installer cannot make the URL public from inside the Sprite. The command below **must run outside the Sprite**, in a terminal on the user's computer where the `sprite` CLI is already authenticated to the organization that owns the target Sprite:

```bash
sprite config update --url-auth public -s <sprite-name>
```

Never run this command through `sprite exec`, in a Sprite console, or from the installer. The in-Sprite CLI does not have the authenticated host credentials required to change URL access. After the user confirms the password checkpoint, the agent may run this command from the authenticated host terminal.

Do not claim the endpoint is externally reachable until the command succeeds from an authenticated host terminal.

## Verify

Get the Sprite URL from `sprite-env info`. Verify the service and lifecycle integration:

```bash
curl --fail https://<sprite-host>.sprites.app/api/health
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://<sprite-host>.sprites.app/)" = 404
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://<sprite-host>.sprites.app/api/config)" = 401
sprite-env services get paseo
sprite-env curl http://sprite/v1/tasks
```

Allow a few seconds for the first HTTPS request after a cold wake. The `401` proves that the public transport endpoint still enforces Paseo authentication. If a protected route does not return `401`, immediately restore Sprite authentication from the host with `sprite config update --url-auth sprite -s <sprite-name>` and report the failed verification. Report the hostname for a Paseo direct host using port `443` with SSL enabled, but never report or retrieve its password.

If verification fails, inspect the Paseo service logs and configuration metadata without exposing secrets. Restart an existing service with `sprite-env services restart paseo`; do not launch Paseo as an unmanaged background process.

For Codex, verify that `~/.codex/config.toml` contains top-level `sandbox_mode = "danger-full-access"` and that the installed Paseo Codex provider reports `full-access` as its default mode. Paseo 0.4.0 otherwise sends `workspace-write` with its default mode and overrides Codex's file-level sandbox setting.

## Preserve lifecycle behavior

Keep `scripts/run-paseo-direct` and `scripts/count-active-agents.mjs` together with the installer. The wrapper refreshes the `paseo-active-agents` Sprite task while a Paseo agent is `initializing` or `running` and does not require attention. It releases the task when work finishes or control returns to the user. The short expiry prevents a crashed wrapper from holding the Sprite awake indefinitely.

Tune this behavior only when requested through the service environment: `PASEO_POLL_SECONDS`, `PASEO_TASK_REFRESH_SECONDS`, `PASEO_TASK_EXPIRE`, and `PASEO_TASK_NAME`.
