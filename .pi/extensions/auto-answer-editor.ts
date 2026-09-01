import {
    editorTask,
    loadAutoAnswerEditorConfig,
    missingProtectedArtifacts,
    replaceSingleTextContent,
    shouldRewriteAnswer,
    textFromContent,
} from "../../.agents/answer-editor/core.mjs";

type SessionEntry = {
    type?: string;
    message?: { role?: string; content?: unknown };
};

type ExtensionContext = {
    cwd: string;
    hasUI: boolean;
    signal?: AbortSignal;
    sessionManager: {
        getBranch(): SessionEntry[];
        getSessionId(): string;
    };
    ui: {
        notify(message: string, level: "info" | "warning" | "error"): void;
        setStatus(id: string, text: string | undefined): void;
    };
};

type AgentMessage = {
    role: string;
    content?: unknown;
    stopReason?: string;
    [key: string]: unknown;
};

type MessageEndResult = { message: AgentMessage } | undefined;

type EventBus = {
    on(event: string, handler: (payload: unknown) => void): () => void;
    emit(event: string, payload: unknown): void;
};

type ExtensionAPI = {
    events: EventBus;
    on(
        event: "before_agent_start",
        handler: (event: { prompt: string }, ctx: ExtensionContext) => void,
    ): void;
    on(
        event: "message_end",
        handler: (
            event: { message: AgentMessage },
            ctx: ExtensionContext,
        ) => MessageEndResult | Promise<MessageEndResult>,
    ): void;
};

export type AutoAnswerEditorConfig = {
    enabled: boolean;
    wordLimit: number;
    delegationTimeoutMs: number;
    bridgeProbeTimeoutMs: number;
    firstPassGuidance: boolean;
    piAutomaticRewrite: boolean;
};

type RewriteDecision = {
    rewrite: boolean;
    reason: string;
    text?: string;
    wordCount?: number;
};

type DelegationResponse = {
    requestId?: string;
    ownerRunId?: string;
    nodeId?: string;
    status?: string;
    error?: string;
    result?: { kind?: string; text?: string };
};

type DelegationResult = {
    text?: string;
    error?: string;
};

type ConfigResult = {
    config: AutoAnswerEditorConfig;
    error?: string;
};

const AGENT_NAME = "answer-editor-agent";
const STATUS_ID = "auto-answer-editor";
const DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
const DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
const DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

function latestUserPrompt(ctx: ExtensionContext): string | undefined {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry.type !== "message" || entry.message?.role !== "user") continue;
        const prompt = textFromContent(entry.message.content).trim();
        if (prompt) return prompt;
    }
    return undefined;
}

export function probeSubagentBridge(
    events: EventBus,
    timeoutMs: number,
): Promise<boolean> {
    const requestId = globalThis.crypto.randomUUID();
    const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;

    return new Promise((resolveProbe) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const finish = (available: boolean) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            unsubscribe();
            resolveProbe(available);
        };

        const unsubscribe = events.on(replyEvent, (payload: unknown) => {
            if (!payload || typeof payload !== "object") return;
            const response = payload as {
                version?: unknown;
                requestId?: unknown;
                success?: unknown;
            };
            if (response.version !== 1 || response.requestId !== requestId) return;
            finish(response.success === true);
        });

        timeout = setTimeout(() => finish(false), timeoutMs);
        try {
            events.emit(RPC_REQUEST_EVENT, {
                version: 1,
                requestId,
                method: "ping",
                params: {},
            });
        } catch {
            finish(false);
        }
    });
}

function delegationResultFor(
    payload: unknown,
    identity: { requestId: string; ownerRunId: string; nodeId: string },
): DelegationResult | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const response = payload as DelegationResponse;
    if (
        response.requestId !== identity.requestId ||
        response.ownerRunId !== identity.ownerRunId ||
        response.nodeId !== identity.nodeId
    ) {
        return undefined;
    }
    if (
        response.status === "completed" &&
        response.result?.kind === "text" &&
        typeof response.result.text === "string" &&
        response.result.text.trim()
    ) {
        return {text: response.result.text.trim()};
    }
    return {
        error:
            response.error?.trim() ||
            `Answer editor finished with status ${response.status ?? "unknown"}.`,
    };
}

export function requestRewrite(input: {
    events: EventBus;
    ctx: ExtensionContext;
    originalPrompt: string;
    draftAnswer: string;
    timeoutMs: number;
}): Promise<DelegationResult> {
    const {events, ctx, originalPrompt, draftAnswer, timeoutMs} = input;
    const requestId = globalThis.crypto.randomUUID();
    const ownerRunId = `auto-answer-editor:${ctx.sessionManager.getSessionId()}`;
    const nodeId = `rewrite:${requestId}`;

    return new Promise((resolveRewrite) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: DelegationResult) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            ctx.signal?.removeEventListener("abort", cancel);
            unsubscribe();
            resolveRewrite(result);
        };

        const cancel = () => {
            events.emit(DELEGATION_CANCEL_EVENT, {requestId, ownerRunId, nodeId});
            finish({error: "Answer editing was cancelled."});
        };

        const unsubscribe = events.on(
            DELEGATION_RESPONSE_EVENT,
            (payload: unknown) => {
                const result = delegationResultFor(payload, {
                    requestId,
                    ownerRunId,
                    nodeId,
                });
                if (result) finish(result);
            },
        );

        timeout = setTimeout(() => {
            events.emit(DELEGATION_CANCEL_EVENT, {requestId, ownerRunId, nodeId});
            finish({error: "Answer editing timed out."});
        }, timeoutMs);

        ctx.signal?.addEventListener("abort", cancel, {once: true});

        try {
            events.emit(DELEGATION_REQUEST_EVENT, {
                requestId,
                ownerRunId,
                nodeId,
                agent: AGENT_NAME,
                task: editorTask(originalPrompt, draftAnswer),
                context: "fresh",
                cwd: ctx.cwd,
                timeoutMs,
                toolBudget: {hard: 1, block: "*"},
                artifacts: false,
                result: {kind: "text"},
            });
        } catch (error) {
            finish({error: error instanceof Error ? error.message : String(error)});
        }
    });
}

