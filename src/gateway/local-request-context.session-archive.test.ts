// Proves discovery -> caller-bound RPC -> deferred archive without a model or live Gateway.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// These fixtures create no browser resources; keep unrelated browser loading out of archive proof.
vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

const TARGET = "agent:main:dashboard:assigned-archive";
const TARGET_ID = "assigned-archive-id";
let fixtureRun: Promise<void> | undefined;
afterEach(async () => {
  await fixtureRun?.catch(() => {});
  fixtureRun = undefined;
});

function withSessionToolsFixture(run: (cfg: OpenClawConfig) => Promise<void>) {
  return (fixtureRun = withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      ...rolePolicyConfig(),
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      tools: { sessions: { visibility: "all" } },
    };
    await state.writeConfig(cfg);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: TARGET },
      {
        sessionId: TARGET_ID,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "other-person" },
      },
    );
    const resources = new LegacyPluginSdkResourceHost();
    try {
      await resources.run(() =>
        withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => cfg }, () =>
          run(cfg),
        ),
      );
    } finally {
      await resources.close();
    }
  }));
}

describe("scoped session archive tools", () => {
  it.each(["unbound", "reader"] as const)(
    "does not expose archive to a %s caller",
    async (caller) => {
      await withSessionToolsFixture(async (cfg) => {
        const options = {
          config: cfg,
          agentId: "main",
          sessionKey: TARGET,
          sessionId: TARGET_ID,
          senderIsOwner: false,
        };
        const check = async () => {
          for (const surface of [
            createOpenClawCodingTools(options),
            resolveGatewayScopedTools({ ...options, cfg, surface: "loopback" }).tools,
          ]) {
            expect(surface.some((tool) => tool.name === "sessions")).toBe(false);
          }
          await expect(
            createSessionsTool({
              config: cfg,
              agentSessionKey: TARGET,
              agentSessionId: TARGET_ID,
              archiveOnly: true,
            }).execute("no-write-grant", {
              action: "patch",
              archived: true,
            }),
          ).rejects.toThrow(/current operator write grant/);
        };
        if (caller === "unbound") {
          await check();
        } else {
          const client = roleClient("view");
          client.connect.scopes = ["operator.read"];
          await withPluginRuntimeGatewayRequestScope(
            { ...getPluginRuntimeGatewayRequestScope(), client, isWebchatConnect: () => false },
            () =>
              withOperatorToolGatewayAuthority(
                {
                  authenticatedUserProfile: client.authenticatedUserProfile,
                  scopes: ["operator.read"],
                },
                check,
              ),
          );
        }
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.archivedAt,
        ).toBeUndefined();
      });
    },
  );

  it.each(["operator.write", "operator.sessions.write"])(
    "exposes requester-scoped self-archive through the assembled tool surface (%s)",
    async (scope) => {
      await withSessionToolsFixture(async (cfg) => {
        const request = getPluginRuntimeGatewayRequestScope();
        if (!request?.context) {
          throw new Error("expected local Gateway context");
        }
        const client = roleClient("write");
        client.connect.scopes = [scope];
        const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
        const sessionKey = "agent:main:dashboard:operator-archive";
        const sessionId = "operator-archive-id";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: profile.profileId },
          },
        );
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: TARGET },
          { owner: { actor: { type: "human", id: profile.profileId } } },
        );
        const archived = createDeferredCore();
        request.context.subscribeSessionEvents("operator-archive-proof");
        request.context.broadcastToConnIds = (event, payload) => {
          if (
            event === "sessions.changed" &&
            isRecord(payload) &&
            payload.sessionKey === sessionKey
          ) {
            archived.resolve();
          }
        };
        const admission = await beginSessionWorkAdmission({
          scope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
          identities: [sessionKey, sessionId],
          assertAllowed: () => {},
        });
        let retained: ReturnType<typeof createSessionsTool> | undefined;
        try {
          const result = await withPluginRuntimeGatewayRequestScope({ ...request, client }, () =>
            withOperatorToolGatewayAuthority(
              { authenticatedUserProfile: profile, scopes: [scope] },
              async () => {
                const options = {
                  config: cfg,
                  agentId: "main",
                  sessionKey,
                  sessionId,
                  senderIsOwner: false,
                };
                const tools = createOpenClawCodingTools(options);
                const gatewayTools = resolveGatewayScopedTools({
                  ...options,
                  cfg,
                  surface: "loopback",
                }).tools;
                for (const surface of [tools, gatewayTools]) {
                  const tool = expectDefined(
                    surface.find((candidate) => candidate.name === "sessions"),
                    "session writer archive tool",
                  );
                  expect(tool.parameters).toMatchObject({
                    properties: { action: { enum: ["patch"] }, archived: { type: "boolean" } },
                    required: ["action", "archived"],
                  });
                  await expect(
                    tool.execute("not-archive", { action: "reset", sessionKey: TARGET }),
                  ).rejects.toThrow(/archive|restore/i);
                  await expect(
                    tool.execute("not-settings", {
                      action: "patch",
                      archived: true,
                      model: "other",
                    }),
                  ).rejects.toThrow(/archive|restore/i);
                }
                const tool = expectDefined(
                  tools.find((candidate) => candidate.name === "sessions"),
                  "archive tool",
                );
                retained = tool;
                const archiveAssigned = (value: boolean) =>
                  tool.execute("archive-assigned", {
                    action: "patch",
                    sessionKey: TARGET,
                    expectedSessionId: TARGET_ID,
                    archived: value,
                  });
                if (scope === "operator.write") {
                  await archiveAssigned(true);
                  expect(
                    loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.archivedAt,
                  ).toEqual(expect.any(Number));
                  await archiveAssigned(false);
                } else {
                  // Display assignment is not a creator grant for session-only writers.
                  await expect(archiveAssigned(true)).rejects.toThrow(
                    /own|denied|not found|scope/i,
                  );
                }
                expect(
                  loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.archivedAt,
                ).toBeUndefined();
                return await admission.run(() =>
                  tool.execute("archive-own-session", { action: "patch", archived: true }),
                );
              },
            ),
          );
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
          expect(loadSessionEntry({ agentId: "main", sessionKey })?.archivedAt).toBeUndefined();
        } finally {
          admission.release();
        }
        await archived.promise;
        expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
          sessionId,
          archivedAt: expect.any(Number),
        });
        await expect(
          expectDefined(retained, "retained archive tool").execute("expired-restore", {
            action: "patch",
            archived: false,
          }),
        ).rejects.toThrow(/current operator write grant/);
      });
    },
  );
});
