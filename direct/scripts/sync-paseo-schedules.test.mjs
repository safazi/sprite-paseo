#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildScheduleSnapshot } from "./sync-paseo-schedules.mjs";

test("buildScheduleSnapshot sends only active, non-running schedule timestamps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-schedules-"));
    try {
        await writeFile(
            join(directory, "active.json"),
            JSON.stringify({
                id: "active",
                prompt: "must not leave the Sprite",
                status: "active",
                nextRunAt: "2026-08-26T01:02:03.000Z",
                runs: [],
            }),
        );
        await writeFile(
            join(directory, "running.json"),
            JSON.stringify({
                id: "running",
                status: "active",
                nextRunAt: "2026-08-26T01:03:03.000Z",
                runs: [{ status: "running" }],
            }),
        );
        await writeFile(
            join(directory, "paused.json"),
            JSON.stringify({
                id: "paused",
                status: "paused",
                nextRunAt: null,
                runs: [],
            }),
        );

        assert.deepEqual(await buildScheduleSnapshot(directory), [
            { id: "active", nextRunAt: "2026-08-26T01:02:03.000Z" },
        ]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
