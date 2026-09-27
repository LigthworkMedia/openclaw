import http from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { materializeRequesterScopedMcpToolsForHarnessRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import { testing } from "./agent-bundle-mcp-runtime.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-tools.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

export function registerRequesterScopedMcpTransportTests() {
  it(
    "clears removed scoped catalog through the harness after a real MCP transport run",
    { timeout: 15_000 },
    async () => {
      const resolverRegistry = createMcpProofPluginRegistry();
      await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
        const server = http.createServer((request, response) => {
          if (request.method === "DELETE") {
            response.writeHead(204).end();
            return;
          }
          if (request.method !== "POST") {
            response.writeHead(405).end();
            return;
          }
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const message = JSON.parse(body) as { id?: string | number; method?: string };
            if (message.method === "notifications/initialized") {
              response.writeHead(202).end();
              return;
            }
            response.setHeader("content-type", "application/json");
            response.setHeader("mcp-session-id", "session-proof");
            response.writeHead(200).end(
              JSON.stringify(
                message.method === "initialize"
                  ? {
                      jsonrpc: "2.0",
                      id: message.id,
                      result: {
                        protocolVersion: "2025-03-26",
                        capabilities: { tools: {} },
                        serverInfo: { name: "catalog-proof-server", version: "1.0.0" },
                      },
                    }
                  : {
                      jsonrpc: "2.0",
                      id: message.id,
                      result: {
                        tools: [
                          {
                            name: "inbox",
                            description: "read inbox",
                            inputSchema: { type: "object", properties: {} },
                          },
                        ],
                      },
                    },
              ),
            );
          });
        });
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address() as { port: number };

        const resolverApi = resolverRegistry.apiFor("test-plugin");
        resolverApi.registerMcpServerConnectionResolver({
          serverName: "user-mail",
          resolve: async () => ({ url: `http://127.0.0.1:${address.port}/mcp` }),
        });
        const scopedConfig = {
          mcp: { servers: { "user-mail": { transport: "streamable-http" } } },
        } satisfies OpenClawConfig;
        const staticConfig = {
          mcp: { servers: { shared: { command: "true" } } },
        } satisfies OpenClawConfig;

        try {
          const first = await materializeRequesterScopedMcpToolsForHarnessRun({
            sessionId: "session-harness-removal",
            workspaceDir: "/workspace",
            cfg: scopedConfig,
            requesterSenderId: "authed",
            autoApproveCodexAppServerApprovals: true,
          });
          expect(first?.advertisedTools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
          await first?.dispose();

          const afterRemoval = await materializeRequesterScopedMcpToolsForHarnessRun({
            sessionId: "session-harness-removal",
            workspaceDir: "/workspace",
            cfg: staticConfig,
            requesterSenderId: "guest",
          });
          expect(afterRemoval).toBeUndefined();
        } finally {
          await testing.resetSessionMcpRuntimeManager();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      });
    },
  );

  it(
    "gates requester MCP dispatch behind the approval boundary on a real transport",
    { timeout: 15_000 },
    async () => {
      let toolsCallCount = 0;
      const resolverRegistry = createMcpProofPluginRegistry();
      await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
        const server = http.createServer((request, response) => {
          if (request.method === "DELETE") {
            response.writeHead(204).end();
            return;
          }
          if (request.method !== "POST") {
            response.writeHead(405).end();
            return;
          }
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const message = JSON.parse(body) as { id?: string | number; method?: string };
            if (message.method === "notifications/initialized") {
              response.writeHead(202).end();
              return;
            }
            if (message.method === "tools/call") {
              toolsCallCount += 1;
            }
            response.setHeader("content-type", "application/json");
            response.setHeader("mcp-session-id", "session-approval-proof");
            response.writeHead(200).end(
              JSON.stringify(
                message.method === "initialize"
                  ? {
                      jsonrpc: "2.0",
                      id: message.id,
                      result: {
                        protocolVersion: "2025-03-26",
                        capabilities: { tools: {} },
                        serverInfo: { name: "approval-proof-server", version: "1.0.0" },
                      },
                    }
                  : message.method === "tools/call"
                    ? {
                        jsonrpc: "2.0",
                        id: message.id,
                        result: {
                          content: [{ type: "text", text: "server-result" }],
                        },
                      }
                    : {
                        jsonrpc: "2.0",
                        id: message.id,
                        result: {
                          tools: [
                            {
                              name: "inbox",
                              description: "read inbox",
                              inputSchema: { type: "object", properties: {} },
                            },
                          ],
                        },
                      },
              ),
            );
          });
        });
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address() as { port: number };

        const resolverApi = resolverRegistry.apiFor("test-plugin");
        resolverApi.registerMcpServerConnectionResolver({
          serverName: "user-mail",
          resolve: async () => ({ url: `http://127.0.0.1:${address.port}/mcp` }),
        });
        const scopedConfig = {
          mcp: { servers: { "user-mail": { transport: "streamable-http" } } },
        } satisfies OpenClawConfig;

        try {
          // Unannotated auto-mode tool: approval required; a deny must produce zero
          // server tool dispatches across the real transport.
          const denied = await materializeRequesterScopedMcpToolsForHarnessRun({
            sessionId: "session-approval-proof",
            workspaceDir: "/workspace",
            cfg: scopedConfig,
            requesterSenderId: "authed",
            requestInteractiveCodexApproval: async () => {
              throw new Error("operator denied");
            },
          });
          const gatedTool = expectDefined(denied?.tools[0], "gated requester tool");
          await expect(gatedTool.execute("denied-call", {})).rejects.toThrow("operator denied");
          expect(toolsCallCount).toBe(0);

          // An approval grants exactly one dispatch through to the real server.
          const allowed = await materializeRequesterScopedMcpToolsForHarnessRun({
            sessionId: "session-approval-proof",
            workspaceDir: "/workspace",
            cfg: scopedConfig,
            requesterSenderId: "authed",
            requestInteractiveCodexApproval: async () => {},
          });
          const allowedTool = expectDefined(allowed?.tools[0], "approved requester tool");
          const result = await allowedTool.execute("allowed-call", {});
          expect(result.content[0]).toMatchObject({ type: "text", text: "server-result" });
          expect(toolsCallCount).toBe(1);
          await denied?.dispose();
          await allowed?.dispose();
        } finally {
          await testing.resetSessionMcpRuntimeManager();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      });
    },
  );
}

