import { describe, expect, it } from "vitest";
import { SLACK_HUDDLES_PLATFORM_ADAPTER } from "./slack-huddles-platform-adapter.js";
import {
  CLIENT_URL,
  fixture,
  microphone,
  page,
  PageNode,
  qaNode,
} from "./slack-huddles-platform-adapter.test-helpers.js";

function preview(label: string, micOn = false, fallback = false) {
  const join = fallback
    ? new PageNode("button", {}, label)
    : qaNode("huddle_join_preview_modal_go", label);
  const mic = microphone(micOn, true);
  const modal = qaNode("huddle_join_preview_modal", "", "div").append(mic, join);
  return { document: page(modal), join, mic };
}

/** An in-call page; `member` renders Slack's header proof that this device is in the channel's huddle. */
function inCall(
  marker = qaNode("huddle_toolbar__leave_button", "Leave Huddle"),
  micOn = false,
  member = true,
) {
  const mic = microphone(micOn);
  const nodes = member ? [marker, mic, channelHeader(true)] : [marker, mic];
  return { document: page(...nodes), marker, mic };
}

function channelHeader(inHuddle: boolean) {
  const classes = ["p-huddle_channel_header_button__container"];
  if (inHuddle) {
    classes.push("p-huddle_channel_header_button--in_huddle");
  }
  return new PageNode("div", {
    class: classes.join(" "),
    "data-qa": "huddle_channel_header_button",
  });
}

function classify(result: Record<string, unknown>) {
  const health = SLACK_HUDDLES_PLATFORM_ADAPTER.browser.parseStatus({
    result: JSON.stringify(result),
  });
  if (!health) {
    throw new Error("Expected parsed Slack huddle status");
  }
  return SLACK_HUDDLES_PLATFORM_ADAPTER.browser.classifyManualAction(health);
}

