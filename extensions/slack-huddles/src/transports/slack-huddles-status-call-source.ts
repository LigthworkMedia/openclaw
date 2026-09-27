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
    extraResultSource: `meetingTitle: text(firstRaw(selectors.title)) || undefined,
    participantCount: new Set(selectors.participants.flatMap((selector) => [...document.querySelectorAll(selector)])).size,`,
  });
}
