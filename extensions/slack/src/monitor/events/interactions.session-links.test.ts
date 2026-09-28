import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext } from "./interactions.test-support.js";

const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const dispatchPluginInteractiveHandlerMock = vi.hoisted(() =>
  vi.fn(async () => ({ matched: false, handled: false, duplicate: false })),
);
vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: enqueueSystemEventMock,
}));
vi.mock("openclaw/plugin-sdk/heartbeat-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/heartbeat-runtime")>()),
  requestHeartbeat: requestHeartbeatMock,
}));
vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  createChannelInteractiveDispatcher: () => dispatchPluginInteractiveHandlerMock,
}));

let registerSlackInteractionEvents: typeof import("./interactions.js").registerSlackInteractionEvents;
describe("Slack link-only button acknowledgments", () => {
  beforeAll(async () => {
    ({ registerSlackInteractionEvents } = await import("./interactions.js"));
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { name: "current", actionId: "openclaw:reply_link:1:1", value: undefined },
    { name: "session", actionId: "openclaw:session_link", value: undefined },
    { name: "additional session", actionId: "openclaw:session_link:1", value: undefined },
    {
      name: "legacy",
      actionId: "openclaw:reply_button:1:1",
      value: "/approve req-1 allow-once",
    },
  ])("ignores $name Slack callbacks emitted for link-only reply buttons", async (testCase) => {
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const ack = vi.fn().mockResolvedValue(undefined);
    await getHandler()({
      ack,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "reply_actions",
              elements: [{ type: "button", action_id: testCase.actionId }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: testCase.actionId,
        block_id: "reply_actions",
        url: "https://example.com/app",
        ...(testCase.value ? { value: testCase.value } : {}),
        text: { type: "plain_text", text: "Launch" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });
});