describe("Slack huddle browser adapter", () => {
  it.each([
    "https://slack.com/signin",
    "https://workspace.slack.com/workspace-signin",
    "https://slack.com/ssb/signin",
  ])("reports signed-out redirect %s", async (currentUrl) => {
    const result = await fixture({ document: page(), currentUrl }).status();
    expect(result).toMatchObject({ inCall: false, clickedJoin: false });
    expect(classify(result)).toEqual({
      category: "login-required",
      reason: "slack-login-required",
      message:
        "Sign the OpenClaw Chrome profile into Slack as the claw's Slack account, then retry.",
    });
  });

  it("detects a sign-in form even when Slack retains the huddle URL", async () => {
    const document = page(
      new PageNode("form", { action: "/signin" }).append(new PageNode("input", { name: "email" })),
    );
    expect(classify(await fixture({ document }).status())).toMatchObject({
      reason: "slack-login-required",
    });
  });

  it("refuses Start Huddle without touching the preview controls", async () => {
    const { document, join, mic } = preview("Start Huddle", true);
    const result = await fixture({ document }).status();
    expect(result).toMatchObject({
      clickedJoin: false,
      manualAction: {
        reason: "slack-huddle-not-active",
        message: "No one is in this huddle yet. Start the huddle in Slack, then ask again.",
      },
    });
    expect(join.clicks).toBe(0);
    expect(mic.clicks).toBe(0);
  });

  it.each([
    { mode: "agent" as const, initial: true, virtual: false, target: false },
    { mode: "bidi" as const, initial: true, virtual: false, target: false },
    { mode: "agent" as const, initial: false, virtual: true, target: true },
    { mode: "transcribe" as const, initial: true, virtual: true, target: false },
  ])(
    "joins $mode with the preview microphone $target when virtual input is $virtual",
    async ({ mode, initial, virtual, target }) => {
      const { document, join, mic } = preview("Join Huddle", initial);
      if (virtual) {
        document.body.append(new PageNode("div", { id: "microphone-info" }, "BlackHole 2ch"));
      }
      let microphoneAtJoin: string | null = null;
      join.onClick = () => {
        microphoneAtJoin = mic.getAttribute("aria-checked");
      };
      const result = await fixture({ document }).status({ mode });
      expect(result.clickedJoin).toBe(true);
      expect(join.clicks).toBe(1);
      expect(mic.clicks).toBe(1);
      expect(microphoneAtJoin).toBe(String(target));
    },
  );

  it("uses the exact Join Huddle text fallback only inside the preview", async () => {
    const { document, join } = preview("Join Huddle", false, true);
    const unrelated = new PageNode("button", {}, "Join Huddle");
    document.body.append(unrelated);
    await fixture({ document }).status();
    expect(join.clicks).toBe(1);
    expect(unrelated.clicks).toBe(0);
  });

  it("leaves the preview unchanged when autoJoin is disabled", async () => {
    const { document, join, mic } = preview("Join Huddle", true);
    expect(await fixture({ document }).status({ autoJoin: false })).toMatchObject({
      clickedJoin: false,
    });
    expect(join.clicks).toBe(0);
    expect(mic.clicks).toBe(0);
  });

  it("does not join when Slack disables the microphone needed for the requested mode", async () => {
    const { document, join, mic } = preview("Join Huddle", true);
    mic.setAttribute("aria-disabled", "true");
    expect(await fixture({ document }).status()).toMatchObject({
      clickedJoin: false,
      manualAction: { reason: "slack-microphone-required" },
    });
    expect(mic.clicks).toBe(0);
    expect(join.clicks).toBe(0);
  });

  it.each(["huddle_join_modal", "huddle_in_thread_speed_bump_modal"])(
    "requires manual confirmation for %s",
    async (qa) => {
      const { document, join } = preview("Join Huddle");
      const confirm = qaNode("huddle_join_modal_go", "OK");
      document.body.append(qaNode(qa, "Switch huddles?", "div").append(confirm));
      const result = await fixture({ document }).status();
      expect(classify(result)).toMatchObject({
        category: "custom",
        reason: "slack-confirmation-required",
        message: expect.stringContaining("Switch huddles?"),
      });
      expect(confirm.clicks).toBe(0);
      expect(join.clicks).toBe(0);
    },
  );

  it.each(["huddle_multi_device_modal_switch_device", "huddle_multi_device_modal_use_both_device"])(
    "requires manual resolution of %s",
    async (qa) => {
      const control = qaNode(qa, "Switch to this device");
      expect(classify(await fixture({ document: page(control) }).status())).toMatchObject({
        category: "session-conflict",
        reason: "slack-session-conflict",
      });
      expect(control.clicks).toBe(0);
    },
  );

  it("retains a request awaiting admission and adopts the admitted client page", async () => {
    const request = new PageNode("button", {}, "Request to join");
    const document = page(new PageNode("div", { role: "dialog" }).append(request));
    const browser = fixture({ document });
    expect(classify(await browser.status())).toMatchObject({
      category: "admission-required",
      reason: "slack-admission-required",
    });
    expect(request.clicks).toBe(0);
    document.body.children.splice(0);
    document.body.append(
      qaNode("huddle_toolbar__leave_button", "Leave Huddle"),
      microphone(false),
      channelHeader(true),
    );
    browser.location.href = CLIENT_URL;
    expect(await browser.status()).toMatchObject({ inCall: true, micMuted: true });
  });

  it.each(["agent", "transcribe"] as const)(
    "reports the browser microphone permission prompt in %s mode without joining",
    async (mode) => {
      const { document, join } = preview("Join Huddle");
      document.body.append(
        new PageNode("div", { role: "dialog" }, "Allow Slack to use your microphone"),
      );
      expect(classify(await fixture({ document }).status({ mode }))).toMatchObject({
        category: "permission-required",
        reason: "slack-permission-required",
      });
      expect(join.clicks).toBe(0);
    },
  );

  it.each([
    ["huddle_toolbar__leave_button", "button"],
    ["huddle_mini_player_leave_button", "button"],
    ["huddle_sidebar_footer", "div"],
    ["huddle_toolbar_buttons_center", "div"],
  ])("recognizes %s as an in-call marker and verifies observe-only mute", async (qa, tag) => {
    const { document, mic } = inCall(qaNode(qa, "", tag), true);
    expect(await fixture({ document, joined: true }).status()).toMatchObject({
      inCall: true,
      micMuted: true,
    });
    expect(mic.clicks).toBe(1);
  });

  it.each([true, false])(
    "reads the Microphone switch aria-checked=%s without mutation",
    async (on) => {
      const { document, mic } = inCall(undefined, on);
      expect(await fixture({ document, joined: true }).status({ readOnly: true })).toMatchObject({
        inCall: true,
        micMuted: !on,
      });
      expect(mic.clicks).toBe(0);
    },
  );

  it("keeps huddle ownership through a Slack SPA URL rewrite and rejects a different channel view", async () => {
    const { document, marker } = inCall();
    const browser = fixture({ document, joined: true });
    expect(await browser.status()).toMatchObject({ inCall: true });
    browser.location.href = CLIENT_URL;
    expect(await browser.status()).toMatchObject({ inCall: true });
    expect(browser.window).toMatchObject({
      __openclawSlackHuddle: { identity: "slack-huddle:C0123ABCD", inCallUrl: CLIENT_URL },
    });
    browser.location.href = "https://app.slack.com/client/T0123ABCD/C9999ABCD";
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-session-conflict" },
    });
    expect(marker.clicks).toBe(0);
  });

  it("does not declare the huddle ended during a temporary toolbar rerender", async () => {
    const { document, marker } = inCall(undefined, false, false);
    document.body.append(channelHeader(true));
    const browser = fixture({ document, currentUrl: CLIENT_URL, joined: true });
    expect(await browser.status()).toMatchObject({ inCall: true });
    marker.isConnected = false;
    document.body.children.splice(document.body.children.indexOf(marker), 1);
    const interrupted = await browser.status();
    expect(interrupted.inCall).toBe(false);
    expect(interrupted.meetingEnded).not.toBe(true);
    document.body.append(qaNode("huddle_toolbar__leave_button", "Leave Huddle"));
    expect(await browser.status()).toMatchObject({ inCall: true });
  });

  it.each(["huddle_toolbar__leave_button", "huddle_mini_player_leave_button"])(
    "leaves through %s and reports departure while the root audio element remains",
    async (qa) => {
      const leave = qaNode(qa, "Leave Huddle");
      const audio = qaNode("p-huddle_audio", "", "audio");
      const endAll = qaNode("huddle_toolbar__end_huddle_for_all_menu_item", "End huddle for all");
      const header = channelHeader(true);
      const document = page(leave, audio, endAll, microphone(false), header);
      const browser = fixture({ document, joined: true });
      await browser.status();
      browser.location.href = CLIENT_URL;
      await browser.status();
      expect(browser.leave()).toMatchObject({ departed: false, leaveAction: "leave" });
      expect(leave.clicks).toBe(1);
      expect(endAll.clicks).toBe(0);
      leave.isConnected = false;
      document.body.children.splice(document.body.children.indexOf(leave), 1);
      expect(browser.leave(true)).toMatchObject({ departed: false });
      header.attributes.class = "p-huddle_channel_header_button__container";
      expect(browser.leave(true)).toMatchObject({ departed: true });
      expect(endAll.clicks).toBe(0);
    },
  );

  it.each([undefined, CLIENT_URL])(
    "does not adopt another huddle's controls while viewing this channel at %s",
    async (currentUrl) => {
      const { document, marker } = inCall(undefined, false, false);
      const result = await fixture({ document, currentUrl }).status({ readOnly: false });
      expect(result).toMatchObject({ inCall: false });
      expect(marker.clicks).toBe(0);
    },
  );

  it("drops a pending Join that met a switch prompt beside another huddle's toolbar", async () => {
    const active = preview("Join Huddle");
    const browser = fixture({ document: active.document });
    expect(await browser.status()).toMatchObject({ clickedJoin: true });
    active.document.body.children.splice(0);
    const confirm = qaNode("huddle_join_modal", "Switch huddles?", "div");
    active.document.body.append(qaNode("huddle_toolbar__leave_button", "Leave Huddle"), confirm);
    browser.location.href = CLIENT_URL;
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-confirmation-required" },
    });
    active.document.body.children.splice(active.document.body.children.indexOf(confirm), 1);
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-session-conflict" },
    });
  });

  it("completes its own Join into in-call controls", async () => {
    const active = preview("Join Huddle");
    const browser = fixture({ document: active.document });
    expect(await browser.status()).toMatchObject({ clickedJoin: true });
    active.document.body.children.splice(0);
    active.document.body.append(
      qaNode("huddle_toolbar__leave_button", "Leave Huddle"),
      microphone(false),
      channelHeader(true),
    );
    browser.location.href = CLIENT_URL;
    expect(await browser.status()).toMatchObject({ inCall: true });
  });

  it("does not join or touch the camera while another huddle is live in the tab", async () => {
    const active = preview("Join Huddle");
    const camera = new PageNode("button", {
      role: "switch",
      "aria-label": "Camera",
      "aria-checked": "true",
    });
    active.document.body.append(qaNode("huddle_toolbar__leave_button", "Leave Huddle"), camera);
    const result = await fixture({ document: active.document }).status();
    expect(result).toMatchObject({ manualAction: { reason: "slack-session-conflict" } });
    expect(result.clickedJoin).not.toBe(true);
    expect(active.join.clicks).toBe(0);
    expect(camera.clicks).toBe(0);
  });

  it("adopts the huddle from Slack's own channel-header state without a join marker", async () => {
    const { document } = inCall(undefined, false, false);
    document.body.append(channelHeader(true));
    const result = await fixture({ document, currentUrl: CLIENT_URL }).status({ readOnly: true });
    expect(result).toMatchObject({ inCall: true });
  });

  it("does not claim or leave another huddle when the channel header says this device is elsewhere", async () => {
    const { document, marker } = inCall(undefined, false, false);
    document.body.append(channelHeader(false));
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: {
        __openclawSlackHuddle: {
          identity: "slack-huddle:C0123ABCD",
          sessionId: "session-1",
          inCallControl: marker,
        },
      },
    });
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-session-conflict" },
    });
    expect(browser.leave()).toMatchObject({ departed: false, sessionMatched: false });
    expect(marker.clicks).toBe(0);
  });

  it("waits through the header lag right after its own Join click", async () => {
    const active = preview("Join Huddle");
    const browser = fixture({ document: active.document });
    expect(await browser.status()).toMatchObject({ clickedJoin: true });
    active.document.body.children.splice(0);
    const header = channelHeader(false);
    active.document.body.append(
      qaNode("huddle_toolbar__leave_button", "Leave Huddle"),
      microphone(false),
      header,
    );
    browser.location.href = CLIENT_URL;
    const lagging = await browser.status();
    expect(lagging.inCall).toBe(false);
    expect(lagging.manualAction).toBeUndefined();
    header.attributes.class += " p-huddle_channel_header_button--in_huddle";
    expect(await browser.status()).toMatchObject({ inCall: true });
  });

  it("does not record admission while another huddle's toolbar is live", async () => {
    const request = new PageNode("button", {}, "Request to join");
    const document = page(
      qaNode("huddle_toolbar__leave_button", "Leave Huddle"),
      new PageNode("div", { role: "dialog" }).append(request),
    );
    const browser = fixture({ document });
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-session-conflict" },
    });
    document.body.children.splice(1);
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-session-conflict" },
    });
    expect(request.clicks).toBe(0);
  });

  it("reports a later move to another huddle as a conflict after its own join settled", async () => {
    const active = preview("Join Huddle");
    const browser = fixture({ document: active.document });
    await browser.status();
    active.document.body.children.splice(0);
    const header = channelHeader(true);
    active.document.body.append(
      qaNode("huddle_toolbar__leave_button", "Leave Huddle"),
      microphone(false),
      header,
    );
    browser.location.href = CLIENT_URL;
    expect(await browser.status()).toMatchObject({ inCall: true });
    header.attributes.class = "p-huddle_channel_header_button__container";
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-session-conflict" },
    });
  });

  it("does not attribute a replacement toolbar to a stale recorded control without Slack's header state", async () => {
    const stale = qaNode("huddle_toolbar__leave_button", "Leave Huddle");
    stale.isConnected = false;
    const { document } = inCall(undefined, false, false);
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: {
        __openclawSlackHuddle: {
          identity: "slack-huddle:C0123ABCD",
          sessionId: "session-1",
          inCallControl: stale,
        },
      },
    });
    expect(await browser.status({ readOnly: true })).toMatchObject({ inCall: false });
  });

  it("refuses Leave while a pending Join faces a switch prompt beside another huddle", async () => {
    const leave = qaNode("huddle_toolbar__leave_button", "Leave Huddle");
    const document = page(leave, qaNode("huddle_join_modal", "Switch huddles?", "div"));
    const browser = fixture({ document, currentUrl: CLIENT_URL, joined: true });
    expect(browser.leave()).toMatchObject({ departed: false });
    expect(leave.clicks).toBe(0);
  });

  it("does not treat the root audio element as a call and still joins an active preview", async () => {
    const document = page(qaNode("p-huddle_audio", "", "audio"));
    const browser = fixture({ document });
    expect(await browser.status()).toMatchObject({ inCall: false });
    const active = preview("Join Huddle");
    document.body.append(...active.document.body.children);
    expect(await browser.status()).toMatchObject({ inCall: false, clickedJoin: true });
    expect(active.join.clicks).toBe(1);
  });

  it.each([
    ["waiting for approval; request sent", "div"],
    ["Allow Slack to use your microphone", "div"],
    ["Request to join", "button"],
  ])("ignores channel message content %s when classifying huddle prompts", async (content, tag) => {
    const { document, join } = preview("Join Huddle");
    document.body.append(
      new PageNode("div", { "data-qa": "message_container" }).append(
        new PageNode(tag, {}, content),
      ),
    );
    const result = await fixture({ document }).status();
    expect(result).toMatchObject({ clickedJoin: true });
    expect(result.manualAction).toBeUndefined();
    expect(join.clicks).toBe(1);
  });

  it.each([CLIENT_URL, `${CLIENT_URL}/thread/C0123ABCD-123`])(
    "joins the expected channel after a boot-time rewrite to %s",
    async (currentUrl) => {
      const { document, join } = preview("Join Huddle");
      expect(await fixture({ document, currentUrl }).status()).toMatchObject({ clickedJoin: true });
      expect(join.clicks).toBe(1);
    },
  );

  it.each([
    "https://app.slack.com/client/T0123ABCD/C9999ABCD",
    "https://app.slack.com/huddle/T0123ABCD/c0123abcd",
    "https://app.slack.com/huddle/t0123abcd/C0123ABCD",
  ])("does not join an unowned or malformed channel page %s", async (currentUrl) => {
    const { document, join } = preview("Join Huddle");
    const result = await fixture({ document, currentUrl }).status();
    expect(result.inCall).toBe(false);
    expect(result.clickedJoin).not.toBe(true);
    expect(join.clicks).toBe(0);
  });

  it("captures caption speaker siblings and nested newest words once, then finalizes the transcript", async () => {
    const speaker = new PageNode(
      "span",
      { class: "p-huddle_closed_caption_event__member_name" },
      "Morgan:",
    );
    const words = new PageNode(
      "span",
      {
        "data-qa": "huddle_closed_caption_event",
        class: "p-huddle_closed_caption_event__transcription",
      },
      "The next step ",
    ).append(
      new PageNode(
        "span",
        { class: "p-huddle_closed_caption_event__transcription_new" },
        "is ready.",
      ),
    );
    const caption = new PageNode("div").append(
      speaker,
      new PageNode("div", { class: "p-huddle_closed_caption_event__event_text" }).append(words),
    );
    const { document } = inCall();
    document.body.append(caption);
    const browser = fixture({ document, joined: true });
    expect(await browser.status({ captureCaptions: true })).toMatchObject({
      captioning: true,
      transcriptLines: 1,
      recentTranscript: [{ speaker: "Morgan:", text: "The next step is ready." }],
    });
    words.textContent = "The next step is ready. Let's begin.";
    browser.mutate();
    expect(browser.transcript(true)).toMatchObject({
      lines: [{ speaker: "Morgan:", text: "The next step is ready. Let's begin." }],
      sessionMatched: true,
      urlMatched: true,
    });
  });

  it("captures audio only while Slack's header shows this device in the requested huddle", async () => {
    const { document } = inCall(undefined, false, false);
    const header = channelHeader(true);
    document.body.append(header);
    const browser = fixture({ document, currentUrl: CLIENT_URL, joined: true });
    expect(await browser.status()).toMatchObject({ inCall: true });
    await expect(browser.startAudioCapture()).rejects.toThrow("audio capture passed ownership");
    header.attributes.class = "p-huddle_channel_header_button__container";
    await expect(browser.startAudioCapture()).rejects.toThrow("no longer owns");
  });

  it("never lets a settling Join marker unlock audio without Slack's membership header", async () => {
    const { document } = inCall(undefined, false, false);
    document.body.append(channelHeader(false));
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: {
        __openclawSlackHuddle: {
          identity: "slack-huddle:C0123ABCD",
          sessionId: "session-1",
          joinRequested: true,
          joinRequestedAt: Date.now(),
        },
      },
    });
    expect(await browser.status({ readOnly: true })).toMatchObject({ inCall: false });
    await expect(browser.startAudioCapture()).rejects.toThrow("no longer owns");
  });

  it("fails closed on a reused toolbar this session recorded when Slack's header is not rendered", async () => {
    const { document, marker } = inCall(undefined, false, false);
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: {
        __openclawSlackHuddle: {
          identity: "slack-huddle:C0123ABCD",
          sessionId: "session-1",
          inCallControl: marker,
          inCallUrl: CLIENT_URL,
        },
      },
    });
    expect(await browser.status({ readOnly: true })).toMatchObject({ inCall: false });
    expect(browser.leave()).toMatchObject({ departed: false });
    expect(marker.clicks).toBe(0);
    await expect(browser.startAudioCapture()).rejects.toThrow("no longer owns");
  });

  it("stops collecting captions when Slack's membership header disappears during a call", async () => {
    const speaker = new PageNode(
      "span",
      { class: "p-huddle_closed_caption_event__member_name" },
      "Morgan:",
    );
    const words = new PageNode(
      "span",
      {
        "data-qa": "huddle_closed_caption_event",
        class: "p-huddle_closed_caption_event__transcription",
      },
      "Owned huddle line.",
    );
    const caption = new PageNode("div").append(
      speaker,
      new PageNode("div", { class: "p-huddle_closed_caption_event__event_text" }).append(words),
    );
    const { document } = inCall(undefined, false, false);
    const header = channelHeader(true);
    document.body.append(header, caption);
    const browser = fixture({ document, currentUrl: CLIENT_URL, joined: true });
    expect(await browser.status({ captureCaptions: true })).toMatchObject({ transcriptLines: 1 });
    document.body.children.splice(document.body.children.indexOf(header), 1);
    words.textContent = "Unverified huddle line.";
    browser.mutate();
    expect(JSON.stringify(browser.transcript())).not.toContain("Unverified huddle line.");
  });

  it("stops collecting captions when both Slack's header and call controls disappear", async () => {
    const words = new PageNode(
      "span",
      {
        "data-qa": "huddle_closed_caption_event",
        class: "p-huddle_closed_caption_event__transcription",
      },
      "Owned huddle line.",
    );
    const caption = new PageNode("div").append(
      new PageNode("span", { class: "p-huddle_closed_caption_event__member_name" }, "Morgan:"),
      new PageNode("div", { class: "p-huddle_closed_caption_event__event_text" }).append(words),
    );
    const { document, marker } = inCall(undefined, false, false);
    const header = channelHeader(true);
    document.body.append(header, caption);
    const browser = fixture({ document, currentUrl: CLIENT_URL, joined: true });
    expect(await browser.status({ captureCaptions: true })).toMatchObject({ transcriptLines: 1 });
    for (const node of [header, marker]) {
      document.body.children.splice(document.body.children.indexOf(node), 1);
    }
    words.textContent = "Unverified huddle line.";
    browser.mutate();
    expect(JSON.stringify(browser.transcript())).not.toContain("Unverified huddle line.");
  });

  it("does not report departure while this session's Join is still settling", async () => {
    const { document, marker } = inCall(undefined, false, false);
    document.body.append(channelHeader(false));
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: {
        __openclawSlackHuddle: {
          identity: "slack-huddle:C0123ABCD",
          sessionId: "session-1",
          joinRequested: true,
          joinRequestedAt: Date.now(),
        },
      },
    });
    expect(browser.leave()).toMatchObject({ departed: false });
    expect(marker.clicks).toBe(0);
  });

  it("stops collecting captions when the account moves to another huddle on the same channel view", async () => {
    const speaker = new PageNode(
      "span",
      { class: "p-huddle_closed_caption_event__member_name" },
      "Morgan:",
    );
    const words = new PageNode(
      "span",
      {
        "data-qa": "huddle_closed_caption_event",
        class: "p-huddle_closed_caption_event__transcription",
      },
      "Owned huddle line.",
    );
    const caption = new PageNode("div").append(
      speaker,
      new PageNode("div", { class: "p-huddle_closed_caption_event__event_text" }).append(words),
    );
    const { document } = inCall(undefined, false, false);
    const header = channelHeader(true);
    document.body.append(header, caption);
    const browser = fixture({ document, currentUrl: CLIENT_URL, joined: true });
    expect(await browser.status({ captureCaptions: true })).toMatchObject({ transcriptLines: 1 });
    header.attributes.class = "p-huddle_channel_header_button__container";
    words.textContent = "Foreign huddle line.";
    browser.mutate();
    const transcript = browser.transcript();
    expect(JSON.stringify(transcript)).not.toContain("Foreign huddle line.");
  });

  it("captures huddle_transcribe_event and reports unavailable captions without clicking menus", async () => {
    const { document } = inCall();
    const menu = new PageNode("button", { "aria-label": "More" }, "More");
    document.body.append(menu);
    const browser = fixture({ document, joined: true });
    expect(await browser.status({ captureCaptions: true })).toMatchObject({
      captioning: false,
      notes: expect.arrayContaining([expect.stringMatching(/captions.*preference/i)]),
    });
    expect(menu.clicks).toBe(0);
    document.body.append(
      qaNode("huddle_transcribe_event", "Caption from the alternate surface", "div"),
    );
    expect(await browser.status({ captureCaptions: true })).toMatchObject({
      captioning: true,
      recentTranscript: [{ text: "Caption from the alternate surface" }],
    });
    expect(browser.transcript()).toMatchObject({
      lines: [{ text: "Caption from the alternate surface" }],
    });
  });
});

