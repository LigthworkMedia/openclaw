/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { buildPendingInputItems } from "../chat-pending-inputs.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { buildChatMarkdown } from "../export.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { createReplyPreviewResolver, type LoadedReplySource } from "./chat-reply-preview.ts";
import { projectTranscriptChain, projectTranscriptIndex } from "./chat-transcript-message-index.ts";

const viewers = [
  { userId: "profile-alex", userName: "Alex Viewer", userAvatar: "AV" },
  { userId: "profile-maya", userName: "Maya Viewer", userAvatar: "MV" },
  { userId: null, userName: null, userAvatar: null },
];
const containers: HTMLElement[] = [];
const source = (fields: Record<string, unknown> = {}) => ({
  role: "user",
  content: "Please review the release fixes.",
  timestamp: 1_000,
  ...fields,
});

function groupFor(message: unknown): MessageGroup {
  const [group] = groupMessages([{ kind: "message", key: "saved-input", message }]);
  if (group?.kind !== "group") {
    throw new Error("Expected a visible input group");
  }
  return group;
}

function renderGroup(
  group: MessageGroup,
  options: Partial<Parameters<typeof renderMessageGroup>[1]> = {},
) {
  const container = document.createElement("div");
  containers.push(container);
  render(
    renderMessageGroup(group, {
      showReasoning: false,
      showToolCalls: true,
      showOwnSenderName: false,
      ...options,
    }),
    container,
  );
  return container;
}

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
  }
  vi.restoreAllMocks();
});

