# sprite-paseo

Run Codex in a Sprite and control it from Paseo without a relay or separate wake
service. Paseo runs as the Sprite HTTP service, so opening the Sprite HTTPS URL
wakes the Sprite automatically.

The repository is also a reusable Codex skill. Its instructions and bundled
installer live in [`direct/`](direct/SKILL.md).

## Install on a Sprite

Clone the repository inside the target Sprite and run the direct installer:

```bash
git clone https://github.com/safazi/sprite-paseo.git
cd sprite-paseo
./install.sh
```

The root installer delegates to `direct/scripts/install.sh`. It:

- installs the tested Paseo and Codex CLI versions;
- preserves existing Paseo state and authentication;
- merges the direct-mode Paseo configuration;
- disables the Paseo relay and enables the web UI;
- binds Paseo to `0.0.0.0:8080`;
- registers Paseo as the Sprite HTTP service;
- keeps the Sprite awake only while an agent is actively working; and
- makes the Sprite URL public after a Paseo password is configured.

The installer replaces an existing Sprite service named `paseo`, while
preserving `~/.paseo`.

Override the tested versions when needed:

```bash
PASEO_VERSION=0.4.0 CODEX_VERSION=0.144.3 ./install.sh
```

## Use as a Codex skill

Copy or link `direct/` into a Codex skills directory under the name `direct`,
then restart Codex so it discovers the skill. Invoke it with `$direct` when
setting up, verifying, or repairing a Paseo Sprite.

A Codex agent can also load [`direct/SKILL.md`](direct/SKILL.md) directly from
a clone of this repository.

## Deferred authentication

For unattended provisioning, defer the interactive Paseo and Codex logins and
leave the Sprite URL private:

```bash
DIRECT_DEFER_AUTH=1 ./install.sh
```

Finish setup from an interactive Sprite console:

```bash
paseo daemon set-password
codex login
sprite-env services restart paseo
```

Then make the endpoint reachable from an authenticated local shell:

```bash
sprite config update --url-auth public -s <sprite-name>
```

## Connect Paseo

Get the Sprite endpoint:

```bash
sprite-env info
```

In Paseo, add a direct host using the Sprite hostname, port `443`, and SSL.
Use the Paseo password configured during installation.

Opening this connection wakes the Sprite. A warm wake resumes Paseo in memory;
a cold wake restarts the registered service from the persistent filesystem.

## Verify

```bash
curl --fail https://<sprite-host>.sprites.app/api/health
sprite-env services get paseo
sprite-env curl http://sprite/v1/tasks
```

The first HTTPS request may take a few seconds after a cold wake. Service logs
are available at `/.sprite/logs/services/paseo.log`.

## Lifecycle behavior

The service checks Paseo's persisted agent state every five seconds. While an
agent is `initializing` or `running` and does not require user attention, it
refreshes a short-expiry Sprite task named `paseo-active-agents`. It deletes
the task when work completes or control returns to the user.

This keeps unattended work alive when Paseo clients disconnect. The five-minute
task expiry prevents a crashed wrapper from keeping the Sprite awake forever.
The registered HTTP service remains available for later wake-on-request.

The service environment supports:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PASEO_POLL_SECONDS` | `5` | Agent-state poll interval |
| `PASEO_TASK_REFRESH_SECONDS` | `60` | Task heartbeat interval |
| `PASEO_TASK_EXPIRE` | `5m` | Safety expiry after the last heartbeat |
| `PASEO_TASK_NAME` | `paseo-active-agents` | Sprite task name |

## Security

The Sprite URL is public at the transport layer so native Paseo clients can
connect. Paseo's API and WebSocket remain password-protected. Static web UI
assets and `/api/health` are intentionally unauthenticated.

- Use a strong, unique Paseo password.
- Keep `~/.paseo` private; it contains authentication and agent state.
- Do not enable the Paseo relay in direct mode.
- Do not expose another service on the Sprite HTTP port.
