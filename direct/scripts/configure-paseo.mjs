#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [configPath, spriteUrl] = process.argv.slice(2);

if (!configPath || !spriteUrl) {
    console.error("usage: configure-paseo.mjs <config-path> <sprite-url>");
    process.exit(2);
}

const origin = new URL(spriteUrl).origin;
const hostname = new URL(spriteUrl).hostname;
const asArray = value => (Array.isArray(value) ? value : []);

let config = {};

try {
    config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
    if (error?.code !== "ENOENT") throw error;
}

config.version ??= 1;
config.daemon ??= {};
config.daemon.listen = "0.0.0.0:8080";
config.daemon.hostnames = [...new Set([...asArray(config.daemon.hostnames), hostname])];
config.daemon.cors ??= {};
config.daemon.cors.allowedOrigins = [
    ...new Set([...asArray(config.daemon.cors.allowedOrigins), origin, "https://app.paseo.sh"]),
];
config.daemon.relay = { ...(config.daemon.relay ?? {}), enabled: false };
if (Array.isArray(config.daemon.agentProfiles)) {
    config.daemon.agentProfiles = config.daemon.agentProfiles.filter(
        profile => profile?.id !== "codex-full-access-interactive",
    );
    if (config.daemon.agentProfiles.length === 0) delete config.daemon.agentProfiles;
}
config.features ??= {};
config.features.webUi = { ...(config.features.webUi ?? {}), enabled: false };
config.features.dictation ??= { enabled: false };
config.features.voiceMode ??= { enabled: false };

await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
const temporaryPath = `${configPath}.new`;
await writeFile(temporaryPath, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
await rename(temporaryPath, configPath);
await chmod(configPath, 0o600);
