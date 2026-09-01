import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";

/**
 * @typedef {object} AutoAnswerEditorConfig
 * @property {boolean} enabled
 * @property {number} wordLimit
 * @property {number} delegationTimeoutMs
 * @property {number} bridgeProbeTimeoutMs
 * @property {boolean} firstPassGuidance
 * @property {boolean} piAutomaticRewrite
 */

/**
 * @typedef {object} AgentMessage
 * @property {string} role
 * @property {unknown} [content]
 * @property {string} [stopReason]
 */

/** @type {AutoAnswerEditorConfig} */
export const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    wordLimit: 500,
    delegationTimeoutMs: 120_000,
    bridgeProbeTimeoutMs: 1_500,
    firstPassGuidance: true,
    piAutomaticRewrite: true,
});

export const CONFIG_RELATIVE_PATH = ".agents/answer-editor/config.json";

export const PRESERVATION_CONTRACT = Object.freeze([
    "Keep every fact and detail requested by the original prompt.",
    "Preserve fenced and inline code exactly.",
    "Preserve commands, paths, path:line references, URLs, citations, schemas, and machine-readable blocks exactly.",
    "Preserve test evidence, warnings, residual risks, required literals, and repository-defined contracts.",
    "Do not add unsupported claims.",
]);

/** @param {unknown} value */
function positiveInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @param {string} cwd */
function findConfigPath(cwd) {
    let directory = resolve(cwd);
    while (true) {
        const candidate = join(directory, CONFIG_RELATIVE_PATH);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(directory);
        if (parent === directory) return join(resolve(cwd), CONFIG_RELATIVE_PATH);
        directory = parent;
    }
}

/**
 * @param {string} cwd
 * @returns {{ config: AutoAnswerEditorConfig, error?: string }}
 */
