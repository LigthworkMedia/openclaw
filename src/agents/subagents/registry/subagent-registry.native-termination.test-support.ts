import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import {
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";

type Fixture = {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "entries" | "applySessionEntryExactReplacements" | "callGateway"
  >;
  mockPendingAgentWait: () => void;
};

export function registerNativeKillTimingAdmissionTest({
  getRegistry,
  mocks,
  mockPendingAgentWait,
}: Fixture) {
  it("keeps killed session timing root-admitted until the awaited stop settles", async () => {
    const mod = getRegistry();
    const entered = createDeferred();
    const release = createDeferred();
    const apply = expectDefined(
      mocks.applySessionEntryExactReplacements.getMockImplementation(),
      "session replacement owner",
    );
    mocks.applySessionEntryExactReplacements.mockImplementationOnce(async (params) => {
      entered.resolve();
      await release.promise;
      return apply(params);
    });
    mockPendingAgentWait();
    const runId = "run-kill-tail-admission";
    await mod.registerSubagentRun({
      runId,
      task: "persist killed session state",
      spawnMode: "session",
    });
    await waitForFast(() => expect(mocks.callGateway).toHaveBeenCalled());
    const termination = mod.markSubagentRunTerminated({ runId, reason: "manual kill" });
    try {
      await entered.promise;
      expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
    } finally {
      release.resolve();
      expect(await termination).toBe(1);
    }
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });
}

export function registerSupersededNativeTimingTest({
  getRegistry,
  mocks,
  mockPendingAgentWait,
}: Fixture) {
  it("does not restore a superseded lifecycle after a successor is released", async () => {
    const mod = getRegistry();
    const childSessionKey = "agent:main:subagent:released-timing-owner";
    mockPendingAgentWait();
    mocks.entries = {
      [childSessionKey]: { sessionId: "sess-released-timing-owner", updatedAt: 1 },
    };
    const originalEntry = structuredClone(mocks.entries[childSessionKey]);
    const apply = expectDefined(
      mocks.applySessionEntryExactReplacements.getMockImplementation(),
      "session replacement owner",
    );
    const entered = createDeferred();
    const release = createDeferred();
    mocks.applySessionEntryExactReplacements.mockImplementationOnce(async (params) => {
      entered.resolve();
      await release.promise;
      return apply(params);
    });
    await mod.registerSubagentRun({
      runId: "run-released-timing-old",
      childSessionKey,
      task: "old timing owner",
    });
    const termination = mod.markSubagentRunTerminated({
      runId: "run-released-timing-old",
      reason: "manual kill",
    });
    try {
      await entered.promise;
      await mod.registerSubagentRun({
        runId: "run-released-timing-new",
        childSessionKey,
        task: "new timing owner",
      });
      mod.releaseSubagentRun("run-released-timing-new");
    } finally {
      release.resolve();
      expect(await termination).toBe(1);
    }
    const oldRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-released-timing-old");
    expect(oldRun?.killReconciliation?.supersededAt).toBeTypeOf("number");
    expect(mocks.entries[childSessionKey]).toEqual(originalEntry);
  });
}
