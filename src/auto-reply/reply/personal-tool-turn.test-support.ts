import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import {
  withGatewayToolCallerIdentity,
  withGatewayPersonalToolUser,
} from "../../agents/tools/gateway-caller-context.js";
import type { GatewayClient } from "../../gateway/server-methods/types.js";
import type { GatewayUiCommandTarget } from "../../gateway/ui-command-target.types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import type {
  ReplyBackendQueueMessageOptions,
  ReplyMessageInjectionOutcome,
} from "./reply-run-registry.contracts.js";
import {
  createTestReplyOperation,
  queueCurrentReplyRunMessage,
} from "./reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

export async function callPersonalToolUiCommand(
  params: Record<string, unknown>,
  clients: GatewayClient[],
  requester?: GatewayClient,
) {
  const [{ vi }, { createContext }, { uiCommandHandlers }] = await Promise.all([
    import("vitest"),
    import("../../gateway/server-plugin-in-process-dispatch.test-support.js"),
    import("../../gateway/server-methods/ui-command.js"),
  ]);
  const respond = vi.fn();
  const broadcastToConnIds = vi.fn();
  await uiCommandHandlers["ui.command"]!({
    req: { type: "req", id: "screen", method: "ui.command", params },
    params,
    client: requester ?? null,
    isWebchatConnect: () => false,
    respond,
    context: {
      ...createContext(),
      broadcastToConnIds,
      getClientConnIds: (filter) =>
        new Set(
          clients
            .filter((entry) => filter?.(entry) !== false)
            .flatMap((entry) => (entry.connId ? [entry.connId] : [])),
        ),
    },
  });
  return { respond, broadcastToConnIds };
}

export async function createPersonalToolScreenDispatcher(profileIds: readonly string[]) {
  const [{ GATEWAY_CLIENT_IDS }, { createOperatorClient }] = await Promise.all([
    import("../../../packages/gateway-protocol/src/client-info.js"),
    import("../../gateway/server-plugin-in-process-dispatch.test-support.js"),
  ]);
  const recipients = profileIds.map((profileId) => {
    const client = createOperatorClient({
      profileId,
      caps: ["ui-commands"],
      scopes: ["operator.write"],
    });
    client.connId = `${profileId}-tab`;
    client.connect.client.id = GATEWAY_CLIENT_IDS.CONTROL_UI;
    return client;
  });
  return (user?: string) =>
    withGatewayPersonalToolUser(user, () =>
      callPersonalToolUiCommand({ command: { kind: "sidebar", visible: false } }, recipients),
    );
}

export async function createPersonalThemeToolCaller(
  invoke: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{ ok: boolean; payload?: unknown; error?: { message: string } }>,
) {
  const [{ vi }, gatewayRequest, { createThemeTool }] = await Promise.all([
    import("vitest"),
    import("../../agents/tools/in-process-gateway.js"),
    import("../../agents/tools/theme-tool.js"),
  ]);
  vi.spyOn(gatewayRequest, "callAgentToolGatewayRequest").mockImplementation(
    async <T>(request: Parameters<typeof gatewayRequest.callAgentToolGatewayRequest>[0]) => {
      const result = await invoke(request.method, request.params as Record<string, unknown>);
      if (!result.ok) {
        throw new Error(result.error?.message);
      }
      return result.payload as T;
    },
  );
  const theme = createThemeTool();
  return async (params: Record<string, unknown>, user?: string) =>
    (await theme.execute("theme", { ...params, ...(user ? { user } : {}) })).details;
}

type Person = {
  profileId: string;
  senderId: string;
  name: string;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
};