it("selects and verifies the virtual microphone before enabling in-call talk-back", async () => {
  const { document, mic } = inCall(undefined, true);
  const selected = new PageNode("div", { id: "microphone-info" }, "Built-in Microphone");
  const settings = qaNode("huddle-toolbar-mic-popover-button", "");
  const choice = qaNode("av-microphone-device-menu-item_BlackHole 2ch", "BlackHole 2ch");
  const micStates: Array<string | null> = [];
  settings.onClick = () => {
    micStates.push(mic.getAttribute("aria-checked"));
    document.body.append(choice);
  };
  choice.onClick = () => {
    selected.textContent = "BlackHole 2ch";
  };
  document.body.append(selected, settings);
  const result = await fixture({ document, joined: true }).status({ mode: "agent" });
  expect(micStates).toEqual(["false"]);
  expect(settings.clicks).toBe(1);
  expect(choice.clicks).toBe(1);
  expect(result).toMatchObject({ audioInputRouted: true, micMuted: false });
});

it("stops routing clicks when Slack's membership header vanishes during an awaited step", async () => {
  const { document, mic } = inCall(undefined, true);
  const header = document.body.children.find((node) =>
    (node.attributes.class ?? "").includes("p-huddle_channel_header_button--in_huddle"),
  );
  const settings = qaNode("huddle-toolbar-mic-popover-button", "");
  document.body.append(
    new PageNode("div", { id: "microphone-info" }, "Built-in Microphone"),
    settings,
  );
  const toggleMicrophone = mic.onClick;
  mic.onClick = () => {
    toggleMicrophone?.();
    if (header) {
      header.attributes.class = "p-huddle_channel_header_button__container";
    }
  };
  await fixture({ document, joined: true }).status({ mode: "agent" });
  expect(mic.clicks).toBe(1);
  expect(settings.clicks).toBe(0);
});