export function registerFailedHttpRetirementTest() {
  it(
    "retains failed HTTP retirement for a later materialized cleanup after eviction",
    { timeout: 15_000 },
    async () => {
      testing.setBundleMcpDisposeTimeoutMsForTest(50);
      const sessionId = "test-session-" + Date.now();
      const manager = createSessionMcpRuntimeManager({ enableIdleSweepTimer: false });
      const server = http.createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(405).end();
          return;
        }
        if (req.method === "DELETE") {
          // Never respond — simulates a hung terminateSession() DELETE.
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const message = JSON.parse(body);
          res.setHeader("content-type", "application/json");
          res.setHeader("mcp-session-id", sessionId);
          if (message.method === "initialize") {
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "hanging-delete-server", version: "1.0.0" },
                },
              }),
            );
          } else if (message.method === "notifications/initialized") {
            res.writeHead(202).end();
          } else if (message.method === "tools/list") {
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: [{ name: "probe", description: "probe", inputSchema: { type: "object" } }],
                },
              }),
            );
          } else {
            res.writeHead(200).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
          }
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const addr = server.address() as { port: number };

      try {
        const runtime = await manager.getOrCreate({
          sessionId: "session-streamable-http-dispose",
          sessionKey: "agent:test:session-streamable-http-dispose",
          workspaceDir: "/workspace",
          cfg: {
            mcp: {
              servers: {
                hangingDelete: {
                  url: `http://127.0.0.1:${addr.port}/mcp`,
                  transport: "streamable-http",
                },
              },
            },
          },
        });

        const catalog = await runtime.getCatalog();
        expect(catalog.tools).toHaveLength(1);

        const materialized = await materializeBundleMcpToolsForRun({ runtime });
        const start = Date.now();
        await runtime.dispose();
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(1_000);
        await manager.disposeSession(runtime.sessionId);
        expect(manager.listRuntimeKeys()).toEqual([]);
        const cleanupScope = createAgentCleanupScope();
        await cleanupScope.run(async () => {
          await expect(materialized.dispose()).rejects.toThrow("could not confirm closure");
          await expect(materialized.dispose()).rejects.toThrow("could not confirm closure");
        });
        expect(cleanupScope.outcome).toBe("uncertain");
      } finally {
        await manager.disposeAll();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    },
  );
}
