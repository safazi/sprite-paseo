import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: {
                configPath: "./wrangler.jsonc",
            },
            miniflare: {
                bindings: {
                    PASEO_SYNC_TOKEN: "test-sync-token-that-is-long-enough",
                },
            },
        }),
    ],
});
