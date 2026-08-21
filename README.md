# sprite-paseo

Run Codex in a Sprite and control it from the Paseo iOS app, while allowing the
Sprite to suspend automatically after agent work finishes.

## Modes

- [`direct/`](direct/SKILL.md) is the recommended Codex skill. Paseo is exposed
  through the Sprite HTTPS URL, and the Paseo connection itself wakes the
  Sprite. It does not need a separate waker.
- The controller below is the original relay-based mode. It stops Paseo after
  an idle grace period and therefore requires an external authenticated wake
  action.

## Why the controller exists

The relay-based mode keeps Paseo connected outbound and polls agent state.
Those activities can prevent automatic suspension, so this mode explicitly
stops Paseo after an idle grace period.

`bin/run-paseo-on-sprite` wraps Paseo with lifecycle control:

- Paseo listens only on `127.0.0.1:6767` and connects outbound to its relay.
- While any Paseo agent is active, the controller refreshes a two-minute
  Sprite task named `paseo-active-agents`.
- When all agents become idle, the task is deleted.
- Paseo stays online for a five-minute follow-up grace period.
- The controller then stops its own Sprite service, allowing suspension.
- An external wake action starts the registered `paseo` service again.

The startup grace period is ten minutes, giving the phone time to reconnect and
start work after a wake.

## Install on a fresh Sprite

```bash
git clone https://github.com/safazi/sprite-paseo.git
cd sprite-paseo
./install.sh
```

The installer:

- installs `@getpaseo/cli`;
- explicitly allows the required `node-pty` native install script;
- installs the controller in `/home/sprite/bin`;
- creates a private, loopback-only Paseo configuration if none exists;
- disables optional voice models by default;
- registers and starts the Sprite service.

It refuses to replace an existing `paseo` service or overwrite an existing
Paseo configuration.

## Pair the phone

```bash
paseo daemon pair
```

Scan the QR code or paste the generated link into Paseo. Treat that link as an
access credential.

No public Sprite HTTP endpoint is created. Never commit `~/.paseo`; it contains
the daemon identity, pairing state, push tokens, and agent records.

## Wake from a phone

Once idle shutdown occurs, Paseo will show the host offline. A relay message
cannot wake a cold Sprite by itself.

The external wake action must securely perform the equivalent of:

```bash
sprite-env services start paseo
```

This repository is designed to pair with `safazi/wake-up-call`. The wake
endpoint must be authenticated; do not expose an arbitrary or unauthenticated
command endpoint.

## Verify

During an active turn:

```bash
curl --silent --unix-socket /.sprite/api.sock http://sprite/v1/tasks
```

should include `paseo-active-agents`. Within one poll interval after all agents
become idle, the task should disappear.

Check service state with:

```bash
sprite-env services get paseo
```

Logs are written to:

```text
/.sprite/logs/services/paseo.log
```

## Configuration

The service accepts:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PASEO_STARTUP_GRACE_SECONDS` | `600` | Idle time allowed after wake |
| `PASEO_IDLE_GRACE_SECONDS` | `300` | Follow-up time after an active turn |
| `PASEO_POLL_SECONDS` | `15` | Agent-status polling interval |
| `PASEO_NODE_BIN` | discovered | Absolute Node executable |
| `PASEO_CLI_BIN` | discovered | Absolute Paseo CLI entry point |

The controller treats unknown agent states as active. Known terminal states are
`idle`, `archived`, `error`, `failed`, and `stopped`.

## Tested

Tested in a Sprite with:

- Paseo CLI `0.2.3`
- Codex CLI `0.144.3`
- Node.js `24.18.0`

The lifecycle test confirmed:

1. an active Codex turn creates the Sprite task;
2. the task disappears after Codex becomes idle;
3. the Paseo service stops after the configured grace period;
4. the stopped service can be started again and reconnects using the existing
   phone pairing.
