# sprite-paseo

Run Codex in a Sprite and control it directly from Paseo without enabling the
relay. Paseo runs as the Sprite HTTP service, so opening the Sprite HTTPS URL
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
- configures Codex full access without command approvals as Paseo's default mode;
- keeps Codex interactive user questions enabled;
- disables the Paseo relay and bundled web UI;
- binds Paseo to `0.0.0.0:8080`;
- registers Paseo as the Sprite HTTP service;
- keeps the Sprite awake only while an agent is actively working;
- installs dormant support for optional scheduled wake-ups; and
- prints the host-side command required to make the Sprite URL public.

The installer replaces an existing Sprite service named `paseo`, while
preserving `~/.paseo`.

Cloudflare is not required for the normal direct-mode installation. Unless
`~/.paseo/cloudflare-alarm.json` exists, the service does not start the schedule
synchronizer or send schedule data anywhere.

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

## User authentication checkpoint

The installer never performs the interactive Paseo password flow. If no password
is configured, leave the Sprite URL private. The user must open an interactive
Sprite terminal and run:

```bash
paseo daemon set-password
```

The user should then tell the installing agent that the password is set; `done`
is sufficient. The agent can then restart the managed service, publish the URL
from the host, and verify that protected endpoints reject unauthenticated
requests. Run `codex login` yourself as well when Codex is not already
authenticated.

## Publish the Sprite URL

The installer cannot publish the URL from inside the Sprite. Run this **outside the Sprite**, in a terminal on your computer where the `sprite` CLI is authenticated to the organization that owns the Sprite:

```bash
sprite config update --url-auth public -s <sprite-name>
```

Do not run this through `sprite exec` or from a Sprite console. Do not publish
until the user has completed the password checkpoint.

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
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://<sprite-host>.sprites.app/)" = 404
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://<sprite-host>.sprites.app/api/config)" = 401
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

## Wake for scheduled tasks with Cloudflare alarms

This is an opt-in extension for users who want Paseo schedules to run after the
Sprite has shut down. Skip this entire section when scheduled wake-ups are not
needed; ordinary interactive and unattended agent turns do not require it.

Direct mode can optionally deploy the Worker in [`direct/cloudflare/`](direct/cloudflare/). The Sprite helper watches
Paseo's schedule files and sends only active schedule IDs and next-run timestamps to a Durable Object. It does not send
schedule prompts, workspaces, agent configuration, Paseo credentials, or Codex credentials.

The Durable Object wakes the Sprite through its public `/api/health` endpoint one minute before the next run, nudges it
again five seconds before the run, and uses bounded retries through two minutes after the due time. Once awake, the
Sprite creates a three-minute local task so it cannot become idle again before Paseo starts the scheduled agent. Paseo's
normal active-agent hold takes over after the run starts.

This integration is event-driven: after its initial snapshot, the Sprite helper sends a request only when Paseo changes a
schedule file. It does not keep the Sprite awake with a heartbeat.

### Authentication checkpoints

Cloudflare setup must run from a clone on your computer, not from inside the Sprite. First install dependencies and log in:

```bash
cd direct/cloudflare
bun install
bunx wrangler login
```

Tell the installing agent when Wrangler login is complete. The agent may verify `bunx wrangler whoami`, deploy with
`bun run deploy`, and give you the resulting Worker URL. You must then create a unique shared token of at least 32
characters and enter it yourself in both interactive prompts:

```bash
# On your computer, from direct/cloudflare:
bunx wrangler secret put PASEO_SYNC_TOKEN

# In an interactive terminal inside the Sprite:
/home/sprite/bin/configure-cloudflare-alarm
```

Enter the deployed Worker URL at the second prompt, then enter the same token. Tell the agent `done`; it can restart the
managed `paseo` service and verify synchronization without reading the token. Do not put Cloudflare API credentials in the
Sprite. The Sprite stores only the Worker URL and shared token in `~/.paseo/cloudflare-alarm.json` with mode `0600`.

To disable scheduled waking, remove `~/.paseo/cloudflare-alarm.json` and restart
the managed Paseo service. The base Paseo setup continues working normally.
Deleting the Worker is a separate, host-side Cloudflare operation.

The service environment supports:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PASEO_POLL_SECONDS` | `5` | Agent-state poll interval |
| `PASEO_TASK_REFRESH_SECONDS` | `60` | Task heartbeat interval |
| `PASEO_TASK_EXPIRE` | `5m` | Safety expiry after the last heartbeat |
| `PASEO_TASK_NAME` | `paseo-active-agents` | Sprite task name |
| `PASEO_SCHEDULE_TASK_NAME` | `paseo-schedule-wake` | Short hold around an imminent scheduled run |

## Security

The Sprite URL is public at the transport layer so native Paseo clients can
connect. Paseo's API and WebSocket remain password-protected. The bundled web
UI is disabled; `/api/health` remains intentionally unauthenticated.

- Use a strong, unique Paseo password.
- Keep `~/.paseo` private; it contains authentication and agent state.
- Use a unique Cloudflare sync token and never commit `cloudflare-alarm.json` or `.dev.vars`.
- Do not enable the Paseo relay in direct mode.
- Do not expose another service on the Sprite HTTP port.
