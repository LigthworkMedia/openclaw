import path from "node:path";

export function mcpManagerFixtureFiles(repoRoot: string): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  const imports = `import { expect, it, vi } from "vitest";
const key = Symbol.for("openclaw.sessionMcpRuntimeManager");
const probeKey = Symbol.for("fixture.sessionMcpManager");
`;
  return {
    "09-mcp-a-mocked-owner.test.ts": `${imports}
vi.mock(${source("plugins/plugin-metadata-snapshot.ts")}, () => ({}));
it("retains a real MCP manager created under a file-owned metadata mock", async () => {
  const { getSessionMcpRuntimeManagerForTesting } = await import(${source("agents/agent-bundle-mcp-manager-api.ts")});
  const manager = getSessionMcpRuntimeManagerForTesting();
  await manager.disposeAll();
  expect(globalThis[key]).toBe(manager);
});
`,
    "09-mcp-b-installed-bundle.test.ts": `import ${source("agents/agent-bundle-mcp-runtime.agent-bundle.test.ts")};
`,
    "09-mcp-c-replaced-owner.test.ts": `${imports}
it("cancels the agent before publishing a successor during MCP disposal", async () => {
  const { getSessionMcpRuntimeManagerForTesting } = await import(${source("agents/agent-bundle-mcp-manager-api.ts")});
  const manager = getSessionMcpRuntimeManagerForTesting();
  const lease = await manager.acquire({ sessionId: "replacement", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  const join = lease.runtime.joinCleanup.bind(lease.runtime);
  await vi.resetModules();
  const { createSessionMcpRuntimeManager } = await import(${source("agents/agent-bundle-mcp-manager.ts")});
  const successor = createSessionMcpRuntimeManager({ enableIdleSweepTimer: false });
  const probe = globalThis[probeKey] = { successor, joined: false, cancelled: false };
  let cancel;
  const cancelled = new Promise(resolve => { cancel = resolve; });
  const { ACTIVE_EMBEDDED_RUNS } = await import(${source("agents/embedded-agent-runner/run-state.ts")});
  ACTIVE_EMBEDDED_RUNS.set("mcp-dependent-run", { cancel() { probe.cancelled = true; cancel(); } });
  lease.runtime.joinCleanup = async () => {
    expect(probe.cancelled, "agent cancellation must release the MCP cleanup barrier").toBe(true);
    await cancelled;
    await join();
    globalThis[key] = successor;
    probe.joined = true;
  };
});
`,
    "09-mcp-d-current-owner.test.ts": `${imports}
it("keeps the replacement MCP manager usable after prior-owner cleanup", async () => {
  const probe = globalThis[probeKey];
  expect(probe.joined).toBe(true);
  expect(probe.cancelled).toBe(true);
  expect(globalThis[key]).toBe(probe.successor);
  const { acquireSessionMcpRuntime } = await import(${source("agents/agent-bundle-mcp-manager-api.ts")});
  const lease = await acquireSessionMcpRuntime({ sessionId: "successor", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false } } });
  expect(lease.runtime.sessionId).toBe("successor");
  lease.releaseLease();
  delete globalThis[probeKey];
});
`,
    "09-mcp-e-mocked-disposer.test.ts": `${imports}
it("leaves a retained MCP session behind a file-owned disposal spy", async () => {
  const { getSessionMcpRuntimeManagerForTesting } = await import(${source("agents/agent-bundle-mcp-manager-api.ts")});
  const manager = getSessionMcpRuntimeManagerForTesting();
  const lease = await manager.acquire({ sessionId: "mocked-dispose", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  globalThis[probeKey] = { manager };
  vi.spyOn(manager, "disposeAll").mockResolvedValue(undefined);
});
`,
    "09-mcp-f-disposal-custody.test.ts": `${imports}
it("restores the MCP disposal spy and closes its real owner", () => {
  const { manager } = globalThis[probeKey];
  expect(globalThis[key]).toBeUndefined();
  expect(manager.listRuntimeKeys()).toEqual([]);
  delete globalThis[probeKey];
});
`,
    "98-mcp-a-direct-disposer.test.ts": `${imports}
it("replaces a retained MCP manager disposer without a restorable spy", async () => {
  const { getSessionMcpRuntimeManagerForTesting } = await import(${source("agents/agent-bundle-mcp-manager-api.ts")});
  const manager = getSessionMcpRuntimeManagerForTesting();
  const lease = await manager.acquire({ sessionId: "mocked-dispose", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  globalThis[probeKey] = { manager, dispose: manager.disposeAll.bind(manager) };
  manager.disposeAll = vi.fn(async () => undefined);
});
`,
    "98-mcp-b-direct-custody.test.ts": `${imports}
it("retains MCP custody when the file mocked its disposer", async () => {
  const { manager, dispose } = globalThis[probeKey];
  expect(globalThis[key]).toBe(manager);
  expect(manager.listRuntimeKeys()).toEqual(["mocked-dispose"]);
  await dispose();
  expect(manager.listRuntimeKeys()).toEqual([]);
  if (globalThis[key] === manager) Reflect.deleteProperty(globalThis, key);
  delete globalThis[probeKey];
});
`,
    "98-mcp-c-prior-failure.test.ts": `${imports}
it("fails MCP cleanup before the runner opens its cleanup scope", async () => {
  const { getSessionMcpRuntimeManagerForTesting } = await import(${source("agents/agent-bundle-mcp-manager-api.ts")});
  const { createAgentCleanupScope } = await import(${source("agents/run-cleanup-timeout.ts")});
  const manager = getSessionMcpRuntimeManagerForTesting();
  const lease = await manager.acquire({ sessionId: "prior-failure", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  const probe = globalThis[probeKey] = { manager, closes: 0 };
  lease.runtime.joinCleanup = async () => {
    probe.closes++;
    throw new Error("Synthetic MCP closure could not be confirmed");
  };
  const scope = createAgentCleanupScope();
  await scope.run(() => manager.disposeAll());
  expect(scope.outcome).toBe("uncertain");
  expect(manager.listRuntimeKeys()).toEqual([]);
  await vi.resetModules();
});
`,
    "98-mcp-d-prior-custody.test.ts": `${imports}
it("retains MCP custody after an earlier disposal failure without retrying it", () => {
  const probe = globalThis[probeKey];
  expect(probe.closes).toBe(1);
  expect(globalThis[key]).toBe(probe.manager);
  if (globalThis[key] === probe.manager) Reflect.deleteProperty(globalThis, key);
  delete globalThis[probeKey];
});
`,
    "99-mcp-a-uncertain-owner.test.ts": `${imports}
it("records old-module MCP cleanup uncertainty during file retirement", async () => {
  const { getSessionMcpRuntimeManagerForTesting } = await import(${source("agents/agent-bundle-mcp-manager-api.ts")});
  const manager = getSessionMcpRuntimeManagerForTesting();
  const lease = await manager.acquire({ sessionId: "uncertain", workspaceDir: process.cwd(), cfg: { plugins: { enabled: false }, mcp: { servers: { probe: { command: process.execPath } } } } });
  lease.releaseLease();
  const probe = globalThis[probeKey] = { manager, closes: 0 };
  lease.runtime.joinCleanup = async () => {
    probe.closes++;
    throw new Error("Synthetic MCP closure could not be confirmed");
  };
  // The runner imports its scope from a new module graph; the manager records
  // the swallowed disposal error through its original cleanup module.
  await vi.resetModules();
});
`,
    "99-mcp-b-retained-owner.test.ts": `${imports}
it("retains the uncertain MCP owner without retrying its failed disposal", () => {
  const probe = globalThis[probeKey];
  expect(probe.closes).toBe(1);
  expect(globalThis[key]).toBe(probe.manager);
});
`,
    "99-mcp-c-runner-generation.test.ts": `${imports}
it("keeps uncertain MCP custody after the runner module is reevaluated", () => {
  const probe = globalThis[probeKey];
  expect(probe.closes).toBe(1);
  expect(globalThis[key]).toBe(probe.manager);
});
`,
  };
}
