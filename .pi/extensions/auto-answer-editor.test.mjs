import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {probeSubagentBridge, requestRewrite} from "./auto-answer-editor.ts";

function createEventBus(onEmit) {
    const handlers = new Map();
    const events = {
        on(event, handler) {
            const subscribers = handlers.get(event) ?? new Set();
            subscribers.add(handler);
            handlers.set(event, subscribers);
            return () => subscribers.delete(handler);
        },
        emit(event, payload) {
            for (const handler of handlers.get(event) ?? []) handler(payload);
            onEmit?.(event, payload, events);
        },
    };
    return events;
}

function context() {
    return {
        cwd: "/tmp/project",
        hasUI: false,
        sessionManager: {
            getBranch: () => [],
            getSessionId: () => "session-1",
        },
        ui: {
            notify: () => undefined,
            setStatus: () => undefined,
        },
    };
}

describe("Pi bridge and delegation", () => {
    test("probes the process-local RPC bridge", async () => {
        const events = createEventBus((event, payload, bus) => {
            if (event !== "subagents:rpc:v1:request") return;
            bus.emit(`subagents:rpc:v1:reply:${payload.requestId}`, {
                version: 1,
                requestId: payload.requestId,
                success: true,
            });
        });

        assert.equal(await probeSubagentBridge(events, 20), true);
    });

    test("reports an unavailable bridge without hanging", async () => {
        assert.equal(await probeSubagentBridge(createEventBus(), 5), false);
    });

    test("correlates delegation responses and omits unsupported fields", async () => {
        let delegationRequest;
        const events = createEventBus((event, payload, bus) => {
            if (event !== "prompt-template:subagent:request") return;
            delegationRequest = payload;
            bus.emit("prompt-template:subagent:response", {
                requestId: "wrong-request",
                ownerRunId: payload.ownerRunId,
                nodeId: payload.nodeId,
                status: "completed",
                result: {kind: "text", text: "wrong"},
            });
            bus.emit("prompt-template:subagent:response", {
                requestId: payload.requestId,
                ownerRunId: payload.ownerRunId,
                nodeId: payload.nodeId,
                status: "completed",
                result: {kind: "text", text: "rewritten"},
            });
        });

        const result = await requestRewrite({
            events,
            ctx: context(),
            originalPrompt: "Explain this",
            draftAnswer: "A long draft",
            timeoutMs: 100,
        });

        assert.deepEqual(result, {text: "rewritten"});
        assert.ok(delegationRequest);
        assert.equal("turnBudget" in delegationRequest, false);
    });

    test("fails open after a delegation timeout", async () => {
        let cancelled = false;
        const events = createEventBus((event) => {
            if (event === "prompt-template:subagent:cancel") cancelled = true;
        });

        const result = await requestRewrite({
            events,
            ctx: context(),
            originalPrompt: "Explain this",
            draftAnswer: "A long draft",
            timeoutMs: 5,
        });

        assert.equal(result.error, "Answer editing timed out.");
        assert.equal(cancelled, true);
    });
});
