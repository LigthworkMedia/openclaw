import {
  createMeetingBrowserAudioCaptureSource,
  type MeetingBrowserAudioCaptureRequest,
  createMeetingLeaveSource,
  createMeetingTranscriptSource,
} from "openclaw/plugin-sdk/meeting-page-script-runtime";
import { SLACK_HUDDLE_SELECTORS } from "./slack-huddles-selectors.js";
import { slackHuddleStatusCallSource } from "./slack-huddles-status-call-source.js";
import { slackHuddleStatusPreludeSource } from "./slack-huddles-status-prejoin-source.js";
import { normalizeSlackHuddleUrlForReuse } from "./slack-huddles-urls.js";

function pageIdentityFunctionSource(): string {
  const ownershipHooks = JSON.stringify({
    header: SLACK_HUDDLE_SELECTORS.channelHeader,
    inHuddle: SLACK_HUDDLE_SELECTORS.channelHeaderInHuddle,
    inCall: SLACK_HUDDLE_SELECTORS.inCall,
  });
  // Status, audio capture, captions, and leave all resolve ownership through this identity.
  return `const meetingIdentity = (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || url.port || url.username || url.password ||
          !/^[a-z0-9-]+\\.slack\\.com$/i.test(url.hostname)) return undefined;
      const match = url.pathname.match(/^\\/huddle\\/(?:[TE][A-Z0-9]{8,}\\/)?([CGD][A-Z0-9]{8,})\\/?$/) ||
        (url.hostname === "app.slack.com" && url.pathname.match(/^\\/client\\/[TE][A-Z0-9]{8,}\\/([CGD][A-Z0-9]{8,})(?:\\/.*)?$/));
      const identity = match ? "slack-huddle:" + match[1] : undefined;
      if (!identity || rawUrl !== location.href) return identity;
      // The URL names only the viewed channel. A live call while that channel's header says this device
      // is outside its huddle belongs to another huddle, unless this session's Join is still settling.
      const hooks = ${ownershipHooks};
      const found = (list) => list.some((selector) => document.querySelector(selector));
      const marker = window.__openclawSlackHuddle;
      const settlingJoin = marker?.identity === identity && marker.joinRequested === true;
      return found(hooks.header) && !found(hooks.inHuddle) && found(hooks.inCall) && !settlingJoin
        ? "slack-huddle-foreign:" + match[1]
        : identity;
    } catch { return undefined; }
  };`;
}

export function slackHuddleAudioCaptureScript(params: MeetingBrowserAudioCaptureRequest): string {
  return createMeetingBrowserAudioCaptureSource({
    ...params,
    audioOutputsGlobal: "__openclawSlackHuddleAudioOutputs",
    ownershipSource: `
      ${pageIdentityFunctionSource()}
      const expectedIdentity = ${JSON.stringify(normalizeSlackHuddleUrlForReuse(params.meetingUrl))};
      const state = window.__openclawSlackHuddle;
      return Boolean(expectedIdentity && state?.sessionId === sessionId &&
        state.identity === expectedIdentity && !state.leavePending &&
        meetingIdentity(location.href) === expectedIdentity);
    `,
  });
}

export function slackHuddleStatusScript(params: {
  allowMicrophone: boolean;
  allowSessionAdoption: boolean;
  autoJoin: boolean;
  captureCaptions: boolean;
  guestName: string;
  meetingSessionId?: string;
  meetingUrl: string;
  readOnly?: boolean;
  waitForInCallMs: number;
}) {
  return (
    slackHuddleStatusPreludeSource({
      ...params,
      expectedIdentity: normalizeSlackHuddleUrlForReuse(params.meetingUrl),
      pageIdentitySource: pageIdentityFunctionSource(),
      selectors: JSON.stringify(SLACK_HUDDLE_SELECTORS),
      toggleStateFunction: `(input) => {
      if (input?.ariaChecked === "true") return "on";
      if (input?.ariaChecked === "false") return "off";
      if (/^unmute microphone(?: unmute microphone)?$/i.test(input?.label || "")) return "off";
      if (/^mute microphone(?: mute microphone)?$/i.test(input?.label || "")) return "on";
      return undefined;
    }`,
    }) + slackHuddleStatusCallSource()
  );
}

export function slackHuddleTranscriptScript(
  meetingUrl: string,
  meetingSessionId: string,
  finalize: boolean,
) {
  return createMeetingTranscriptSource({
    expectedIdentity: normalizeSlackHuddleUrlForReuse(meetingUrl),
    finalize,
    globals: {
      captionArchive: "__openclawSlackHuddleCaptionArchive",
      captions: "__openclawSlackHuddleCaptions",
      meeting: "__openclawSlackHuddle",
    },
    meetingSessionId,
    pageIdentitySource: pageIdentityFunctionSource(),
    platformDisplayName: "Slack huddle",
  });
}

export function slackHuddleLeaveScript(params: {
  leaveInitiated: boolean;
  meetingSessionId: string;
  meetingUrl: string;
}) {
  return createMeetingLeaveSource({
    // Leave buttons are global; only Slack's header state or this session's join marker authorizes them.
    controlSource: `const firstMatch = (list) => list.map((selector) => document.querySelector(selector)).find(Boolean);
  const viewingExpectedChannel = Boolean(expectedIdentity && currentIdentity === expectedIdentity &&
    /^\\/client\\//.test(location.pathname));
  const headerInHuddle = viewingExpectedChannel && Boolean(firstMatch(selectors.channelHeaderInHuddle));
  const headerForeign = viewingExpectedChannel && !headerInHuddle && Boolean(firstMatch(selectors.channelHeader));
  const switchPrompt = Boolean(firstMatch(selectors.confirmation) || firstMatch(selectors.multiDevice));
  // Only an established call authorizes Leave: Slack's header state or the live control this session recorded.
  const ownsHuddle = !switchPrompt && (headerInHuddle || (!headerForeign && state?.identity === expectedIdentity &&
    Boolean(state.inCallControl && state.inCallControl.isConnected !== false &&
      selectors.inCall.some((selector) => document.querySelector(selector) === state.inCallControl))));
  const leave = ownsHuddle ? firstMatch(selectors.leave) : undefined;
  const confirmation = undefined;
  const inCallMarker = selectors.inCall.some((selector) => document.querySelector(selector)) && !headerForeign;
  const currentUrlMatches = Boolean(expectedIdentity && currentIdentity === expectedIdentity);`,
    departedMarkerSource: "!inCallMarker",
    expectedIdentity: normalizeSlackHuddleUrlForReuse(params.meetingUrl),
    leaveInitiated: params.leaveInitiated,
    meetingSessionId: params.meetingSessionId,
    meetingStateSource: "sessionId: expectedSessionId || state?.sessionId,",
    pageIdentitySource: pageIdentityFunctionSource(),
    platform: {
      displayName: "Slack huddle",
      globals: {
        audioOutputs: "__openclawSlackHuddleAudioOutputs",
        meeting: "__openclawSlackHuddle",
      },
    },
    selectors: JSON.stringify(SLACK_HUDDLE_SELECTORS),
    sessionMatchSource: `const sessionMatched = !enforceSessionOwnership ||
      state?.sessionId === expectedSessionId ||
      (!state?.sessionId && currentIdentity === expectedIdentity && (!state?.identity || state.identity === expectedIdentity));`,
  });
}
