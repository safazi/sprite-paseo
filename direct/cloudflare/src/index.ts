import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { z } from "zod";

const MAX_REQUEST_BYTES = 64 * 1024;
const WAKE_LEAD_MS = 60_000;
const FINAL_WAKE_LEAD_MS = 5_000;
const WAKE_RETRY_MS = 30_000;
const WAKE_GRACE_MS = 120_000;

type WorkerEnv = Env & {
    PASEO_SYNC_TOKEN: string;
};

interface ScheduleInput {
    id: string;
    nextRunAtMs: number;
}

interface EarliestScheduleRow extends Record<string, SqlStorageValue> {
    next_run_at: number | null;
}

interface SettingRow extends Record<string, SqlStorageValue> {
    value: string;
}

const scheduleSchema = z.object({
    id: z.string().min(1).max(128),
    nextRunAt: z.string().datetime({ offset: true }),
});

const syncSchema = z
    .object({
        version: z.literal(1),
        spriteId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62})$/),
        spriteUrl: z.string().url(),
        schedules: z.array(scheduleSchema).max(1_000),
    })
    .superRefine((input, context) => {
        const ids = new Set<string>();
        for (const schedule of input.schedules) {
            if (ids.has(schedule.id)) {
                context.addIssue({
                    code: "custom",
                    message: `Duplicate schedule id: ${schedule.id}`,
                    path: ["schedules"],
                });
            }
            ids.add(schedule.id);
        }
    });

function jsonLog(level: "info" | "error", message: string, data: Record<string, unknown> = {}): void {
    const entry = { level, message, timestamp: new Date().toISOString(), ...data };
    if (level === "error") {
        console.error(JSON.stringify(entry));
    } else {
        console.log(JSON.stringify(entry));
    }
}

async function tokensEqual(provided: string, expected: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const [providedHash, expectedHash] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(provided)),
        crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function normalizeSpriteOrigin(value: string, spriteId: string): string | null {
    const url = new URL(value);
    if (
        url.protocol !== "https:" ||
        url.hostname !== `${spriteId}.sprites.app` ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
    ) {
        return null;
    }
    return url.origin;
}

export function computeNextAlarmAt(now: number, dueAt: number): number | null {
    if (now < dueAt - WAKE_LEAD_MS) return dueAt - WAKE_LEAD_MS;
    if (now < dueAt - FINAL_WAKE_LEAD_MS) return dueAt - FINAL_WAKE_LEAD_MS;
    if (now <= dueAt + WAKE_GRACE_MS) return Math.min(now + WAKE_RETRY_MS, dueAt + WAKE_GRACE_MS);
    return null;
}

export class PaseoScheduler extends DurableObject<WorkerEnv> {
    constructor(ctx: DurableObjectState, env: WorkerEnv) {
        super(ctx, env);
        ctx.blockConcurrencyWhile(async () => {
            this.ctx.storage.sql.exec(`
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS schedules (
                    id TEXT PRIMARY KEY,
                    next_run_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS schedules_next_run_at ON schedules(next_run_at);
            `);
        });
    }

    async replaceSnapshot(
        spriteOrigin: string,
        schedules: ScheduleInput[],
    ): Promise<{
        scheduleCount: number;
        nextRunAt: string | null;
        alarmAt: string | null;
    }> {
        this.ctx.storage.sql.exec(
            "INSERT INTO settings (key, value) VALUES ('sprite_origin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            spriteOrigin,
        );
        this.ctx.storage.sql.exec("DELETE FROM schedules");
        for (const schedule of schedules) {
            this.ctx.storage.sql.exec(
                "INSERT INTO schedules (id, next_run_at) VALUES (?, ?)",
                schedule.id,
                schedule.nextRunAtMs,
            );
        }

        const now = Date.now();
        const alarmAt = await this.scheduleNextAlarm(now);
        const nextRunAt = this.getEarliestScheduleTime();
        return {
            scheduleCount: schedules.length,
            nextRunAt: nextRunAt === null ? null : new Date(nextRunAt).toISOString(),
            alarmAt: alarmAt === null ? null : new Date(alarmAt).toISOString(),
        };
    }