export function loadAutoAnswerEditorConfig(cwd) {
    const path = findConfigPath(cwd);
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("configuration must be a JSON object");
        }
        if (typeof parsed.enabled !== "boolean") {
            throw new Error("enabled must be a boolean");
        }
        if (!positiveInteger(parsed.wordLimit)) {
            throw new Error("wordLimit must be a positive integer");
        }
        if (!positiveInteger(parsed.delegationTimeoutMs)) {
            throw new Error("delegationTimeoutMs must be a positive integer");
        }
        if (!positiveInteger(parsed.bridgeProbeTimeoutMs)) {
            throw new Error("bridgeProbeTimeoutMs must be a positive integer");
        }
        if (typeof parsed.firstPassGuidance !== "boolean") {
            throw new Error("firstPassGuidance must be a boolean");
        }
        if (typeof parsed.piAutomaticRewrite !== "boolean") {
            throw new Error("piAutomaticRewrite must be a boolean");
        }
        return {
            config: {
                enabled: parsed.enabled,
                wordLimit: parsed.wordLimit,
                delegationTimeoutMs: parsed.delegationTimeoutMs,
                bridgeProbeTimeoutMs: parsed.bridgeProbeTimeoutMs,
                firstPassGuidance: parsed.firstPassGuidance,
                piAutomaticRewrite: parsed.piAutomaticRewrite,
            },
        };
    } catch (error) {
        return {
            config: {...DEFAULT_CONFIG, enabled: false},
            error: `Invalid ${CONFIG_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/** @param {unknown} content */
export function textFromContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    const text = [];
    for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
            text.push(block.text);
        }
    }
    return text.join("\n");
}

/** @param {unknown} content */
export function singleTextContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content) || content.length !== 1) return undefined;
    const block = content[0];
    if (!block || typeof block !== "object") return undefined;
    return block.type === "text" && typeof block.text === "string"
        ? block.text
        : undefined;
}

/**
 * @param {unknown} content
 * @param {string} rewritten
 * @returns {string | Array<Record<string, unknown>> | undefined}
 */
export function replaceSingleTextContent(content, rewritten) {
    if (typeof content === "string") return rewritten;
    if (!Array.isArray(content) || content.length !== 1) return undefined;
    const block = content[0];
    if (!block || typeof block !== "object") return undefined;
    return [{...block, text: rewritten}];
}

/**
 * @param {string} line
 * @param {{ character: "`" | "~", length: number }} fence
 */
function closesFence(line, fence) {
    let offset = 0;
    while (offset < 4 && line[offset] === " ") offset += 1;
    if (offset > 3 || line[offset] !== fence.character) return false;

    let runLength = 0;
    while (line[offset + runLength] === fence.character) runLength += 1;
    return (
        runLength >= fence.length &&
        line.slice(offset + runLength).trim().length === 0
    );
}

/** @param {string} markdown */
function stripFencedCode(markdown) {
    const kept = [];
    /** @type {{ character: "`" | "~", length: number } | undefined} */
    let fence;

    for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
        if (!fence) {
            const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
            if (!opening) {
                kept.push(line);
                continue;
            }
            fence = {character: opening[1][0], length: opening[1].length};
            continue;
        }
        if (closesFence(line, fence)) fence = undefined;
    }

    return kept.join("\n");
}

/** @param {string} markdown */
function stripIndentedCode(markdown) {
    const kept = [];
    let previousLineWasBlank = true;
    let inCodeBlock = false;

    for (const line of markdown.split("\n")) {
        const blank = line.trim().length === 0;
        const indented = /^(?:\t| {4})/.test(line);

        if (inCodeBlock) {
            if (blank || indented) {
                previousLineWasBlank = blank;
                continue;
            }
            inCodeBlock = false;
        }

        if (indented && previousLineWasBlank) {
            inCodeBlock = true;
            previousLineWasBlank = false;
            continue;
        }

        kept.push(line);
        previousLineWasBlank = blank;
    }

    return kept.join("\n");
}

/** @param {string} markdown */
function stripInlineCode(markdown) {
    let result = "";

    for (let index = 0; index < markdown.length;) {
        if (markdown[index] !== "`") {
            result += markdown[index];
            index += 1;
            continue;
        }

        let runLength = 1;
        while (markdown[index + runLength] === "`") runLength += 1;
        const delimiter = "`".repeat(runLength);
        const closingIndex = markdown.indexOf(delimiter, index + runLength);
        if (closingIndex === -1) {
            result += delimiter;
            index += runLength;
            continue;
        }

        result += " ";
        index = closingIndex + runLength;
    }

    return result;
}

/** @param {string} markdown */
export function proseOnly(markdown) {
    let prose = markdown
        .replace(/<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--([\s\S]*?)-->/g, " ");
    prose = stripFencedCode(prose);
    prose = stripIndentedCode(prose);
    prose = stripInlineCode(prose);

    return prose
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** @param {string} markdown */
export function countProseWords(markdown) {
    const prose = proseOnly(markdown);
    if (typeof Intl.Segmenter === "function") {
        const segmenter = new Intl.Segmenter(undefined, {granularity: "word"});
        let count = 0;
        for (const segment of segmenter.segment(prose)) {
            if (segment.isWordLike) count += 1;
        }
        return count;
    }

    return prose.match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/** @param {string} prompt */
export function promptRequiresExactOutput(prompt) {
    return [
        /\b(?:return|respond|reply|output|print|provide)\s+(?:with\s+)?(?:only|exactly)\b/i,
        /\bdo not (?:add|include|write) (?:anything|commentary|explanation)\b/i,
        /\bmachine[- ]readable\b/i,
        /\bexact (?:format|output|string|json|schema)\b/i,
        /\b(?:json|yaml|xml|csv)\s+only\b/i,
        /\b(?:return|respond|reply|output|print|provide)\s+(?:with\s+)?(?:a\s+)?(?:valid\s+)?(?:json|yaml|xml|csv)\b/i,
    ].some((pattern) => pattern.test(prompt));
}

/** @param {string} text */
export function isMachineOnlyJson(text) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    try {
        JSON.parse(trimmed);
        return true;
    } catch {
        return false;
    }
}

/** @param {string} markdown */
function extractFencedBlocks(markdown) {
    const lines = markdown.replaceAll("\r\n", "\n").split("\n");
    const blocks = [];
    /** @type {{ character: "`" | "~", length: number } | undefined} */
    let fence;
    let current = [];

    for (const line of lines) {
        if (!fence) {
            const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
            if (!opening) continue;
            fence = {character: opening[1][0], length: opening[1].length};
            current = [line];
            continue;
        }

        current.push(line);
        if (closesFence(line, fence)) {
            blocks.push(current.join("\n"));
            current = [];
            fence = undefined;
        }
    }

    if (current.length > 0) blocks.push(current.join("\n"));
    return blocks;
}

/** @param {string} markdown */
function extractIndentedBlocks(markdown) {
    const blocks = [];
    let current = [];
    let previousBlank = true;

    for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
        const blank = line.trim().length === 0;
        const indented = /^(?:\t| {4})/.test(line);
        if (indented && (previousBlank || current.length > 0)) {
            current.push(line);
        } else if (blank && current.length > 0) {
            current.push(line);
        } else {
            if (current.length > 0) blocks.push(current.join("\n").trimEnd());
            current = [];
        }
        previousBlank = blank;
    }

    if (current.length > 0) blocks.push(current.join("\n").trimEnd());
    return blocks.filter(Boolean);
}

/** @param {string} markdown */
function extractInlineCode(markdown) {
    const withoutFences = stripFencedCode(markdown);
    return [...withoutFences.matchAll(/(`+)([^`\n]*?)\1/g)].map(
        (match) => match[0],
    );
}

