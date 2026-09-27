import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createWorkerComputerTool } from "../../worker/computer-runtime.js";
import { parseNodeWorkerComputerInput } from "../../worker/node-computer-protocol.js";
import { createDesktopSessionRegistry } from "../desktop/session-registry.js";
import { createWorkerComputerService } from "./computer-service.js";
import {
  createHarness,
  connectionIdentity,
  EXECUTION_ID,
} from "./computer-transport.test-support.js";
import { createWorkerComputerRpc } from "./worker-turn-computer-rpc.js";

const takeover = {
  nodeId: "desktop-node",
  command: "computer.act" as const,
  commandParams: { action: "__take_control", executionId: EXECUTION_ID },
};
const snapshot = {
  nodeId: "desktop-node",
  command: "screen.snapshot" as const,
  commandParams: { executionId: EXECUTION_ID },
};
const input = {
  nodeId: "desktop-node",
  command: "computer.act" as const,
  commandParams: { action: "type", executionId: EXECUTION_ID, text: "continue" },
};

async function setup() {
  const h = createHarness();
  const desktopRegistry = createDesktopSessionRegistry();
  const service = createWorkerComputerService({ ...h.options, desktopRegistry });
  const prepared = (await service.prepare(h.claim))!;
  const transport = prepared.bind(h.run, h.workerSource);
  await desktopRegistry.activate({ sourceKey: "environment-1", ownerEpoch: 7 });
  const close = vi.fn();
  desktopRegistry.attachObserver("environment-1", {
    control: true,
    ownerEpoch: 7,
    close,
  });
  return { h, desktopRegistry, service, prepared, transport, close };
}

describe("agent desktop takeover", () => {
  beforeEach(() => {
    resetAgentRunRegistryForTest();
    resetPluginRuntimeStateForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentRunRegistryForTest();
    resetPluginRuntimeStateForTest();
  });

  it("takes control through the worker RPC and preserves a later human takeover on replay", async () => {
    const f = await setup();
    const originalInvoke = f.h.privateInvoke.getMockImplementation()!;
    f.h.privateInvoke.mockImplementation(async (invocation) => {
      const result = await originalInvoke(invocation);
      const request = parseNodeWorkerComputerInput(JSON.stringify(invocation.params));
      return result.ok && request.operation === "snapshot"
        ? {
            ...result,
            payload: {
              format: "png",
              width: 1,
              height: 1,
              displayFrameId: "after-takeover",
              base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
            },
          }
        : result;
    });
    const cleanups: Array<(reason: string) => Promise<void>> = [];
    const registerRunCleanup = (cleanup: (reason: string) => Promise<void>) =>
      cleanups.push(cleanup);
    const rpc = createWorkerComputerRpc({
      execute: f.service.execute,
      validate: () => ({ ok: true }),
    });
    const connection = new AbortController();
    const tool = createWorkerComputerTool({
      descriptor: f.prepared.descriptor,
      runId: f.h.claim.runId,
      registerRunCleanup,
      requestComputer: async (request) => {
        const result = await rpc(connectionIdentity(f.h), request, connection.signal);
        return result.ok
          ? { type: "res", id: "computer", ok: true, payload: result.result }
          : {
              type: "res",
              id: "computer",
              ok: false,
              error: {
                code: "UNAVAILABLE",
                message:
                  "message" in result
                    ? (result.message ?? "Computer request rejected")
                    : "Computer request rejected",
                details: { reason: "gateway-unavailable" },
              },
            };
      },
    });
    try {
      const result = await tool.execute("resume", { action: "take_control" });
      expect(result.details).toMatchObject({
        action: "take_control",
        frameId: expect.any(String),
      });
      expect(result.content.some((block) => block.type === "image")).toBe(true);
      expect(f.close).toHaveBeenCalledExactlyOnceWith(4000, "control-taken:Agent");
      expect(f.desktopRegistry.hasController("environment-1", 7)).toBe(false);
      f.desktopRegistry.attachObserver("environment-1", {
        control: true,
        ownerEpoch: 7,
        close: vi.fn(),
      });
      await expect(tool.execute("resume", { action: "take_control" })).rejects.toThrow(
        "operator took control again",
      );
      await expect(
        tool.execute("still-human", { action: "type", text: "must not type" }),
      ).rejects.toThrow("operator has control");
    } finally {
      await Promise.all(cleanups.map((cleanup) => cleanup("test-complete")));
      await f.service.close();
      await f.desktopRegistry.stopAll();
    }
  });

  it("does not let a pre-takeover screenshot unlock input", async () => {
    const f = await setup();
    const viewerClose = vi.fn();
    f.desktopRegistry.attachObserver("environment-1", {
      control: false,
      ownerEpoch: 7,
      close: viewerClose,
    });
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    f.h.state.afterDispatch = async () => {
      entered.resolve();
      await resume.promise;
    };
    try {
      const pending = f.transport.invoke(snapshot);
      await entered.promise;
      await f.transport.invoke(takeover);
      expect(viewerClose).not.toHaveBeenCalled();
      resume.resolve();
      await pending;
      await expect(f.transport.invoke(input)).rejects.toThrow("fresh screenshot");
      f.h.state.afterDispatch = undefined;
      await f.transport.invoke(snapshot);
      await expect(f.transport.invoke(input)).resolves.toEqual({ ok: true });
    } finally {
      resume.resolve();
      await f.service.close();
      await f.desktopRegistry.stopAll();
    }
  });

  it.each(["placement", "grant", "deny", "epoch"] as const)(
    "does not evict a controller after %s revocation",
    async (reason) => {
      const f = await setup();
      const assertAuthorized = () => {
        if (reason === "grant") {
          throw new Error("grant revoked");
        }
      };
      if (reason === "placement") {
        f.h.releaseClaim();
      }
      if (reason === "deny") {
        f.h.state.config = { gateway: { nodes: { commands: { deny: ["computer.act"] } } } };
      }
      if (reason === "epoch") {
        f.desktopRegistry.claimOwnerEpoch("environment-1", 8);
      }
      try {
        await expect(f.transport.invoke(takeover, assertAuthorized)).rejects.toThrow();
        expect(f.close).not.toHaveBeenCalled();
        expect(f.desktopRegistry.hasController("environment-1", 7)).toBe(true);
      } finally {
        await f.service.close();
        await f.desktopRegistry.stopAll();
      }
    },
  );
});