type EditorRuntimeState = {
    bridgeAvailable?: boolean;
    bridgeProbe?: Promise<boolean>;
    warnedAboutBridge: boolean;
};

async function ensureBridge(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    config: AutoAnswerEditorConfig,
    state: EditorRuntimeState,
): Promise<boolean> {
    if (state.bridgeAvailable === undefined) {
        state.bridgeProbe ??= probeSubagentBridge(
            pi.events,
            config.bridgeProbeTimeoutMs,
        );
        state.bridgeAvailable = await state.bridgeProbe;
    }
    if (state.bridgeAvailable) return true;
    if (ctx.hasUI && !state.warnedAboutBridge) {
        state.warnedAboutBridge = true;
        ctx.ui.notify(
            "Automatic answer editing is disabled for this session because the pi-subagents bridge is unavailable.",
            "warning",
        );
    }
    return false;
}

async function rewriteMessage(input: {
    pi: ExtensionAPI;
    ctx: ExtensionContext;
    message: AgentMessage;
    originalPrompt: string;
    decision: RewriteDecision & { text: string; wordCount: number };
    config: AutoAnswerEditorConfig;
}): Promise<MessageEndResult> {
    const {pi, ctx, message, originalPrompt, decision, config} = input;
    if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_ID, `editing ${decision.wordCount}-word answer`);
    }
    try {
        const result = await requestRewrite({
            events: pi.events,
            ctx,
            originalPrompt,
            draftAnswer: decision.text,
            timeoutMs: config.delegationTimeoutMs,
        });
        if (!result.text) {
            if (ctx.hasUI) {
                ctx.ui.notify(result.error ?? "Answer editing failed.", "warning");
            }
            return undefined;
        }

        const missing = missingProtectedArtifacts(decision.text, result.text);
        if (missing.length > 0) {
            if (ctx.hasUI) {
                ctx.ui.notify(
                    `Answer edit discarded because it changed ${missing.length} protected artifact(s).`,
                    "warning",
                );
            }
            return undefined;
        }

        const content = replaceSingleTextContent(message.content, result.text);
        if (content === undefined) return undefined;
        return {message: {...message, content}};
    } finally {
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
    }
}

function isTerminalAssistantMessage(message: AgentMessage): boolean {
    return (
        message.role === "assistant" &&
        (message.stopReason === "stop" || message.stopReason === "length")
    );
}

function rewriteCandidate(
    message: AgentMessage,
    prompt: string | undefined,
    config: AutoAnswerEditorConfig,
):
    | {
    prompt: string;
    decision: RewriteDecision & { text: string; wordCount: number };
}
    | undefined {
    if (!prompt || !config.piAutomaticRewrite) return undefined;
    const decision = shouldRewriteAnswer({
        message,
        prompt,
        config,
        isChild: false,
    }) as RewriteDecision;
    if (!decision.rewrite || !decision.text || decision.wordCount === undefined) {
        return undefined;
    }
    return {
        prompt,
        decision: {
            ...decision,
            text: decision.text,
            wordCount: decision.wordCount,
        },
    };
}

export default function autoAnswerEditor(pi: ExtensionAPI) {
    const runtime = globalThis as typeof globalThis & {
        process?: { env?: Record<string, string | undefined> };
    };
    if (runtime.process?.env?.PI_SUBAGENT_CHILD === "1") return;

    let currentPrompt: string | undefined;
    let configResult: ConfigResult | undefined;
    let warnedAboutConfig = false;
    const state: EditorRuntimeState = {warnedAboutBridge: false};

    pi.on("before_agent_start", (event) => {
        currentPrompt = event.prompt.trim() || undefined;
    });

    pi.on("message_end", async (event, ctx) => {
        if (!isTerminalAssistantMessage(event.message)) return;

        configResult ??= loadAutoAnswerEditorConfig(ctx.cwd) as ConfigResult;
        if (configResult.error && ctx.hasUI && !warnedAboutConfig) {
            warnedAboutConfig = true;
            ctx.ui.notify(configResult.error, "warning");
        }

        const candidate = rewriteCandidate(
            event.message,
            currentPrompt ?? latestUserPrompt(ctx),
            configResult.config,
        );
        currentPrompt = undefined;
        if (!candidate) return;
        if (!(await ensureBridge(pi, ctx, configResult.config, state))) return;

        return rewriteMessage({
            pi,
            ctx,
            message: event.message,
            originalPrompt: candidate.prompt,
            decision: candidate.decision,
            config: configResult.config,
        });
    });
}
