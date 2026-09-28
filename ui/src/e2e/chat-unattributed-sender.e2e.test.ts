import { writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateSelfRemovingControl,
  openSessionMenuSubmenu,
} from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Historical sender attribution" });
const sessionKey = "agent:main:dashboard:historical-sender";
const timestamp = Date.parse("2026-09-18T10:00:00Z");
const people = [
  { id: "profile-maya", name: "Maya Chen", color: "#3268ad", initials: "MC" },
  { id: "profile-jules", name: "Jules Rivera", color: "#a24b70", initials: "JR" },
].map((person) => ({
  id: person.id,
  name: person.name,
  color: person.color,
  initials: person.initials,
  identity: { type: "profile" as const, id: person.id },
  avatarUrl: "/api/users/" + person.id + "/avatar?v=1",
}));
const historicalText = "Please check the release checklist before we publish.";
const cancelledText = "Also compare the earlier build; this request was cancelled.";
const messages = [
  {
    role: "assistant",
    content: "The release checklist is ready for a shared review.",
    timestamp,
    __openclaw: { id: "review-ready", seq: 1 },
  },
  {
    role: "user",
    content: historicalText,
    timestamp: timestamp + 1_000,
    // Owner authority is not a recorded author identity.
    __openclaw: { id: "unattributed-owner", seq: 2, senderIsOwner: true },
  },
  ...people.map((person, index) => ({
    role: "user",
    content: index === 0 ? "I verified the release notes." : "I checked the build artifacts.",
    timestamp: timestamp + 2_000 + index * 1_000,
    __openclaw: {
      id: person.id + "-message",
      seq: 3 + index,
      senderId: person.id,
      senderIdentity: person.identity,
      senderName: person.name,
      senderProfileAvatarUrl: person.avatarUrl,
    },
  })),
  {
    role: "user",
    senderLabel: "Casey (123e4567-e89b-12d3-a456-426614174000)",
    content: "The archived checklist also includes accessibility checks.",
    timestamp: timestamp + 4_000,
    __openclaw: { id: "legacy-author", seq: 5 },
  },
  {
    role: "user",
    content: "Run the final checklist from the release workstation.",
    timestamp: timestamp + 5_000,
    __openclaw: {
      id: "cli-request",
      seq: 6,
      transport: { clients: [{ id: "cli", mode: "cli", displayName: "Release helper" }] },
    },
  },
  {
    role: "assistant",
    content: "The independent review found no missing checklist items.",
    timestamp: timestamp + 6_000,
    senderLabel: "Forwarded from scout",
    senderSession: { sessionKey: "agent:scout:main", agentId: "scout", label: "Scout" },
    provenance: {
      kind: "inter_session",
      sourceSessionKey: "agent:scout:main",
      sourceTool: "sessions_send",
    },
    __openclaw: { id: "scout-report", seq: 7 },
  },
];
const pending = {
  id: "cancelled-check",
  runId: "cancelled-check-run",
  acceptedAt: timestamp + 7_000,
  state: "cancelled",
  message: {
    role: "user",
    content: cancelledText,
    timestamp: timestamp + 7_000,
    __openclaw: { id: "pending:cancelled-check", senderIsOwner: true },
  },
};
const session = {
  key: sessionKey,
  sessionId: "historical-sender-session",
  kind: "direct",
  label: "Release checklist review",
  updatedAt: timestamp + 7_000,
};
const snapshot = {
  messages,
  sessionId: session.sessionId,
  sessionInfo: session,
  pendingInputs: { items: [pending], total: 1, queuedCount: 0 },
};

function userGroup(page: Page, content: string) {
  return page.locator(".chat-group.user").filter({ has: page.getByText(content, { exact: true }) });
}

