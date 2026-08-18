# Direct mode

Run Paseo and Codex in one Sprite without a separate wake service. Paseo is a
Sprite HTTP Service, so opening its HTTPS URL or reconnecting the Paseo client
wakes the Sprite automatically.

## Install

Inside the target Sprite:

```bash
git clone https://github.com/safazi/sprite-paseo.git
cd sprite-paseo/direct
./install.sh
```

The installer:

- installs the tested Paseo and Codex CLI versions;
- merges direct-mode settings into `~/.paseo/config.json` without deleting
  existing agent state or authentication;
- prompts for a Paseo password if one is not configured;
- disables the Paseo relay;
- enables the bundled web UI;
- binds Paseo to `0.0.0.0:8080`;
- registers Paseo as the Sprite HTTP Service on port 8080;
- holds a short-expiry Sprite task while an agent is actively working; and
- makes the Sprite URL public so native Paseo clients can reach it.

The Sprite URL is public only at the transport layer. Paseo's API and WebSocket
still require the configured password. Static UI assets and `/api/health` are
intentionally unauthenticated.

Override the tested versions when installing a newer combination:

```bash
PASEO_VERSION=0.4.0 CODEX_VERSION=0.144.3 ./install.sh
```

For unattended provisioning, defer both interactive logins and keep the Sprite
URL private:

```bash
DIRECT_DEFER_AUTH=1 ./install.sh
```

Then open a Sprite console and finish authentication:

```bash
paseo daemon set-password
codex login
sprite-env services restart paseo
```

Finally, from an authenticated local shell:

```bash
sprite config update --url-auth public -s <sprite-name>
```

## Connect

Get the endpoint:

```bash
sprite info
```

In Paseo iOS, add a direct host using the Sprite hostname, port `443`, and SSL.
Use the Paseo password configured during installation.

Opening the connection wakes the Sprite. On a warm wake Paseo resumes in
memory; on a cold wake the Sprite runtime restarts the registered service from
the persistent filesystem.

## Verify

```bash
curl --fail https://<sprite-host>.sprites.app/api/health
sprite-env services get paseo
sprite-env curl http://sprite/v1/tasks
```

The first request may take a couple seconds after a cold wake.

## Idle behavior

The service polls Paseo's persisted agent lifecycle every five seconds. If any
agent is `initializing` or `running` and does not require user attention, it
upserts the `paseo-active-agents` Sprite task with a five-minute expiry and
refreshes it every minute. The task is deleted as soon as all agents finish,
fail, close, or hand control back for input.

This keeps silent work such as sleeps, long shell commands, and API calls alive
even when every Paseo client disconnects. The short expiry is deliberate: if
the wrapper crashes, the hold disappears without leaving the Sprite running
forever. The Paseo HTTP Service itself remains registered, so a later inbound
connection wakes the Sprite again.

Tune the lifecycle bridge through the service environment if necessary:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PASEO_POLL_SECONDS` | `5` | Agent-state poll interval |
| `PASEO_TASK_REFRESH_SECONDS` | `60` | Task heartbeat interval |
| `PASEO_TASK_EXPIRE` | `5m` | Safety expiry after the last heartbeat |
| `PASEO_TASK_NAME` | `paseo-active-agents` | Sprite task name |

## Security

- Use a strong, unique Paseo password.
- Keep `~/.paseo` private; it contains daemon and agent state.
- Do not enable the Paseo relay in direct mode.
- Do not expose another service on the Sprite HTTP port.
