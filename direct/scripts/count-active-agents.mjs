#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const agentsRoot = process.argv[2];

if (!agentsRoot) {
    console.error("usage: count-active-agents.mjs <agents-root>");
    process.exit(2);
}

const activeStatuses = new Set(["initializing", "running"]);
let activeCount = 0;

try {
    for (const workspace of await readdir(agentsRoot, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue;

        const workspacePath = join(agentsRoot, workspace.name);
        for (const entry of await readdir(workspacePath, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

            try {
                const record = JSON.parse(await readFile(join(workspacePath, entry.name), "utf8"));
                if (activeStatuses.has(record.lastStatus) && record.requiresAttention !== true) {
                    activeCount += 1;
                }
            } catch (error) {
                // Paseo writes records atomically. Be conservative if an unexpected
                // unreadable record appears so a transient error cannot suspend work.
                console.error(`Could not inspect ${join(workspacePath, entry.name)}: ${error.message}`);
                activeCount += 1;
            }
        }
    }
} catch (error) {
    if (error?.code !== "ENOENT") {
        console.error(`Could not inspect ${agentsRoot}: ${error.message}`);
        process.exit(1);
    }
}

console.log(activeCount);
