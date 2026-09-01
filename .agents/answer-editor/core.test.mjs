import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, test} from "node:test";

import {
    countProseWords,
    isMachineOnlyJson,
    loadAutoAnswerEditorConfig,
    missingProtectedArtifacts,
    promptRequiresExactOutput,
    replaceSingleTextContent,
    shouldInjectFirstPassGuidance,
    shouldRewriteAnswer,
    singleTextContent,
    skillInstructions,
} from "./core.mjs";

const enabledConfig = {
    enabled: true,
    wordLimit: 2,
    delegationTimeoutMs: 100,
    bridgeProbeTimeoutMs: 20,
    firstPassGuidance: true,
    piAutomaticRewrite: true,
};

function assistant(content, stopReason = "stop") {
    return {role: "assistant", content, stopReason};
}

describe("configuration", () => {
    test("loads the canonical config from an ancestor directory", () => {
        const root = mkdtempSync(join(tmpdir(), "answer-editor-config-"));
        try {
            const configDirectory = join(root, ".agents", "answer-editor");
            const nested = join(root, "src", "nested");
            mkdirSync(configDirectory, {recursive: true});
            mkdirSync(nested, {recursive: true});
            writeFileSync(
                join(configDirectory, "config.json"),
                JSON.stringify(enabledConfig),
            );

            assert.deepEqual(loadAutoAnswerEditorConfig(nested), {
                config: enabledConfig,
            });
        } finally {
            rmSync(root, {recursive: true, force: true});
        }
    });

    test("fails closed for an invalid or unavailable config", () => {
        const result = loadAutoAnswerEditorConfig(
            join(tmpdir(), "missing-answer-editor-project"),
        );
        assert.equal(result.config.enabled, false);
        assert.match(result.error, /Invalid \.agents\/answer-editor\/config\.json/);
    });
});

describe("prose counting and eligibility", () => {
    test("counts Unicode words and excludes code", () => {
        const markdown = [
            "Zażółć gęślą jaźń.",
            "",
            "```ts",
            'const ignored = "many code words are not prose"',
            "```",
            "",
            "Final words.",
        ].join("\n");

        assert.equal(countProseWords(markdown), 5);
    });

    test("accepts a completed long prose answer", () => {
        assert.deepEqual(
            shouldRewriteAnswer({
                message: assistant("one two three"),
                prompt: "Explain this",
                config: enabledConfig,
                isChild: false,
            }),
            {
                rewrite: true,
                reason: "eligible",
                text: "one two three",
                wordCount: 3,
            },
        );
    });

    test("skips disabled, child, incomplete, mixed, exact, and JSON answers", () => {
        assert.equal(
            shouldRewriteAnswer({
                message: assistant("one two three"),
                prompt: "Explain this",
                config: {...enabledConfig, enabled: false},
                isChild: false,
            }).reason,
            "disabled",
        );
        assert.equal(
            shouldRewriteAnswer({
                message: assistant("one two three"),
                prompt: "Explain this",
                config: enabledConfig,
                isChild: true,
            }).reason,
            "child",
        );
        assert.equal(
            shouldRewriteAnswer({
                message: assistant("one two three", "length"),
                prompt: "Explain this",
                config: enabledConfig,
                isChild: false,
            }).reason,
            "not-complete",
        );
        assert.equal(
            shouldRewriteAnswer({
                message: assistant([
                    {type: "thinking", text: "hidden"},
                    {type: "text", text: "one two three"},
                ]),
                prompt: "Explain this",
                config: enabledConfig,
                isChild: false,
            }).reason,
            "mixed-content",
        );
        assert.equal(
            shouldRewriteAnswer({
                message: assistant("one two three"),
                prompt: "Return only the final value",
                config: enabledConfig,
                isChild: false,
            }).reason,
            "exact-output",
        );
        assert.equal(
            shouldRewriteAnswer({
                message: assistant('{"result":"one two three"}'),
                prompt: "Return data",
                config: enabledConfig,
                isChild: false,
            }).reason,
            "machine-json",
        );
    });

    test("recognizes exact-output prompts and machine JSON", () => {
        assert.equal(
            promptRequiresExactOutput("Respond exactly with the schema"),
            true,
        );
        assert.equal(promptRequiresExactOutput("Return JSON only"), true);
        assert.equal(
            promptRequiresExactOutput("Return valid JSON matching this schema"),
            true,
        );
        assert.equal(isMachineOnlyJson("[1, 2, 3]"), true);
        assert.equal(isMachineOnlyJson("Result: [1, 2, 3]"), false);
    });
});

describe("content and artifact preservation", () => {
    test("replaces only single text content", () => {
        assert.equal(singleTextContent([{type: "text", text: "draft"}]), "draft");
        assert.deepEqual(
            replaceSingleTextContent(
                [{type: "text", text: "draft", extra: 1}],
                "final",
            ),
            [{type: "text", text: "final", extra: 1}],
        );
        assert.equal(
            replaceSingleTextContent(
                [
                    {type: "text", text: "first"},
                    {type: "text", text: "second"},
                ],
                "final",
            ),
            undefined,
        );
    });

    test("detects changed protected artifacts", () => {
        const draft = [
            "Run `node --test .agents/answer-editor/core.test.mjs`.",
            "See lightrag/pipeline.py:42 and https://example.com/docs.",
            "",
            "```bash",
            "./scripts/test.sh tests/pipeline",
            "```",
        ].join("\n");

        assert.deepEqual(
            missingProtectedArtifacts(draft, `Short intro.\n\n${draft}`),
            [],
        );
        assert.ok(
            missingProtectedArtifacts(
                draft,
                draft.replace("lightrag/pipeline.py:42", "lightrag/pipeline.py:43"),
            ).includes("lightrag/pipeline.py:42"),
        );
    });
});

describe("first-pass guidance", () => {
    test("injects only for eligible top-level prompts", () => {
        assert.equal(
            shouldInjectFirstPassGuidance({prompt: "Explain this"}, enabledConfig)
                .inject,
            true,
        );
        assert.equal(
            shouldInjectFirstPassGuidance(
                {prompt: "Return only JSON"},
                enabledConfig,
            ).reason,
            "exact-output",
        );
        assert.equal(
            shouldInjectFirstPassGuidance(
                {prompt: "Explain this", agent_id: "child-1"},
                enabledConfig,
            ).reason,
            "child",
        );
    });

    test("strips skill frontmatter before injection", () => {
        assert.equal(
            skillInstructions(
                "---\nname: sample\ndescription: test\n---\n\n# Rules\nBe clear.",
            ),
            "# Rules\nBe clear.",
        );
    });
});