it("does not click Join when another call appears while the preview microphone settles", async () => {
  const { document, join, mic } = preview("Join Huddle", true);
  const toggleMicrophone = mic.onClick;
  mic.onClick = () => {
    toggleMicrophone?.();
    document.body.append(qaNode("huddle_toolbar__leave_button", "Leave Huddle"));
  };
  const result = await fixture({ document }).status({ mode: "agent" });
  expect(mic.clicks).toBe(1);
  expect(join.clicks).toBe(0);
  expect(result.clickedJoin).not.toBe(true);
});

it("stops before Join and reports a switch prompt that appears while the preview settles", async () => {
  const { document, join, mic } = preview("Join Huddle", true);
  const toggleMicrophone = mic.onClick;
  mic.onClick = () => {
    toggleMicrophone?.();
    document.body.append(qaNode("huddle_join_modal", "Switch huddles?", "div"));
  };
  const result = await fixture({ document }).status({ mode: "agent" });
  expect(join.clicks).toBe(0);
  expect(result).toMatchObject({ manualAction: { reason: "slack-confirmation-required" } });
});

it("omits another huddle's title and participants while membership is unverified", async () => {
  const { document } = inCall(undefined, false, false);
  document.body.append(
    qaNode("huddle_window_titlebar_title", "Other team huddle"),
    qaNode("huddle_avatar_stack__member", ""),
  );
  const result = await fixture({
    document,
    currentUrl: CLIENT_URL,
    window: {
      __openclawSlackHuddle: {
        identity: "slack-huddle:C0123ABCD",
        sessionId: "session-1",
        joinRequested: true,
        joinRequestedAt: Date.now(),
      },
    },
  }).status({ readOnly: true });
  expect(result.inCall).toBe(false);
  expect(result.meetingTitle).toBeUndefined();
  expect(result.participantCount).toBeUndefined();
});

it("does not mistake an available virtual microphone for Slack's selected input", async () => {
  const { document } = inCall(undefined, true);
  document.body.append(
    new PageNode("div", { id: "microphone-info" }, "Built-in Microphone"),
    qaNode("av-microphone-device-menu-item_BlackHole 2ch", "BlackHole 2ch"),
  );
  const result = await fixture({ document, joined: true }).status({
    mode: "agent",
    readOnly: true,
  });
  expect(result).toMatchObject({
    audioInputRouted: false,
    manualAction: { reason: "slack-audio-choice-required" },
  });
});

it.each(["Mute microphone", "Unmute microphone"])(
  "reads the alternate %s control",
  async (label) => {
    const mic = new PageNode("button", {
      "data-qa": "segmented-mute-button-main",
      "aria-label": label,
    });
    const document = page(qaNode("huddle_toolbar__leave_button"), mic, channelHeader(true));
    expect(await fixture({ document, joined: true }).status({ readOnly: true })).toMatchObject({
      inCall: true,
      micMuted: label === "Unmute microphone",
    });
  },
);
