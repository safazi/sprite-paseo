#!/usr/bin/env node

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const configPath = process.argv[2];
const workerUrlInput = process.env.PASEO_ALARM_WORKER_URL?.trim();
const token = process.env.PASEO_ALARM_SYNC_TOKEN?.trim();

if (!configPath || !workerUrlInput || !token) {
    console.error("usage: PASEO_ALARM_WORKER_URL=<url> PASEO_ALARM_SYNC_TOKEN=<token> write-cloudflare-alarm-config.mjs <path>");
    process.exit(2);
}

const workerUrl = new URL(workerUrlInput);
if (workerUrl.protocol !== "https:" || workerUrl.username || workerUrl.password) {
    throw new Error("The Cloudflare Worker URL must use HTTPS and must not contain credentials");
}
if (token.length < 32) {
    throw new Error("The shared sync token must contain at least 32 characters");
}

const config = {
    version: 1,
    workerUrl: workerUrl.origin,
    token,
};

await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
const temporaryPath = `${configPath}.new`;
await writeFile(temporaryPath, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
await rename(temporaryPath, configPath);
await chmod(configPath, 0o600);
