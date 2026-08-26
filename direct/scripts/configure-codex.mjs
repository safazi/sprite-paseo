#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [configPath, providerManifestPath] = process.argv.slice(2);

if (!configPath || !providerManifestPath) {
    console.error("usage: configure-codex.mjs <codex-config-path> <paseo-provider-manifest-path>");
    process.exit(2);
}

const setTopLevelValue = (source, key, value) => {
    const lines = source.split("\n");
    const firstSection = lines.findIndex(line => /^\s*\[/.test(line));
    const limit = firstSection === -1 ? lines.length : firstSection;
    const index = lines.slice(0, limit).findIndex(line => new RegExp(`^\\s*${key}\\s*=`).test(line));
    const setting = `${key} = ${value}`;

    if (index === -1) {
        let insertionIndex = limit;
        while (insertionIndex > 0 && lines[insertionIndex - 1].trim() === "") insertionIndex -= 1;
        lines.splice(insertionIndex, 0, setting);
    } else {
        lines[index] = setting;
    }

    return lines.join("\n");
};

const setSectionValue = (source, section, key, value) => {
    const lines = source.split("\n");
    const sectionHeader = `[${section}]`;
    const sectionIndex = lines.findIndex(line => line.trim() === sectionHeader);
    const setting = `${key} = ${value}`;

    if (sectionIndex === -1) {
        const separator = source.trimEnd() ? [""] : [];
        return [...lines.filter((line, index) => index < lines.length - 1 || line !== ""), ...separator, sectionHeader, setting, ""].join(
            "\n",
        );
    }

    let nextSection = lines.findIndex((line, index) => index > sectionIndex && /^\s*\[/.test(line));
    if (nextSection === -1) nextSection = lines.length;

    const relativeIndex = lines
        .slice(sectionIndex + 1, nextSection)
        .findIndex(line => new RegExp(`^\\s*${key}\\s*=`).test(line));

    if (relativeIndex === -1) {
        lines.splice(nextSection, 0, setting);
    } else {
        lines[sectionIndex + 1 + relativeIndex] = setting;
    }

    return lines.join("\n");
};

let codexConfig = "";

try {
    codexConfig = await readFile(configPath, "utf8");
} catch (error) {
    if (error?.code !== "ENOENT") throw error;
}

codexConfig = setTopLevelValue(codexConfig, "sandbox_mode", '"danger-full-access"');
codexConfig = setTopLevelValue(codexConfig, "approval_policy", '"never"');
codexConfig = setSectionValue(codexConfig, "features", "default_mode_request_user_input", "true");

await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
const temporaryConfigPath = `${configPath}.new`;
await writeFile(temporaryConfigPath, `${codexConfig.trimEnd()}\n`, { mode: 0o600 });
await rename(temporaryConfigPath, configPath);
await chmod(configPath, 0o600);

const providerManifest = await readFile(providerManifestPath, "utf8");
// Paseo 0.4.0 otherwise resolves every new Codex agent to auto-review, which
// sends workspace-write on each app-server turn and overrides config.toml.
const codexProviderPattern = /(id:\s*"codex",[\s\S]*?defaultModeId:\s*)"[^"]+"/u;
const match = providerManifest.match(codexProviderPattern);

if (!match) {
    throw new Error(`Could not locate the Codex default mode in ${providerManifestPath}`);
}

const configuredManifest = providerManifest.replace(codexProviderPattern, '$1"full-access"');
const temporaryManifestPath = `${providerManifestPath}.new`;
await writeFile(temporaryManifestPath, configuredManifest);
await rename(temporaryManifestPath, providerManifestPath);

// Paseo 0.4.0's runtime catalog independently promotes auto-review when the
// installed Codex version supports it. Patch that source of truth as well as
// the static manifest so new agents consistently default to full access.
const providerImplementationPath = resolve(
    dirname(providerManifestPath),
    "../../server/dist/server/server/agent/providers/codex-app-server-agent.js",
);
let providerImplementation = await readFile(providerImplementationPath, "utf8");

const replaceOrVerify = (source, pattern, replacement, verification, label) => {
    if (pattern.test(source)) {
        return source.replace(pattern, replacement);
    }
    if (!verification.test(source)) {
        throw new Error(`Could not locate ${label} in ${providerImplementationPath}`);
    }
    return source;
};

providerImplementation = replaceOrVerify(
    providerImplementation,
    /const DEFAULT_CODEX_MODE_ID = "[^"]+";/u,
    'const DEFAULT_CODEX_MODE_ID = "full-access";',
    /const DEFAULT_CODEX_MODE_ID = "full-access";/u,
    "the Codex runtime default mode",
);
providerImplementation = replaceOrVerify(
    providerImplementation,
    /defaultModeId: autoReviewEnabled \? "auto-review" : DEFAULT_CODEX_MODE_ID,/u,
    "defaultModeId: DEFAULT_CODEX_MODE_ID,",
    /defaultModeId: DEFAULT_CODEX_MODE_ID,/u,
    "the Codex catalog default mode",
);
providerImplementation = replaceOrVerify(
    providerImplementation,
    /async resolveDefaultModeId\(input\) \{\s*return \(await this\.resolveAutoReviewEnabled\(input\.signal\)\)\s*\? "auto-review"\s*: DEFAULT_CODEX_MODE_ID;\s*\}/u,
    "async resolveDefaultModeId(_input) {\n        return DEFAULT_CODEX_MODE_ID;\n    }",
    /async resolveDefaultModeId\(_input\) \{\s*return DEFAULT_CODEX_MODE_ID;\s*\}/u,
    "the Codex runtime mode resolver",
);

const temporaryProviderImplementationPath = `${providerImplementationPath}.new`;
await writeFile(temporaryProviderImplementationPath, providerImplementation);
await rename(temporaryProviderImplementationPath, providerImplementationPath);

console.log("Configured Codex full access without command approvals as Paseo's default mode; interactive user questions remain enabled.");