async function installHistory(page: Page, viewerIndex: number | null) {
  await page.route("**/api/users/*/avatar*", async (route) => {
    const person = people.find((candidate) => route.request().url().includes(candidate.id));
    if (!person) {
      await route.fulfill({ status: 404, body: "No synthetic avatar" });
      return;
    }
    await route.fulfill({
      contentType: "image/svg+xml",
      body:
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="' +
        person.color +
        '"/><text x="32" y="40" text-anchor="middle" fill="white" font-family="sans-serif" font-size="22">' +
        person.initials +
        "</text></svg>",
    });
  });
  return installMockGateway(page, {
    sessionKey,
    featureMethods: [...defaultControlUiFeatureMethods, "chat.history"],
    sessionInfo: session,
    sessions: [session],
    historyMessages: messages,
    hasMultipleSessionSharingIdentities: true,
    presenceUsers:
      viewerIndex === null
        ? []
        : people.map((person, index) => ({
            id: person.id,
            identity: person.identity,
            name: person.name,
            avatarUrl: person.avatarUrl,
            self: index === viewerIndex,
          })),
    methodResponses: { "chat.startup": snapshot, "chat.history": snapshot },
  });
}

async function waitForHistory(page: Page) {
  await userGroup(page, cancelledText).waitFor();
  await userGroup(page, historicalText).waitFor();
}

async function captureHistory(page: Page, artifactDir: string, name: string) {
  const historical = userGroup(page, historicalText);
  await historical.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(artifactDir, name + ".png"), animations: "disabled" });
}

async function assertNeutralHistory(page: Page) {
  for (const content of [historicalText, cancelledText]) {
    const group = userGroup(page, content);
    // Soft checks retain all baseline evidence while still failing the test.
    expect.soft(await group.locator(".chat-sender-name").textContent()).toBe("User");
    expect.soft(await group.locator("img").count()).toBe(0);
    expect.soft(await group.locator("a.chat-sender-name, .chat-sender-name a").count()).toBe(0);
    expect.soft(await group.getAttribute("class")).not.toContain("chat-group--peer");
    expect
      .soft(await group.evaluate((element) => getComputedStyle(element).justifyContent))
      .toBe("end");
  }
}

async function assertSavedAuthors(page: Page, viewerIndex: number | null) {
  for (const [index, person] of people.entries()) {
    const group = page.locator(".chat-group.user").filter({
      has: page.locator('[data-entry-id="' + person.id + '-message"]'),
    });
    await expectBrowser(group.locator(".chat-sender-name")).toHaveText(person.name);
    expect((await group.getAttribute("class"))?.includes("chat-group--peer")).toBe(
      viewerIndex !== null && viewerIndex !== index,
    );
    await expectBrowser(group.locator("img.chat-avatar[src]")).toHaveCount(1);
  }
  const legacy = userGroup(page, "The archived checklist also includes accessibility checks.");
  await expectBrowser(legacy.locator(".chat-sender-name")).toHaveText("Casey");
  expect(await legacy.locator("a.chat-sender-name, .chat-sender-name a").count()).toBe(0);
  const cli = userGroup(page, "Run the final checklist from the release workstation.");
  await expectBrowser(cli.locator(".chat-message-source")).toHaveText("via CLI (Release helper)");
  expect(await cli.locator(".chat-sender-name, .chat-avatar, .chat-author-avatar").count()).toBe(0);
  const forwarded = page.locator(".chat-group--forwarded");
  await expectBrowser(forwarded.locator(".chat-reply-attribution--forwarded")).toContainText(
    "Scout",
  );
  expect(
    await forwarded.locator('.markdown-session-link[data-session-key="agent:scout:main"]').count(),
  ).toBe(1);
}

