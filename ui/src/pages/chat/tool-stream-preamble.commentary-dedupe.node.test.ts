import { afterEach, describe, expect, it, vi } from "vitest";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { rolloverChatStream } from "./stream-causal-boundary.ts";
import { visibleAssistantStreamParts } from "./stream-reconciliation.ts";
import { reconcilePersistedAssistantStream } from "./stream-segment-pruning.ts";
import {
  createHost,
  TOOL_STREAM_TEST_NOW,
  useToolStreamFakeTimers,
} from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const COMMENTARY = "I'll list the workspace files first.";

function createChatState(
  overrides: Parameters<typeof makeChatHost>[0] = {},
): ReturnType<typeof makeChatHost> {
  return makeChatHost({ chatRunId: "run-1", sessionKey: "main", ...overrides });
}

function visibleParts(host: ReturnType<typeof createHost>) {
  return visibleAssistantStreamParts(host, {
    includeCurrent: true,
    isHiddenStreamText: isHiddenAssistantStreamText,
  }).map((part) => ({ text: part.text.trim(), itemId: part.itemId }));
}

function renderedTexts(host: ChatState) {
  return buildChatItems({
    paneId: "commentary-dedupe",
    sessionKey: host.sessionKey,
    runId: host.chatRunId,
    messages: host.chatMessages ?? [],
    toolMessages: [],
    streamSegments: host.chatStreamSegments ?? [],
    stream: host.chatStream,
    streamItemId: host.chatStreamItemId,
    streamItemPrefix: host.chatStreamItemPrefix,
    streamStartedAt: host.chatStreamStartedAt,
    showToolCalls: true,
  }).flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message }) => extractText(message))
      : item.kind === "stream"
        ? [item.text.trim()]
        : [],
  );
}

function preamble(
  host: Parameters<typeof handleAgentEvent>[0],
  itemId: string,
  text: string,
  seq: number,
) {
  handleAgentEvent(host, {
    runId: "run-1",
    seq,
    stream: "item",
    ts: TOOL_STREAM_TEST_NOW + seq,
    sessionKey: "main",
    data: { kind: "preamble", itemId, progressText: text },
  });
}

