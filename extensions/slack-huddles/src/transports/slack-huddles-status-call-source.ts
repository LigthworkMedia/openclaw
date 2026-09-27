import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

export function slackHuddleStatusCallSource(): string {
  return MeetingPlatformAdapter.createStatusCallSource({
    platform: {
      audioOutputElementIdPrefix: "openclaw-slack-huddle-audio-output-",
      displayName: "Slack huddle",
      globals: {
        audioOutputs: "__openclawSlackHuddleAudioOutputs",
        captions: "__openclawSlackHuddleCaptions",
        meeting: "__openclawSlackHuddle",
      },
      manualActionReasonPrefix: "slack",
    },
    captionEnableSource: `if (inCall && captureCaptions && !captionsEnabledNow) {
      notes.push("Slack captions are off or not visible. Enable the Slack preference to turn on captions by default when joining huddles.");
    }`,
    // Title and participants are global huddle UI; report them only for the verified huddle.
    extraResultSource: `meetingTitle: inCall ? text(firstRaw(selectors.title)) || undefined : undefined,
    participantCount: inCall
      ? new Set(selectors.participants.flatMap((selector) => [...document.querySelectorAll(selector)])).size
      : undefined,`,
  });
}