    override async alarm(): Promise<void> {
        const spriteOrigin = this.ctx.storage.sql
            .exec<SettingRow>("SELECT value FROM settings WHERE key = 'sprite_origin'")
            .toArray()[0]?.value;
        const dueAt = this.getEarliestScheduleTime();

        if (!spriteOrigin || dueAt === null) {
            await this.clearAlarm();
            return;
        }

        try {
            const response = await fetch(`${spriteOrigin}/api/health`, {
                method: "GET",
                redirect: "manual",
                headers: {
                    "User-Agent": "paseo-schedule-waker/1",
                },
            });
            jsonLog("info", "Sprite wake request completed", {
                dueAt: new Date(dueAt).toISOString(),
                status: response.status,
            });
        } catch (error) {
            jsonLog("error", "Sprite wake request failed", {
                dueAt: new Date(dueAt).toISOString(),
                error: error instanceof Error ? error.message : String(error),
            });
        }

        await this.scheduleNextAlarm(Date.now());
    }

    private getEarliestScheduleTime(): number | null {
        return this.ctx.storage.sql
            .exec<EarliestScheduleRow>("SELECT MIN(next_run_at) AS next_run_at FROM schedules")
            .one().next_run_at;
    }

    private async scheduleNextAlarm(now: number): Promise<number | null> {
        this.ctx.storage.sql.exec("DELETE FROM schedules WHERE next_run_at < ?", now - WAKE_GRACE_MS);
        const dueAt = this.getEarliestScheduleTime();
        const alarmAt = dueAt === null ? null : computeNextAlarmAt(now, dueAt);

        if (alarmAt === null) {
            await this.clearAlarm();
            return null;
        }

        const currentAlarm = await this.ctx.storage.getAlarm();
        if (currentAlarm !== alarmAt) {
            await this.ctx.storage.setAlarm(alarmAt);
        }
        return alarmAt;
    }

    private async clearAlarm(): Promise<void> {
        if ((await this.ctx.storage.getAlarm()) !== null) {
            await this.ctx.storage.deleteAlarm();
        }
    }
}

const app = new Hono<{ Bindings: WorkerEnv }>();

app.get("/health", c => c.json({ ok: true }));

app.use("/v1/*", async (c, next) => {
    const expected = c.env.PASEO_SYNC_TOKEN;
    if (!expected) {
        return c.json({ error: "Sync authentication is not configured" }, 503);
    }

    const authorization = c.req.header("Authorization") ?? "";
    const provided = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    if (!provided || !(await tokensEqual(provided, expected))) {
        return c.json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    }

    return next();
});

app.post("/v1/sync", async c => {
    const contentLength = Number(c.req.header("Content-Length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
        return c.json({ error: "Request body too large" }, 413);
    }

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = syncSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ error: "Invalid sync payload", issues: parsed.error.issues }, 400);
    }

    const spriteOrigin = normalizeSpriteOrigin(parsed.data.spriteUrl, parsed.data.spriteId);
    if (!spriteOrigin) {
        return c.json({ error: "spriteUrl must be an HTTPS sprites.app origin" }, 400);
    }

    const schedules = parsed.data.schedules.map(schedule => ({
        id: schedule.id,
        nextRunAtMs: new Date(schedule.nextRunAt).getTime(),
    }));
    const scheduler = c.env.PASEO_SCHEDULERS.getByName(parsed.data.spriteId);
    const result = await scheduler.replaceSnapshot(spriteOrigin, schedules);
    return c.json(result);
});

app.notFound(c => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
    jsonLog("error", "Unhandled request error", {
        error: error.message,
        method: c.req.method,
        path: c.req.path,
    });
    return c.json({ error: "Internal server error" }, 500);
});

export type AppType = typeof app;
export default app;
