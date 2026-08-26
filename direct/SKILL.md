---
name: direct
description: Set up, configure, verify, or repair a Sprite that runs Paseo and Codex together in direct mode, with Paseo exposed through the Sprite HTTPS service, active agent turns keeping the Sprite awake, and optional Cloudflare alarms waking it for scheduled tasks. Use when a user wants direct Paseo access to their own Sprite, wants to install Paseo on a Sprite without the relay, needs scheduled Sprite wake-ups, or needs to troubleshoot this repository's direct-mode setup.
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
- keep the Sprite alive with a short-expiry task only while an agent is working;
- install dormant support for optional scheduled wake-ups; and
- print the host-side command required to make the Sprite URL public.

To override the tested versions only when the user requests specific versions, set `PASEO_VERSION` and `CODEX_VERSION` for the installer invocation.

Cloudflare is not part of the base installation. Do not initiate Wrangler login,
deploy a Worker, request a sync token, or configure schedule synchronization
unless the user explicitly wants Paseo schedules to wake a sleeping Sprite. In
base mode, `~/.paseo/cloudflare-alarm.json` remains absent and the wrapper does
not start the schedule synchronizer.

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

## Optional Cloudflare scheduled wake-up

Use this only after the user explicitly opts into scheduled wake-ups. If they do
not need schedules to work while the Sprite is asleep, skip this section
entirely. Cloudflare deployment and authentication must run from a clone on the
user's computer, never from inside the Sprite.

1. Ask the user to run `bun install` and `bunx wrangler login` from `<skill-directory>/cloudflare` on their computer. Stop
   and wait for them to confirm. Do not operate the OAuth prompt or ask for Cloudflare credentials.
2. After confirmation, verify `bunx wrangler whoami`, run `bun run deploy`, and record the HTTPS Worker URL.
3. Ask the user to run `bunx wrangler secret put PASEO_SYNC_TOKEN` from the same host directory and enter a unique token
   of at least 32 characters. The agent must not generate, read, print, pipe, or retrieve the token. Wait for confirmation.
4. Ask the user to open an interactive terminal inside the Sprite and run
   `/home/sprite/bin/configure-cloudflare-alarm`. They must enter the Worker URL and the same token. The agent must not
   operate this prompt. Wait for a reply such as `done`.
5. Restart the managed service with `sprite-env services restart paseo`. Inspect service logs for
   `Synchronized Paseo schedules with Cloudflare alarms`; never print the alarm config file.

The Worker receives only the Sprite ID, its canonical `https://<id>.sprites.app` origin, schedule IDs, and next-run
timestamps. It stores one Durable Object per Sprite and wakes only that canonical origin's `/api/health` endpoint. It never
receives schedule prompts or Paseo/Codex credentials. The shared bearer token is the only additional runtime secret; no
Cloudflare credential belongs inside the Sprite.

For an end-to-end test, create a disposable Paseo schedule far enough in the future to allow the Sprite to sleep, confirm
the sync log and `paseo-schedule-wake` task around the due time, verify the scheduled agent starts, then delete the test
schedule. Do not leave a surprise scheduled agent behind.

## Preserve lifecycle behavior

Keep `scripts/run-paseo-direct`, `scripts/count-active-agents.mjs`, and `scripts/sync-paseo-schedules.mjs` together with the installer. The wrapper refreshes the `paseo-active-agents` Sprite task while a Paseo agent is `initializing` or `running` and does not require attention. It releases the task when work finishes or control returns to the user. For an imminent scheduled run, the schedule helper creates a separate three-minute `paseo-schedule-wake` task. Both holds have bounded expiries so a crashed wrapper cannot keep the Sprite awake indefinitely.

Tune this behavior only when requested through the service environment: `PASEO_POLL_SECONDS`, `PASEO_TASK_REFRESH_SECONDS`, `PASEO_TASK_EXPIRE`, `PASEO_TASK_NAME`, and `PASEO_SCHEDULE_TASK_NAME`.