function assertExport(markdown: string) {
  const section = markdown
    .split("\n\n" + historicalText)[0]
    ?.split("\n")
    .at(-1);
  expect.soft(section).toBe("## User (2026-09-18T10:00:01.000Z)");
  expect(markdown).toContain("## Maya Chen (");
  expect(markdown).toContain("## Jules Rivera (");
  expect(markdown).toContain("## Casey (");
  expect(markdown).toContain("## Forwarded from scout (");
  expect.soft(markdown).not.toMatch(/^## You(?: |$)/m);
}

suite.define(() => {
  it("keeps the same history neutral for two signed-in viewers, reload, replies, and exports", async () => {
    const artifactDir = createControlUiE2eArtifactDir("historical-sender");
    await writeFile(
      path.join(artifactDir, "gateway-fixture.json"),
      JSON.stringify(snapshot, null, 2),
    );
    for (const [viewerIndex, person] of people.entries()) {
      await suite.withPage(
        { viewport: { width: 1280, height: 1000 }, colorScheme: "dark" },
        async ({ page, context }) => {
          await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: new URL(suite.server.baseUrl).origin,
          });
          const gateway = await installHistory(page, viewerIndex);
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await gateway.waitForRequest("chat.startup");
          await waitForHistory(page);
          await assertSavedAuthors(page, viewerIndex);
          // Capture before the expected-red attribution checks so one invocation
          // preserves both viewer identities and the corresponding mobile state.
          await captureHistory(page, artifactDir, person.id + "-desktop");
          if (viewerIndex === 0) {
            await page.setViewportSize({ width: 390, height: 844 });
            await captureHistory(page, artifactDir, person.id + "-mobile");
            await page.setViewportSize({ width: 1280, height: 1000 });
          }
          await assertNeutralHistory(page);
          await page.reload();
          await waitForHistory(page);
          await assertNeutralHistory(page);
          await assertSavedAuthors(page, viewerIndex);

          if (viewerIndex === 0) {
            const composer = page.locator(".agent-chat__composer-combobox textarea");
            await composer.fill("/export");
            const downloadPromise = page.waitForEvent("download");
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            const download = await downloadPromise;
            const stream = await download.createReadStream();
            if (!stream) {
              throw new Error("Expected a Markdown download stream");
            }
            const downloaded = await text(stream);
            await writeFile(path.join(artifactDir, "download.md"), downloaded);
            assertExport(downloaded);
            const row = page.locator(
              '.sidebar-recent-session[data-session-key="' + sessionKey + '"]',
            );
            await row.click({ button: "right" });
            await openSessionMenuSubmenu(page, "Copy");
            const copy = page.locator("openclaw-session-menu").getByRole("menuitem", {
              name: "Conversation as Markdown",
              exact: true,
            });
            await copy.click({ trial: true });
            await activateSelfRemovingControl(copy);
            await expectBrowser(page.locator(".app-toast")).toContainText("Copied");
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            assertExport(copied);
            expect(copied).toBe(downloaded);
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);

            const historical = userGroup(page, historicalText);
            await historical.hover();
            await historical.getByRole("button", { name: "Reply to message", exact: true }).click();
            const preview = page.locator(".chat-reply-preview").filter({
              has: page.getByRole("button", { name: "Cancel reply", exact: true }),
            });
            await expectBrowser(preview.locator(".chat-reply-preview__text")).toHaveText(
              historicalText,
            );
            expect
              .soft((await preview.locator(".chat-reply-preview__label").textContent())?.trim())
              .toBe("Replying to User");
            await gateway.deferNext("chat.send");
            const localText = "I will verify the final checklist today.";
            await composer.fill(localText);
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            const request = await gateway.waitForRequest("chat.send");
            expect(request.params).toMatchObject({
              sessionKey,
              message: localText,
              replyToId: "unattributed-owner",
            });
            const local = userGroup(page, localText);
            await expectBrowser(local.locator(".chat-sender-name")).toHaveText(person.name);
            await expectBrowser(local.locator("img.chat-avatar[src]")).toHaveCount(1);
            expect(await local.getAttribute("class")).not.toContain("chat-group--peer");
          }
        },
      );
    }
    expect(snapshot.messages[1]?.["__openclaw"]).toEqual({
      id: "unattributed-owner",
      seq: 2,
      senderIsOwner: true,
    });
    expect(pending.message["__openclaw"]).toEqual({
      id: "pending:cancelled-check",
      senderIsOwner: true,
    });
  });

  it("does not assign a historical author when no viewer identity is available", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await installHistory(page, null);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("chat.startup");
        await waitForHistory(page);
        await assertNeutralHistory(page);
        await assertSavedAuthors(page, null);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