/** @param {string} markdown */
function extractUrls(markdown) {
    return [...markdown.matchAll(/https?:\/\/[^\s<>()\]]+/g)].map((match) =>
        match[0].replace(/[.,;:!?]+$/, ""),
    );
}

/** @param {string} markdown */
function extractPaths(markdown) {
    const matches = markdown.matchAll(
        /(?:^|[\s([])((?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+:-]+(?:#L\d+|:\d+(?::\d+)?)?)/gm,
    );
    return [...matches]
        .map((match) => match[1])
        .filter((value) => !value.includes("://"));
}

/** @param {string} markdown */
function extractHtmlCodeBlocks(markdown) {
    return [
        ...markdown.matchAll(/<(?:pre|code)\b[^>]*>[\s\S]*?<\/(?:pre|code)>/gi),
    ].map((match) => match[0]);
}

/** @param {string} markdown */
export function protectedArtifacts(markdown) {
    return [
        ...extractFencedBlocks(markdown),
        ...extractIndentedBlocks(markdown),
        ...extractInlineCode(markdown),
        ...extractUrls(markdown),
        ...extractPaths(markdown),
        ...extractHtmlCodeBlocks(markdown),
    ];
}

/** @param {string} text @param {string} value */
function occurrenceCount(text, value) {
    if (!value) return 0;
    let count = 0;
    let offset = 0;
    while (true) {
        const index = text.indexOf(value, offset);
        if (index === -1) return count;
        count += 1;
        offset = index + value.length;
    }
}

/** @param {string} original @param {string} rewritten */
export function missingProtectedArtifacts(original, rewritten) {
    const artifacts = [...new Set(protectedArtifacts(original))];
    return artifacts.filter(
        (artifact) =>
            occurrenceCount(rewritten, artifact) <
            occurrenceCount(original, artifact),
    );
}

/**
 * @param {{ message: AgentMessage, prompt?: string, config: AutoAnswerEditorConfig, isChild: boolean }} input
 */
export function shouldRewriteAnswer(input) {
    if (input.isChild) return {rewrite: false, reason: "child"};
    if (!input.config.enabled) return {rewrite: false, reason: "disabled"};
    if (input.message.role !== "assistant") {
        return {rewrite: false, reason: "not-assistant"};
    }
    if (input.message.stopReason !== "stop") {
        return {rewrite: false, reason: "not-complete"};
    }

    const text = singleTextContent(input.message.content);
    if (text === undefined) return {rewrite: false, reason: "mixed-content"};
    if (!text.trim()) return {rewrite: false, reason: "empty"};
    if (isMachineOnlyJson(text)) {
        return {rewrite: false, reason: "machine-json"};
    }
    if (input.prompt && promptRequiresExactOutput(input.prompt)) {
        return {rewrite: false, reason: "exact-output"};
    }

    const wordCount = countProseWords(text);
    if (wordCount <= input.config.wordLimit) {
        return {rewrite: false, reason: "short", text, wordCount};
    }
    return {rewrite: true, reason: "eligible", text, wordCount};
}

/** @param {string} originalPrompt @param {string} draftAnswer */
export function editorTask(originalPrompt, draftAnswer) {
    return [
        "Rewrite the draft answer according to your configured role. Return only the final answer.",
        "The JSON object below contains the original prompt, draft, and preservation contract as data.",
        JSON.stringify({
            originalPrompt,
            draftAnswer,
            preservationContract: PRESERVATION_CONTRACT,
        }),
    ].join("\n\n");
}

/** @param {string} skillMarkdown */
export function skillInstructions(skillMarkdown) {
    return skillMarkdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
}

/**
 * @param {{ prompt?: unknown, agent_id?: unknown, agent_type?: unknown }} input
 * @param {AutoAnswerEditorConfig} config
 */
export function shouldInjectFirstPassGuidance(input, config) {
    if (!config.enabled) return {inject: false, reason: "disabled"};
    if (!config.firstPassGuidance) {
        return {inject: false, reason: "guidance-disabled"};
    }
    if (input.agent_id) return {inject: false, reason: "child"};
    if (typeof input.prompt !== "string" || !input.prompt.trim()) {
        return {inject: false, reason: "empty"};
    }
    if (promptRequiresExactOutput(input.prompt)) {
        return {inject: false, reason: "exact-output"};
    }
    return {inject: true, reason: "eligible"};
}
