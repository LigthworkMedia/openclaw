export function makeMessageToolPolicyJob(
  delivery: Record<string, unknown> = { mode: "none" },
  payload: Record<string, unknown> = { kind: "agentTurn", message: "send a message" },
) {
  return {
    id: "message-tool-policy",
    name: "Message Tool Policy",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload,
    delivery,
  } as never;
}

export function makeAnnounceMessageToolJob(
  options: {
    id?: string;
    name?: string;
    delivery?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  } = {},
) {
  return {
    id: options.id ?? "message-tool-policy",
    name: options.name ?? "Message Tool Policy",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "send a message", ...options.payload },
    delivery: { mode: "announce", channel: "messagechat", to: "123", ...options.delivery },
  } as never;
}

export function makeAnnounceDeliveryPlan(overrides: Record<string, unknown> = {}) {
  return {
    requested: true,
    mode: "announce",
    channel: "messagechat",
    to: "123",
    ...overrides,
  };
}

export function makeResolvedAnnounceTarget(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    channel: "messagechat",
    to: "123",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
    ...overrides,
  };
}