export async function withPersonalToolTurn<T>(
  params: { owner: Person; backendKind?: "embedded" | "cli"; hiddenQuestion?: boolean },
  test: (turn: {
    steer(
      person: Person,
      options?: { reject?: boolean; scopes?: string[] },
    ): Promise<ReplyMessageInjectionOutcome>;
    revoke(profileId: string): void;
    complete(): void;
    operation: ReturnType<typeof createTestReplyOperation>;
    releaseCounts: Map<string, number>;
  }) => Promise<T>,
): Promise<T> {
  const revoked = new Set<string>();
  const releaseCounts = new Map<string, number>();
  const run = createQueueTestRun({ prompt: "Arrange my view" });
  const modelPolicy = prepareOperatorModelPolicy({ cfg: {}, policy: {} });
  const authority = (person: Person, scopes = ["operator.read", "operator.write"]) =>
    createAdmittedRunOperatorAuthority({
      profileId: person.profileId,
      scopes,
      gatewayAccessGrant: null,
      modelPolicy,
      assertCurrent() {
        if (revoked.has(person.profileId)) {
          throw new Error("Profile access revoked");
        }
      },
      retain: () => () =>
        releaseCounts.set(person.profileId, (releaseCounts.get(person.profileId) ?? 0) + 1),
    });
  run.operatorAuthority = authority(params.owner);
  Object.assign(run.run, {
    agentId: "main",
    sessionKey: "agent:main:personal-tools",
    sessionId: "personal-tools",
    senderId: params.owner.senderId,
    senderName: params.owner.name,
    senderIsOwner: true,
    clientCaps: ["ui-commands"],
    gatewayUiCommandTarget: params.owner.gatewayUiCommandTarget,
  });
  const operation = createTestReplyOperation({
    sessionKey: run.run.sessionKey,
    sessionId: run.run.sessionId,
  });
  operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
  const runId = "personal-tool-run";
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    operatorAuthority: run.operatorAuthority,
    facts: {
      agentId: "main",
      runId,
      ingress: { kind: "system", state: "present", boundary: "personal-tool-test" },
    },
  });
  let reject = false;
  try {
    const admittedRunContext = await admission.admit("embedded", "personal-tool-test");
    return await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: run.run.sessionKey!,
        operatorAuthority: run.operatorAuthority,
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        gatewayUiCommandTarget: params.owner.gatewayUiCommandTarget,
        receiptAuthority: () => {
          admission.assertSourceCurrent();
        },
      },
      () =>
        withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          {
            ...run.run,
            runId,
            modelId: run.run.model,
            toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
            abortSignal: operation.abortSignal,
          },
          undefined,
          async (prepared) => {
            operation.attachBackend({
              kind: params.backendKind ?? "embedded",
              runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
              cancel() {},
              messageInjectionV2: {
                version: 2,
                isAvailable: () => true,
                ...(params.hiddenQuestion
                  ? {
                      claimPendingUserInputAnswer: async (
                        _text: string,
                        _options: ReplyBackendQueueMessageOptions | undefined,
                        assertCurrent: () => void,
                      ) => {
                        assertCurrent();
                        return !reject;
                      },
                    }
                  : {}),
                queueMessage: async (
                  _text: string,
                  options: ReplyBackendQueueMessageOptions | undefined,
                  assertCurrent: () => void,
                ) => {
                  assertCurrent();
                  if (params.hiddenQuestion) {
                    throw new Error("Hidden input must claim its pending question");
                  }
                  if (reject) {
                    throw new Error("Runtime declined steering");
                  }
                  options?.onQueueAccepted?.(true);
                },
              },
            });
            operation.setPhase("running");
            if (params.hiddenQuestion) {
              registerAgentRunContext(runId, {
                isControlUiVisible: false,
                projectSessionMessages: false,
              });
            }
            return await test({
              operation,
              releaseCounts,
              complete: () => operation.complete(),
              revoke: (profileId) => {
                revoked.add(profileId);
              },
              steer: async (person, options) => {
                reject = options?.reject === true;
                return await queueCurrentReplyRunMessage(run.run.sessionId, "Change my view", {
                  isInboundUserMessage: true,
                  toolAuthorityOverlay: {
                    operatorAuthority: authority(person, options?.scopes),
                    senderId: person.senderId,
                    senderName: person.name,
                    senderIsOwner: true,
                    disableTools: false,
                    traceAuthorized: false,
                    clientCaps: run.run.clientCaps,
                    gatewayUiCommandTarget: person.gatewayUiCommandTarget,
                  },
                });
              },
            });
          },
        ),
    );
  } finally {
    if (params.hiddenQuestion) {
      clearAgentRunContext(runId);
    }
    operation.complete();
    admission.close();
  }
}
