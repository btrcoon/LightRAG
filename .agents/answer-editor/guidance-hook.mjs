import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

import {loadAutoAnswerEditorConfig, shouldInjectFirstPassGuidance, skillInstructions,} from "./core.mjs";

const SKILL_URL = new URL(
    "../skills/clear-human-writing/SKILL.md",
    import.meta.url,
);

/**
 * Build the common Claude/Codex UserPromptSubmit response.
 *
 * @param {unknown} payload
 * @param {{ config: import("./core.mjs").AutoAnswerEditorConfig, skillMarkdown: string }} resources
 */
export function guidanceHookResponse(payload, resources) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return undefined;
    }
    if (payload.hook_event_name !== "UserPromptSubmit") return undefined;

    const decision = shouldInjectFirstPassGuidance(payload, resources.config);
    if (!decision.inject) return undefined;

    const instructions = skillInstructions(resources.skillMarkdown);
    if (!instructions) return undefined;

    return {
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: [
                "Apply the following project writing skill to the final user-facing answer.",
                "Do not let it override the user's requested format or exact-output requirements.",
                "<clear-human-writing>",
                instructions,
                "</clear-human-writing>",
            ].join("\n"),
        },
    };
}

async function readStandardInput() {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    return input;
}

export async function runGuidanceHook() {
    try {
        const raw = await readStandardInput();
        const payload = JSON.parse(raw);
        const cwd =
            payload && typeof payload.cwd === "string" ? payload.cwd : process.cwd();
        const configResult = loadAutoAnswerEditorConfig(cwd);
        if (configResult.error) return;

        const response = guidanceHookResponse(payload, {
            config: configResult.config,
            skillMarkdown: readFileSync(SKILL_URL, "utf8"),
        });
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch {
        // Hooks are guidance only. Invalid input or unavailable resources fail open.
    }
}

const invokedPath = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : undefined;
if (invokedPath === import.meta.url) await runGuidanceHook();