describe("historical sender attribution", () => {
  it.each([
    { name: "legacy message", message: source() },
    { name: "owner-only input", message: source({ __openclaw: { senderIsOwner: true } }) },
    {
      name: "imported message",
      message: source({ __openclaw: { mirrorOrigin: "fixture-catalog-import" } }),
    },
  ])("does not make a $name belong to any viewer or change its saved bytes", ({ message }) => {
    const saved = JSON.stringify(message);
    const group = groupFor(message);
    for (const viewer of viewers) {
      for (const avatarPlacement of ["gutter", "footer", "none"] as const) {
        const container = renderGroup(group, { ...viewer, avatarPlacement });
        expect(container.querySelector(".chat-sender-name")?.textContent).toBe("User");
        expect(container.querySelector("a.chat-sender-name, img, .chat-author-avatar")).toBeNull();
        expect(container.textContent).not.toContain("Viewer");
        expect(container.textContent).not.toContain("AV");
        expect(container.textContent).not.toContain("MV");
        expect(container.querySelector(".chat-group.user.chat-group--peer")).toBeNull();
        expect(container.querySelector(".chat-text")?.textContent).toContain(message.content);
      }
    }
    expect(JSON.stringify(message)).toBe(saved);
    expect(normalizeMessage(message).sender).toBeUndefined();
  });

  it.each([
    { name: "saved label", fields: { senderLabel: "Original Author" }, label: "Original Author" },
    {
      name: "saved name",
      fields: { __openclaw: { senderName: "Original Author" } },
      label: "Original Author",
    },
    {
      name: "saved username",
      fields: { __openclaw: { senderUsername: "original-author" } },
      label: "original-author",
    },
    {
      name: "unqualified matching ID",
      fields: { __openclaw: { senderId: "profile-alex" } },
      label: "profile-alex",
    },
    {
      name: "malformed profile",
      fields: {
        __openclaw: {
          senderId: "profile-alex",
          senderName: "Original Author",
          senderIdentity: { type: "profile", id: "profile-alex", extra: true },
        },
      },
      label: "Original Author",
    },
    {
      name: "channel observation with a matching ID",
      fields: {
        __openclaw: {
          senderId: "profile-alex",
          senderName: "Channel Author",
          senderIdentity: {
            type: "observation",
            pluginId: "discord",
            accountId: "work",
            senderKind: "human",
            id: "profile-alex",
          },
        },
      },
      label: "Channel Author",
    },
  ])("retains $name without promoting it to the viewer's profile", ({ fields, label }) => {
    const message = source(fields);
    const saved = JSON.stringify(message);
    for (const viewer of viewers) {
      const container = renderGroup(groupFor(message), { ...viewer, avatarPlacement: "gutter" });
      expect(container.querySelector(".chat-sender-name")?.textContent).toBe(label);
      expect(container.querySelector("a.chat-sender-name, img")).toBeNull();
      expect(container.textContent).not.toContain("Viewer");
    }
    expect(JSON.stringify(message)).toBe(saved);
  });

  it("keeps qualified own/peer identity, including the unknown-viewer alignment contract", () => {
    const message = source({
      __openclaw: {
        senderId: "profile-alex",
        senderName: "Recorded Alex",
        senderIdentity: { type: "profile", id: "profile-alex" },
      },
    });
    const group = groupFor(message);
    for (const [index, viewer] of viewers.entries()) {
      const container = renderGroup(group, {
        ...viewer,
        showOwnSenderName: true,
        personActivity: { basePath: "", navigate: vi.fn() },
      });
      expect(container.querySelector(".chat-sender-name")?.textContent).toBe(
        index === 0 ? "Alex Viewer" : "Recorded Alex",
      );
      expect(Boolean(container.querySelector(".chat-group--peer"))).toBe(index === 1);
      expect(Boolean(container.querySelector("a.chat-sender-name"))).toBe(index === 1);
    }
    expect(renderGroup(group, viewers[0]).querySelector(".chat-sender-name")).toBeNull();
  });

  it.each(["queued", "interrupted", "cancelled"] as const)(
    "keeps a retained %s input neutral through its regular history rendering path",
    (state) => {
      const message = source({ __openclaw: { senderIsOwner: true } });
      const saved = JSON.stringify(message);
      const items = buildPendingInputItems([
        { id: "accepted", runId: "run", state, acceptedAt: 1_000, message },
      ]);
      const group = groupMessages(items).find((item) => item.kind === "group");
      if (!group || group.kind !== "group") {
        throw new Error("Expected retained input to remain visible");
      }
      const container = renderGroup(group, viewers[0]);
      expect(container.querySelector(".chat-sender-name")?.textContent).toBe("User");
      expect(container.textContent).not.toContain("Alex Viewer");
      expect(JSON.stringify(message)).toBe(saved);
    },
  );

  it.each(["loaded", "fetched"] as const)(
    "keeps %s reply previews and reply actions independent of the viewer",
    (location) => {
      const message = source({ __openclaw: { id: "original", senderIsOwner: true } });
      const group = groupFor(message);
      const chain = projectTranscriptChain([group], {
        sessionKey: "agent:main:historical",
        runWorking: false,
        searchActive: false,
        stream: null,
      });
      const expanded = new Map<string, boolean>();
      for (const viewer of viewers) {
        const props = { ...viewer, assistantName: "OpenClaw" };
        const loaded =
          location === "loaded"
            ? projectTranscriptIndex(chain, expanded, props).loadedReplySources
            : new Map<string, LoadedReplySource>();
        const resolve = createReplyPreviewResolver(loaded, {
          ...props,
          replyMessageAccess: {
            revision: 0,
            navigationId: null,
            read: () => message,
            request: () => undefined,
            open: () => undefined,
          },
        });
        expect(resolve("original")).toMatchObject({ senderLabel: "User", text: message.content });
        const onReply = vi.fn();
        const container = renderGroup(group, { ...viewer, onReply });
        container.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')?.click();
        expect(onReply).toHaveBeenCalledWith(
          expect.objectContaining({ senderLabel: "User", text: message.content }),
        );
      }
    },
  );

  it("exports legacy unknown authors without inventing You or rewriting original content", () => {
    const messages = [
      source({ __openclaw: { senderIsOwner: true } }),
      source({ senderLabel: "Original Author" }),
    ];
    const saved = JSON.stringify(messages);
    const markdown = buildChatMarkdown(messages, "OpenClaw");
    expect(markdown).toContain("## User (1970-01-01T00:00:01.000Z)");
    expect(markdown).toContain("## Original Author (1970-01-01T00:00:01.000Z)");
    expect(markdown).not.toContain("## You");
    expect(JSON.stringify(messages)).toBe(saved);
  });
});
