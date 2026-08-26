import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeNextAlarmAt, type PaseoScheduler } from "../src/index";

declare module "cloudflare:workers" {
    interface ProvidedEnv extends Env {
        PASEO_SYNC_TOKEN: string;
    }
}

const token = "test-sync-token-that-is-long-enough";

function syncRequest(body: unknown, authorization = `Bearer ${token}`): Request {
    return new Request("https://worker.example/v1/sync", {
        method: "POST",
        headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

function validPayload(nextRunAt: string) {
    return {
        version: 1,
        spriteId: "paseo-example",
        spriteUrl: "https://paseo-example.sprites.app",
        schedules: [{ id: "schedule-one", nextRunAt }],
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("schedule sync API", () => {
    it("rejects unauthenticated sync requests", async () => {
        const response = await exports.default.fetch(syncRequest(validPayload(new Date().toISOString()), ""));
        expect(response.status).toBe(401);
    });

    it("stores the snapshot and schedules the pre-wake alarm", async () => {
        const dueAt = Date.now() + 10 * 60_000;
        const response = await exports.default.fetch(syncRequest(validPayload(new Date(dueAt).toISOString())));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            scheduleCount: 1,
            nextRunAt: new Date(dueAt).toISOString(),
            alarmAt: new Date(dueAt - 60_000).toISOString(),
        });

        const stub = env.PASEO_SCHEDULERS.getByName("paseo-example");
        await runInDurableObject(stub, async (_instance: PaseoScheduler, state) => {
            expect(await state.storage.getAlarm()).toBe(dueAt - 60_000);
            expect(state.storage.sql.exec("SELECT id FROM schedules").toArray()).toEqual([{ id: "schedule-one" }]);
        });
    });

    it("wakes the Sprite through the unauthenticated health endpoint", async () => {
        const dueAt = Date.now() + 30_000;
        const response = await exports.default.fetch(syncRequest(validPayload(new Date(dueAt).toISOString())));
        expect(response.status).toBe(200);

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
        const stub = env.PASEO_SCHEDULERS.getByName("paseo-example");
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        expect(fetchSpy).toHaveBeenCalledWith(
            "https://paseo-example.sprites.app/api/health",
            expect.objectContaining({ method: "GET", redirect: "manual" }),
        );
    });
});

describe("alarm timing", () => {
    it("uses an early wake, final nudge, and bounded post-due retries", () => {
        const dueAt = 1_000_000;
        expect(computeNextAlarmAt(dueAt - 120_000, dueAt)).toBe(dueAt - 60_000);
        expect(computeNextAlarmAt(dueAt - 30_000, dueAt)).toBe(dueAt - 5_000);
        expect(computeNextAlarmAt(dueAt - 1_000, dueAt)).toBe(dueAt + 29_000);
        expect(computeNextAlarmAt(dueAt + 121_000, dueAt)).toBeNull();
    });
});
