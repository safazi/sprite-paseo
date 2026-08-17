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
- registers Paseo as the Sprite HTTP Service on port 8080; and
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
```

The first request may take a couple seconds after a cold wake.

## Idle behavior

This first direct mode intentionally contains no poller and never manually
stops the Paseo service. Sprites can suspend registered Services and restart
them on demand.

An attached Paseo client keeps a WebSocket open and therefore keeps the Sprite
active. Close or background the client when finished. If every client
disconnects during a turn, long silent work is not yet protected from a Sprite
pause; that needs a lifecycle-to-Sprite-Tasks integration. Do not add an
unconditional heartbeat because it would prevent automatic suspension.

The next lifecycle layer should create a short-expiry Sprite Task only while
Paseo reports an agent as `initializing` or `running`, refresh it while work is
active, and delete it for `idle`, `error`, or `closed`.

## Security

- Use a strong, unique Paseo password.
- Keep `~/.paseo` private; it contains daemon and agent state.
- Do not enable the Paseo relay in direct mode.
- Do not expose another service on the Sprite HTTP port.
