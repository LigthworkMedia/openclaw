import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { SidebarSessionNarrationController } from "../components/app-sidebar-session-narration.ts";
import type { SidebarToolActivity } from "../components/app-sidebar-session-types.ts";
import { runningRow } from "./app-sidebar-session-narration.ts";

const controllers: SidebarSessionNarrationController[] = [];
function gatewayEvent(event: string, payload: unknown): GatewayEventFrame {
  return { type: "event", event, payload };
}
function createToolController() {
  const tools: Array<ReadonlyMap<string, SidebarToolActivity>> = [];
  const source = {
    subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
    unsubscribeMessages: vi.fn(() => Promise.resolve()),
  };
  const controller = new SidebarSessionNarrationController(
    () => undefined,
    undefined,
    (next) => tools.push(next),
  );
  controllers.push(controller);
  controller.sync({
    enabled: true,
    connected: true,
    connectionIdentity: {},
    source,
    openSessionKey: "",
    rows: [runningRow("agent:main:run")],
    agentId: "main",
  });
  return { controller, tools };
}
describe("Sidebar tool activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      controller.disconnect();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("projects public tool progress without exposing raw output or unrelated items", () => {
    const { controller, tools } = createToolController();
    const emit = (stream: string, data: Record<string, unknown>) =>
      controller.handleEvent(
        gatewayEvent("session.tool", {
          sessionKey: "agent:main:run",
          runId: "run-1",
          stream,
          data,
        }),
      );
    emit("tool", {
      name: "exec",
      toolCallId: "call-1",
      phase: "start",
      args: { command: "private input" },
    });
    expect(tools.at(-1)?.get("agent:main:run")).toEqual({
      name: "exec",
      toolCallId: "call-1",
      text: undefined,
    });
    emit("item", {
      kind: "tool",
      itemId: "tool:call-1",
      name: "exec",
      toolCallId: "call-1",
      phase: "start",
      title: "Exec printf fixture-private-output",
      meta: "printf fixture-private-output",
    });
    expect(tools.at(-1)?.get("agent:main:run")?.text).toBeUndefined();
    emit("item", {
      kind: "tool",
      itemId: "tool:call-1",
      name: "exec",
      toolCallId: "call-1",
      phase: "update",
      title: "Exec",
      meta: "Run focused tests",
      progressText: "Checking **3 files**",
    });
    expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Checking 3 files");
    emit("tool", {
      name: "exec",
      toolCallId: "call-1",
      phase: "update",
      partialResult: { text: "private output" },
    });
    expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Checking 3 files");
    const count = tools.length;
    emit("item", {
      kind: "preamble",
      itemId: "preamble",
      phase: "end",
      title: "Preamble",
      progressText: "Unrelated narration",
    });
    emit("item", {
      kind: "tool",
      itemId: "hidden",
      name: "read",
      phase: "update",
      title: "Read",
      hideFromChannelProgress: true,
    });
    expect(tools).toHaveLength(count);
    emit("tool", { name: "exec", toolCallId: "call-2", phase: "start" });
    expect(tools.at(-1)?.get("agent:main:run")?.text).toBeUndefined();
    controller.disconnect();
    expect(tools.at(-1)?.size).toBe(0);
  });

  it.each([
    { stream: "item", flag: "hideFromChannelProgress", metadata: "full" },
    { stream: "item", flag: "suppressChannelProgress", metadata: "full" },
    { stream: "tool", flag: "hideFromChannelProgress", metadata: "full" },
    { stream: "tool", flag: "hideFromChannelProgress", metadata: "omitted" },
    { stream: "tool", flag: "hideFromChannelProgress", metadata: "contradictory" },
  ])(
    "withdraws matching $stream progress with $metadata metadata when $flag changes",
    ({ stream, flag, metadata }) => {
      const { controller, tools } = createToolController();
      const emit = (
        runId: string,
        toolCallId: string,
        data: Record<string, unknown>,
        eventStream = "item",
      ) => {
        const payload: Record<string, unknown> = {
          kind: "tool",
          itemId: "tool:" + toolCallId,
          name: "read",
          toolCallId,
          phase: "update",
          title: "Read",
          ...data,
        };
        if (eventStream === "tool" && metadata === "omitted") {
          delete payload.name;
          delete payload.phase;
        } else if (eventStream === "tool" && metadata === "contradictory") {
          payload.name = "other-tool";
        }
        controller.handleEvent(
          gatewayEvent("session.tool", {
            sessionKey: "agent:main:run",
            runId,
            stream: eventStream,
            data: payload,
          }),
        );
      };
      emit("run-2", "current", { progressText: "Public progress" });
      expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Public progress");
      const visibleCount = tools.length;
      emit("run-1", "current", { [flag]: true }, stream);
      emit("run-2", "other", { [flag]: true }, stream);
      emit("", "current", { [flag]: true }, stream);
      expect(tools).toHaveLength(visibleCount);
      expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Public progress");
      emit("run-2", "current", { [flag]: true }, stream);
      expect(tools.at(-1)?.has("agent:main:run")).toBe(false);
      expect(tools).toHaveLength(visibleCount + 1);
      emit("run-2", "current", { [flag]: true }, stream);
      expect(tools).toHaveLength(visibleCount + 1);
      controller.disconnect();
    },
  );
});