describe("keyed commentary after an unphased live stream", () => {
  afterEach(() => vi.useRealTimers());
  const persistCommentary = (
    host: ChatState,
    text: string,
    itemId = "commentary-1",
    messageId = "saved-commentary",
  ) =>
    applySessionMessagePayload(
      host,
      {
        runId: "run-1",
        messageId,
        messageSeq: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          __openclaw: { id: messageId, seq: 1, runId: "run-1" },
          openclawStreamFallback: { source: "segment", itemId },
        },
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );

  it("keeps persisted commentary once when its cumulative delta arrives late", () => {
    const text = "The saved commentary should appear once.";
    const host = createChatState();

    persistCommentary(host, text);

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(1);
  });

  it("keeps persisted commentary once when a legacy cumulative delta arrives late", () => {
    const text = "The legacy saved commentary should appear once.";
    const host = createChatState();

    persistCommentary(host, text);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(1);
  });

  it("keeps legacy delta-first commentary once after persistence", () => {
    const text = "The early legacy commentary should appear once.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    persistCommentary(host, text);

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(1);
  });

  it("retires persisted commentary from a later item's first cumulative delta", () => {
    const first = "The persisted first commentary should appear once.";
    const second = "The later keyed commentary remains live.";
    const host = createChatState();

    persistCommentary(host, first);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${first}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${first}\n\n${second}` }] },
    });

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("keeps persisted commentary once when its keyed delta arrives first", () => {
    const text = "The early keyed commentary should appear once.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    persistCommentary(host, text);

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(1);
  });

  it("preserves earlier cumulative output when the keyed delta arrives first", () => {
    const earlier = "An earlier observation remains visible.";
    const text = "The early keyed commentary should appear once.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: `${earlier}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${earlier}\n\n${text}` }] },
    });
    persistCommentary(host, text);

    expect(renderedTexts(host)).toEqual([earlier, text]);
  });

  it("keeps delta-first commentary once after a tool-boundary rollover", () => {
    const text = "The rolled commentary should appear once.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, text);

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(1);
  });

  it("retires an earlier item after a later keyed delta starts", () => {
    const first = "The first commentary persists late.";
    const second = "The second commentary is still live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: first }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${first}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${first}\n\n${second}` }] },
    });
    expect(renderedTexts(host)).toEqual([first, second]);
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("advances a partial earlier item to its durable producer boundary", () => {
    const partial = "Hello";
    const complete = "Hello world";
    const current = "The later item remains live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: partial }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${complete}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${complete}\n\n${current}` }],
      },
    });
    persistCommentary(host, complete);

    expect(renderedTexts(host)).toEqual([complete, current]);
  });

  it("retires an unseen earlier item from a later item's cumulative delta", () => {
    const first = "The unseen first commentary persists late.";
    const second = "The observed second commentary is still live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${first}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${first}\n\n${second}` }] },
    });
    expect(renderedTexts(host)).toEqual([`${first}\n\n${second}`]);
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("retires one unseen item while preserving another before the current item", () => {
    const first = "Hello";
    const second = "Hello again";
    const third = "The current item remains live.";
    const host = createChatState();
    const prefix = `${first}\n\n${second}\n\n`;

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${third}` }] },
    });
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([first, `${second}\n\n${third}`]);
  });

  it("retires distinct unseen items with identical text in order", () => {
    const repeated = "Two unseen items can say the same thing.";
    const current = "The current item remains live.";
    const host = createChatState();
    const prefix = `${repeated}\n\n${repeated}\n\n`;

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${current}` }] },
    });
    persistCommentary(host, repeated, "commentary-1", "saved-commentary-1");
    persistCommentary(host, repeated, "commentary-2", "saved-commentary-2");

    expect(renderedTexts(host)).toEqual([repeated, repeated, current]);
  });

  it("settles identical persisted receipts against distinct unseen occurrences", () => {
    const repeated = "Two persisted items can say the same thing.";
    const current = "The current item remains live.";
    const prefix = `${repeated}\n\n${repeated}\n\n`;
    const host = createChatState();

    persistCommentary(host, repeated, "commentary-1", "saved-commentary-1");
    persistCommentary(host, repeated, "commentary-2", "saved-commentary-2");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${current}` }] },
    });

    expect(renderedTexts(host)).toEqual([repeated, repeated, current]);
  });

  it("keeps an offset-less keyed snapshot intact when its item boundary is ambiguous", () => {
    const first = "The earlier item becomes durable.";
    const second = "The offset-less current item remains live.";
    const snapshot = `${first}\n\n${second}`;
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: snapshot }],
      },
    });
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([first, snapshot]);
  });

  it("retires an item from a rolled unkeyed cumulative snapshot", () => {
    const first = "An earlier restored item.";
    const second = "The restored item becomes durable.";
    const current = "A later keyed item remains live.";
    const restored = `${first}\n\n${second}`;
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: restored }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: `${restored}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${restored}\n\n${current}` }],
      },
    });
    persistCommentary(host, second, "commentary-2");

    expect(renderedTexts(host)).toEqual([first, second, current]);
  });

  it("reconciles persisted commentary before multiple unseen producer items", () => {
    const first = "The persisted first item appears once.";
    const second = "An unseen intermediate item remains visible.";
    const third = "The current item remains live.";
    const host = createChatState();
    const prefix = `${first}\n\n${second}\n\n`;

    persistCommentary(host, first);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${third}` }] },
    });

    expect(renderedTexts(host)).toEqual([first, `${second}\n\n${third}`]);
  });

  it("keeps an unkeyed prefix when an earlier keyed item persists late", () => {
    const earlier = "An unkeyed observation remains visible.";
    const first = "The first keyed commentary persists late.";
    const second = "The second keyed commentary is still live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: earlier }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: `${earlier}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${earlier}\n\n${first}` }],
      },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${earlier}\n\n${first}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${earlier}\n\n${first}\n\n${second}` }],
      },
    });
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([earlier, first, second]);
  });

  it("keeps an unkeyed prefix when the first keyed item starts", () => {
    const earlier = "An unkeyed observation remains visible.";
    const current = "The first keyed commentary is still live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: earlier }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: `${earlier}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${earlier}\n\n${current}` }],
      },
    });

    expect(renderedTexts(host)).toEqual([earlier, current]);
  });

  it("keeps a keyed item once when it resumes after a tool rollover", () => {
    const first = "The keyed item starts before the tool.";
    const second = "The same keyed item resumes after the tool.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: first }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${first}\n\n${second}` }],
      },
    });

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("retires a resumed keyed item when its complete snapshot persists", () => {
    const first = "The keyed item starts before the tool.";
    const complete = `${first} The same item finishes after the tool.`;
    const later = "A later keyed item remains live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      message: { role: "assistant", content: [{ type: "text", text: first }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      message: { role: "assistant", content: [{ type: "text", text: complete }] },
    });
    persistCommentary(host, complete);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${complete}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${complete}\n\n${later}` }],
      },
    });

    expect(renderedTexts(host)).toEqual([complete, later]);
  });

  it("retires a prefixed resumed item using its producer slice", () => {
    const earlier = "An earlier item remains visible.";
    const partial = "Working";
    const complete = "Working done";
    const later = "A later prefixed item remains live.";
    const prefix = `${earlier}\n\n`;
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: earlier }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${partial}` }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${complete}` }] },
    });
    persistCommentary(host, complete, "commentary-2");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 4,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: `${prefix}${complete}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${prefix}${complete}\n\n${later}` }],
      },
    });

    expect(renderedTexts(host)).toEqual([earlier, complete, later]);
  });

  it("keeps an unkeyed prefix when an unseen earlier item persists late", () => {
    const earlier = "An unkeyed observation remains visible.";
    const first = "The unseen first commentary persists late.";
    const second = "The observed second commentary is still live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: earlier }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${earlier}\n\n${first}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${earlier}\n\n${first}\n\n${second}` }],
      },
    });
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([earlier, first, second]);
  });

  it("anchors late persisted commentary after earlier cumulative output", () => {
    const earlier = "An earlier observation remains visible.";
    const text = "The saved commentary should appear once.";
    const host = createChatState({ chatStream: earlier });

    persistCommentary(host, text);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: `${earlier}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${earlier}\n\n${text}` }] },
    });

    expect(renderedTexts(host)).toEqual([earlier, text]);
  });

  it("keeps a later identical delta after persistence replaced the live item", () => {
    const text = "The saved commentary should appear twice.";
    const host = createChatState();
    preamble(host, "commentary-1", text, 1);
    persistCommentary(host, text);

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(2);
  });

  it("retires a matching keyed delta after persistence replaces its preamble", () => {
    const text = "The persisted preamble should appear once.";
    const host = createChatState();
    preamble(host, "commentary-1", text, 1);
    persistCommentary(host, text);

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(1);
  });

  it("does not let a pending receipt consume another item's identical delta", () => {
    const text = "Two items can say the same thing.";
    const host = createChatState();

    persistCommentary(host, text);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(2);
  });

  it.each([0, undefined])(
    "keeps identical text from consecutive keyed items (offset=%s)",
    (itemStartOffset) => {
      const text = "Two live items can say the same thing.";
      const host = createChatState();

      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq: 1,
        state: "delta",
        itemId: "commentary-1",
        itemStartOffset: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: "run-1",
        seq: 2,
        state: "delta",
        itemId: "commentary-2",
        itemStartOffset,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });

      expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(2);
    },
  );

  it("keeps a distinct later item whose text starts with persisted commentary", () => {
    const first = "The persisted commentary remains its own item.";
    const second = `${first} The later item continues.`;
    const host = createChatState();

    persistCommentary(host, first);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: second }] },
    });

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("keeps a legacy later item whose text starts with persisted commentary", () => {
    const first = "The persisted commentary remains its own item.";
    const second = `${first} The legacy later item continues.`;
    const host = createChatState();

    persistCommentary(host, first);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      message: { role: "assistant", content: [{ type: "text", text: second }] },
    });

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("keeps a legacy later item whose first paragraph matches persisted commentary", () => {
    const first = "The persisted commentary remains its own item.";
    const second = `${first}\n\nThe legacy later item has another paragraph.`;
    const host = createChatState();

    persistCommentary(host, first);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      message: { role: "assistant", content: [{ type: "text", text: second }] },
    });

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("preserves an earlier producer prefix when the current rolled item persists", () => {
    const first = "An unseen earlier item remains visible.";
    const second = "The current item becomes durable.";
    const host = createChatState();
    const cumulative = `${first}\n\n${second}`;

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${first}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: cumulative }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, second, "commentary-2");

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("retires an offset-less keyed segment containing only its persisted item", () => {
    const text = "Legacy keyed commentary becomes durable.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, text);

    expect(renderedTexts(host)).toEqual([text]);
  });

  it("retires a trailing item from an offset-less keyed cumulative segment", () => {
    const first = "An earlier cumulative item remains visible.";
    const second = "The trailing keyed item becomes durable.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${first}\n\n${second}` }],
      },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, second, "commentary-2");

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("renders tool-boundary commentary once across item and chat stream", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1" });
    // openai-completions/anthropic stream the text unphased first (chat delta).
    host.chatStream = `${COMMENTARY}\n\n`;
    host.chatStreamStartedAt = TOOL_STREAM_TEST_NOW - 50;
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: undefined }]);

    // The phase tagger then keys the same text as commentary at the tool boundary.
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "item",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "main",
      data: { kind: "preamble", itemId: "sig-1", progressText: COMMENTARY },
    });
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "sig-1" }]);

    // Tool start rolls the chat stream into an indexed segment; it must stay retired.
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 3,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW + 1,
      sessionKey: "main",
      data: { phase: "start", toolCallId: "call_1", name: "list_files", args: {} },
    });
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "sig-1" }]);

    // The next cumulative chat snapshot still trims the retired prefix.
    host.chatStream = `${COMMENTARY}\n\nFound a match, now let me read the file`;
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "sig-1" },
      { text: "Found a match, now let me read the file", itemId: undefined },
    ]);
    vi.useRealTimers();
  });
  it("preserves complete formatting when the keyed projection flattens code", () => {
    const text = "```python\nif ready:\n    run()\n```";
    const host = createHost({ chatRunId: "run-1", chatStream: `${text}\n\n` });
    const flattened = text.replace(/\s+/gu, " ");
    preamble(host, "item-a", flattened, 1);
    preamble(host, "item-a", flattened, 2);
    expect(visibleParts(host)).toEqual([{ text, itemId: "item-a" }]);
  });

  it.each([`${COMMENTARY} More detail.`, `Before. ${COMMENTARY}`])(
    "does not retire a different complete occurrence: %s",
    (text) => {
      const host = createHost({ chatRunId: "run-1", chatStream: text });
      preamble(host, "item-a", COMMENTARY, 1);
      expect(visibleParts(host)).toEqual([
        { text: COMMENTARY, itemId: "item-a" },
        { text, itemId: undefined },
      ]);
    },
  );

  it("keeps already-owned bytes retired when a pending item is shortened", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: "Checking tests" });
    preamble(host, "item-a", "Checking tests now", 1);
    preamble(host, "item-a", "Checking", 2);
    expect(visibleParts(host)).toEqual([{ text: "Checking", itemId: "item-a" }]);
    host.chatStream += "\n\nA later observation.";
    preamble(host, "item-a", "Checking", 3);
    expect(visibleParts(host)).toEqual([
      { text: "Checking", itemId: "item-a" },
      { text: "A later observation.", itemId: undefined },
    ]);
  });

  it("completes the owned prefix when the same pending item revises its text", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: "Checking" });
    preamble(host, "item-a", "Checking files.", 1);
    preamble(host, "item-a", "Checking tests.", 2);
    host.chatStream = "Checking tests.";
    preamble(host, "item-a", "Checking tests.", 3);
    expect(visibleParts(host)).toEqual([{ text: "Checking tests.", itemId: "item-a" }]);
  });

  it("does not acquire a later occurrence for an item that never owned the earlier stream", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: "Different text." });
    preamble(host, "item-a", COMMENTARY, 1);
    host.chatStream = COMMENTARY;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
  });

  it("does not let a late item update consume a later identical occurrence", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    preamble(host, "item-a", COMMENTARY, 1);
    host.chatStream += `${COMMENTARY}\n\n`;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
    preamble(host, "item-b", COMMENTARY, 3);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: "item-b" },
    ]);
  });

  it("retires a saved owner's first occurrence only, including delayed updates", () => {
    const saved = {
      role: "assistant",
      content: COMMENTARY,
      __openclaw: { id: "saved-a", seq: 1, runId: "run-1" },
      openclawStreamFallback: { itemId: "item-a", source: "segment" },
    };
    const host = createHost({
      chatRunId: "run-1",
      chatMessages: [saved],
      chatStream: `${COMMENTARY}\n\n`,
    });
    preamble(host, "item-a", COMMENTARY, 1);
    expect(visibleParts(host)).toEqual([]);
    expect(host.chatMessages).toEqual([saved]);
    host.chatStream += COMMENTARY;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: undefined }]);
  });

  it("transfers the rolled-over occurrence without changing its tool boundary", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "main",
      data: { phase: "start", toolCallId: "call_1", name: "list_files", args: {} },
    });
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "item-a" }]);
    host.chatStream = `${COMMENTARY}\n\nLater text.`;
    preamble(host, "item-a", COMMENTARY, 3);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: "Later text.", itemId: undefined },
    ]);
  });

  it("keeps leading code indentation on a later cumulative occurrence", () => {
    const code = "    execute()\n    finish()";
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    preamble(host, "item-a", COMMENTARY, 1);
    host.chatStream += code;
    preamble(host, "item-b", "execute() finish()", 2);
    const parts = visibleAssistantStreamParts(host, {
      includeCurrent: true,
      isHiddenStreamText: isHiddenAssistantStreamText,
    });
    expect(parts.map((part) => part.text)).toEqual([COMMENTARY, code]);
  });

  it("does not reacquire an occurrence after an item is cleared", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    preamble(host, "item-a", COMMENTARY, 1);
    preamble(host, "item-a", "", 2);
    host.chatStream += COMMENTARY;
    preamble(host, "item-a", COMMENTARY, 3);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
  });
  it("keeps earlier different cumulative text visible when a later occurrence becomes keyed", () => {
    useToolStreamFakeTimers();
    const earlier = "The first observation stays visible.";
    const saved = {
      role: "assistant",
      content: earlier,
      __openclaw: { id: "earlier", seq: 1, runId: "run-1" },
    };
    const host = createHost({
      chatRunId: "run-1",
      chatStream: `${earlier}\n\n`,
      chatMessages: [saved],
    });
    reconcilePersistedAssistantStream(host);
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "main",
      data: { phase: "start", toolCallId: "call_1", name: "list_files", args: {} },
    });
    host.chatStream = `${earlier}\n\n${COMMENTARY}\n\n`;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(host.chatMessages).toEqual([saved]);
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "item-a" }]);
  });
  it("completes a keyed handoff when the last chat chunk arrives between update and end", () => {
    const text =
      "Commentary formatting proof.\n\n- first file\n- second file\n\n```python\nif ready:\n    execute()\n```";
    const host = createHost({ chatRunId: "run-1", chatStream: text.slice(0, -4) });
    const progress = text.replace(/\s+/gu, " ");
    preamble(host, "item-a", progress, 1);
    host.chatStream = text;
    preamble(host, "item-a", progress, 2);
    expect(visibleParts(host)).toEqual([{ text, itemId: "item-a" }]);
    host.chatStream += "\n\nA later observation.";
    preamble(host, "item-a", progress, 3);
    expect(visibleParts(host)).toEqual([
      { text, itemId: "item-a" },
      { text: "A later observation.", itemId: undefined },
    ]);
  });
});
