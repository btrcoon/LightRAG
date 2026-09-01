import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {guidanceHookResponse} from "./guidance-hook.mjs";

const skillMarkdown = [
    "---",
    "name: clear-human-writing",
    "description: Test skill",
    "---",
    "",
    "# Clear Human Writing",
    "",
    "Answer directly.",
].join("\n");

const enabledConfig = {
    enabled: true,
    wordLimit: 500,
    delegationTimeoutMs: 120_000,
    bridgeProbeTimeoutMs: 1_500,
    firstPassGuidance: true,
    piAutomaticRewrite: true,
};

function response(payload, config = enabledConfig) {
    return guidanceHookResponse(payload, {config, skillMarkdown});
}

describe("shared Claude/Codex guidance hook", () => {
    test("injects the canonical skill for a top-level user prompt", () => {
        const result = response({
            hook_event_name: "UserPromptSubmit",
            prompt: "Explain the change",
            session_id: "session-1",
        });

        assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
        assert.match(
            result.hookSpecificOutput.additionalContext,
            /Answer directly\./,
        );
        assert.doesNotMatch(
            result.hookSpecificOutput.additionalContext,
            /description: Test skill/,
        );
    });

    test("skips exact-output and child prompts", () => {
        assert.equal(
            response({
                hook_event_name: "UserPromptSubmit",
                prompt: "Return only JSON",
            }),
            undefined,
        );
        assert.equal(
            response({
                hook_event_name: "UserPromptSubmit",
                prompt: "Explain the change",
                agent_id: "child-1",
            }),
            undefined,
        );
    });

    test("skips unrelated events and disabled configuration", () => {
        assert.equal(
            response({
                hook_event_name: "Stop",
                last_assistant_message: "A completed answer",
            }),
            undefined,
        );
        assert.equal(
            response(
                {
                    hook_event_name: "UserPromptSubmit",
                    prompt: "Explain the change",
                },
                {...enabledConfig, enabled: false},
            ),
            undefined,
        );
    });
});
