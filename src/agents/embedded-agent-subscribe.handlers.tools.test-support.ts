import type { AgentEvent } from "openclaw/plugin-sdk/agent-core";
import { vi } from "vitest";
import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./embedded-agent-subscribe.handlers.types.js";

type ToolExecutionEndEvent = Omit<Extract<AgentEvent, { type: "tool_execution_end" }>, "type">;

export function endTool(ctx: ToolHandlerContext, event: ToolExecutionEndEvent) {
  return handleToolExecutionEnd(ctx, { type: "tool_execution_end", ...event });
}

export function createTestContext(): {
  ctx: ToolHandlerContext;
  warn: ReturnType<typeof vi.fn>;
  onBlockReplyFlush: ReturnType<
    typeof vi.fn<NonNullable<ToolHandlerContext["params"]["onBlockReplyFlush"]>>
  >;
  onAgentEvent: ReturnType<typeof vi.fn>;
  onExecutionPhase: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  isEnabled: ReturnType<typeof vi.fn>;
} {
  const onBlockReplyFlush = vi.fn<NonNullable<ToolHandlerContext["params"]["onBlockReplyFlush"]>>();
  const onAgentEvent = vi.fn();
  const onExecutionPhase = vi.fn();
  const warn = vi.fn();
  const trace = vi.fn();
  const isEnabled = vi.fn(() => false);
  const ctx: ToolHandlerContext = {
    params: {
      runId: "run-test",
      sessionKey: "agent:unit-session",
      sessionId: "session-test-id",
      agentId: "agent-test-id",
      onBlockReplyFlush,
      onAgentEvent,
      onExecutionPhase,
      onToolResult: undefined,
    },
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: undefined,
    log: {
      debug: vi.fn(),
      trace,
      isEnabled,
      info: vi.fn(),
      warn,
    },
    state: {
      toolMetaById: new Map<string, ToolCallSummary>(),
      toolMetas: [],
      acceptedSessionSpawns: [],
      toolSummaryById: new Set<string>(),
      liveEditDiffStateById: new Map(),
      itemActiveIds: new Set<string>(),
      itemStartedCount: 0,
      itemCompletedCount: 0,
      pendingToolMediaUrls: [],
      pendingToolMediaTrustByUrl: new Map(),
      toolAutoDeliveryMediaUrls: new Set(),
      pendingToolAudioAsVoice: false,
      deterministicApprovalPromptPending: false,
      replayState: { replayInvalid: false, hadPotentialSideEffects: false },
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      currentSourceMessagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSourceReplyPayloads: [],
      messageToolOnlySourceReplyDelivered: false,
      messagingToolSentTargets: [],
      successfulCronAdds: 0,
      deterministicApprovalPromptSent: false,
      toolExecutionSinceLastBlockReply: false,
      assistantMessageIndex: 0,
    },
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };

  return { ctx, warn, onBlockReplyFlush, onAgentEvent, onExecutionPhase, trace, isEnabled };
}
