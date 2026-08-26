#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, watch } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const configPath = process.argv[2] ?? "/home/sprite/.paseo/cloudflare-alarm.json";
const paseoHome = process.env.PASEO_HOME ?? "/home/sprite/.paseo";
const schedulesDir = join(paseoHome, "schedules");
const spriteSocket = "/.sprite/api.sock";
const taskName = process.env.PASEO_SCHEDULE_TASK_NAME ?? "paseo-schedule-wake";
const taskUrl = `http://sprite/v1/tasks/${taskName}`;
const holdWindowMs = Number(process.env.PASEO_SCHEDULE_HOLD_WINDOW_MS ?? "90000");
const holdGraceMs = Number(process.env.PASEO_SCHEDULE_HOLD_GRACE_MS ?? "120000");
const maxRetryAttempts = Number(process.env.PASEO_ALARM_SYNC_MAX_RETRIES ?? "5");

let taskPresent = false;

function log(level, message, data = {}) {
    const entry = { level, message, timestamp: new Date().toISOString(), ...data };
    const output = `${JSON.stringify(entry)}\n`;
    if (level === "error") process.stderr.write(output);
    else process.stdout.write(output);
}

function parseAlarmConfig(value) {
    if (!value || value.version !== 1 || typeof value.workerUrl !== "string" || typeof value.token !== "string") {
        throw new Error("Cloudflare alarm config must contain version, workerUrl, and token");
    }
    const workerUrl = new URL(value.workerUrl);
    if (workerUrl.protocol !== "https:" || workerUrl.username || workerUrl.password) {
        throw new Error("Cloudflare alarm workerUrl must be an HTTPS origin without credentials");
    }
    if (value.token.length < 32) {
        throw new Error("Cloudflare alarm token must contain at least 32 characters");
    }
    return { workerUrl: workerUrl.origin, token: value.token };
}

export async function buildScheduleSnapshot(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const schedules = [];

    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
            const schedule = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
            const hasRunningRun = Array.isArray(schedule.runs) && schedule.runs.some(run => run?.status === "running");
            const nextRunAtMs = typeof schedule.nextRunAt === "string" ? Date.parse(schedule.nextRunAt) : Number.NaN;
            if (
                schedule.status === "active" &&
                typeof schedule.id === "string" &&
                schedule.id.length > 0 &&
                schedule.id.length <= 128 &&
                Number.isFinite(nextRunAtMs) &&
                !hasRunningRun
            ) {
                schedules.push({ id: schedule.id, nextRunAt: new Date(nextRunAtMs).toISOString() });
            }
        } catch (error) {
            log("error", "Could not inspect Paseo schedule", {
                file: basename(entry.name),
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return schedules.sort((left, right) => left.id.localeCompare(right.id));
}

async function getSpriteInfo() {
    const { stdout } = await execFileAsync("sprite-env", ["info"], { encoding: "utf8", maxBuffer: 64 * 1024 });
    const info = JSON.parse(stdout);
    const spriteUrl = new URL(info.sprite_url);
    return {
        spriteId: spriteUrl.hostname.split(".")[0],
        spriteUrl: spriteUrl.origin,
    };
}

async function putScheduleTask() {
    await execFileAsync("curl", [
        "--silent",
        "--show-error",
        "--fail",
        "--unix-socket",
        spriteSocket,
        "--request",
        "PUT",
        "--header",
        "Content-Type: application/json",
        "--data",
        '{"expire":"3m"}',
        taskUrl,
    ]);
    if (!taskPresent) log("info", "Holding Sprite awake for an imminent Paseo schedule", { taskName });
    taskPresent = true;
}

async function deleteScheduleTask(force = false) {
    if (!force && !taskPresent) return;
    await execFileAsync("curl", [
        "--silent",
        "--unix-socket",
        spriteSocket,
        "--request",
        "DELETE",
        taskUrl,
    ]).catch(() => undefined);
    taskPresent = false;
    log("info", "Released imminent Paseo schedule hold", { taskName });
}

async function reconcileScheduleTask(schedules) {
    const now = Date.now();
    const imminent = schedules.some(schedule => {
        const nextRunAt = Date.parse(schedule.nextRunAt);
        return nextRunAt >= now - holdGraceMs && nextRunAt <= now + holdWindowMs;
    });
    if (imminent) await putScheduleTask();
    else await deleteScheduleTask();
}

async function postSnapshot(config, sprite, schedules) {
    const response = await fetch(new URL("/v1/sync", config.workerUrl), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, ...sprite, schedules }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
        throw new Error(`Cloudflare alarm sync returned HTTP ${response.status}`);
    }
}

async function main() {
    const config = parseAlarmConfig(JSON.parse(await readFile(configPath, "utf8")));
    const sprite = await getSpriteInfo();
    await mkdir(schedulesDir, { recursive: true, mode: 0o700 });
    await deleteScheduleTask(true);

    let lastSyncedSnapshot = null;
    let retryAttempts = 0;
    let retryTimer = null;
    let debounceTimer = null;
    let reconciling = false;
    let reconcileAgain = false;

    const reconcile = async () => {
        if (reconciling) {
            reconcileAgain = true;
            return;
        }
        reconciling = true;
        try {
            const schedules = await buildScheduleSnapshot(schedulesDir);
            await reconcileScheduleTask(schedules);
            const serialized = JSON.stringify(schedules);
            if (serialized === lastSyncedSnapshot) return;

            try {
                await postSnapshot(config, sprite, schedules);
                lastSyncedSnapshot = serialized;
                retryAttempts = 0;
                log("info", "Synchronized Paseo schedules with Cloudflare alarms", {
                    scheduleCount: schedules.length,
                });
            } catch (error) {
                retryAttempts += 1;
                log("error", "Could not synchronize Paseo schedules with Cloudflare alarms", {
                    attempt: retryAttempts,
                    error: error instanceof Error ? error.message : String(error),
                });
                if (retryAttempts <= maxRetryAttempts && retryTimer === null) {
                    const delayMs = Math.min(2 ** (retryAttempts - 1) * 1_000, 30_000);
                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        void reconcile();
                    }, delayMs);
                }
            }
        } finally {
            reconciling = false;
            if (reconcileAgain) {
                reconcileAgain = false;
                void reconcile();
            }
        }
    };

    const queueReconcile = () => {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            retryAttempts = 0;
            void reconcile();
        }, 250);
    };

    const shutdown = async signal => {
        if (retryTimer !== null) clearTimeout(retryTimer);
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        await deleteScheduleTask();
        log("info", "Stopped Paseo schedule synchronization", { signal });
        process.exit(0);
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGHUP", () => void shutdown("SIGHUP"));

    await reconcile();
    for await (const _event of watch(schedulesDir)) queueReconcile();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => {
        log("error", "Paseo schedule synchronizer stopped", {
            error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
    });
}
