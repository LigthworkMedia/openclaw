import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

type MeetingStatusPreludeParams = Parameters<
  typeof MeetingPlatformAdapter.createStatusPreludeSource
>[0];

export function slackHuddleStatusPreludeSource(params: MeetingStatusPreludeParams): string {
  return MeetingPlatformAdapter.createStatusPreludeSource(params, {
    controlLookupSource: `const findTextButton = (root, pattern) => [...(root?.querySelectorAll("button") || [])]
    .find((button) => !button.disabled && pattern.test(text(button)));
  const unavailable = (node) => !node || node.disabled || node.getAttribute?.("aria-disabled") === "true";`,
    lifecycleSource: `const continueInBrowser = undefined;
  const preview = firstRaw(selectors.preview);
  const join = first(selectors.join) || findTextButton(preview, /^join huddle$/i);
  const leave = first(selectors.leave);
  const inCallControl = leave || firstRaw(selectors.inCall);
  const huddleSurfaces = selectors.huddleSurfaces.flatMap((selector) => [...document.querySelectorAll(selector)])
    .filter((node) => node.isConnected !== false && !node.hidden && node.getAttribute?.("hidden") === null &&
      node.getAttribute?.("aria-hidden") !== "true" && node.getClientRects?.().length !== 0);
  const huddleText = huddleSurfaces.map(text).join(" ");
  const lobbyWaiting = huddleSurfaces.some((root) => findTextButton(root, /^request to join$/i)) ||
    /waiting (?:for .* )?(?:to (?:join|let you in)|for approval)|request (?:has been )?sent/i.test(huddleText);
  const sameRecordedIdentity = priorMeeting?.identity === expectedIdentity;
  let slackClientPage = false;
  try {
    const currentUrl = new URL(location.href);
    slackClientPage = currentUrl.protocol === "https:" && currentUrl.hostname === "app.slack.com" &&
      /^\\/client\\//.test(currentUrl.pathname);
  } catch {}
  // Channel-qualified routes verify themselves; channel-less routes retain only a live recorded control.
  const identityPreservedInCall = Boolean(!currentIdentity && slackClientPage && sameRecordedIdentity &&
    inCallControl && inCallControl.isConnected !== false && (
      priorMeeting.inCallControl === inCallControl &&
        (priorMeeting.inCallUrl === location.href || meetingIdentity(priorMeeting.inCallUrl) === expectedIdentity)
    ));
  const identityAwaitingRerender = false;
  const identityVerified = identityVerifiedBeforeCall || identityPreservedInCall;
  const confirmation = firstRaw(selectors.confirmation);
  const multiDevice = firstRaw(selectors.multiDevice);
  // Slack keeps a huddle running while the client shows other channels, so the URL names the viewed
  // channel, not the huddle behind the toolbar. The viewed channel's header carries Slack's own
  // in-this-huddle state; the join marker only covers views that do not render that header.
  const viewingExpectedChannel = Boolean(slackClientPage && currentIdentity === expectedIdentity);
  const channelHeaderInHuddle = viewingExpectedChannel && Boolean(firstRaw(selectors.channelHeaderInHuddle));
  const channelHeaderForeign = viewingExpectedChannel && !channelHeaderInHuddle &&
    Boolean(firstRaw(selectors.channelHeader));
  const pendingJoin = Boolean(sameRecordedIdentity && priorMeeting.joinRequested === true);
  // A recorded control vouches only for itself; a re-rendered replacement needs the header state.
  const ownsActiveHuddle = channelHeaderInHuddle || (!channelHeaderForeign && sameRecordedIdentity && Boolean(
    (priorMeeting.inCallControl && priorMeeting.inCallControl === inCallControl) ||
    pendingJoin || priorMeeting.awaitingAdmission === true));
  const inCall = Boolean(identityVerified && inCallControl && !preview && !confirmation && !multiDevice &&
    ownsActiveHuddle);
  if (canMutateSession && identityVerified && meetingOwnerConflict) adoptAudioBridgeSourcesForSession();
  if (canMutateSession && !inCall) retireOwnedAudioBridges();
  if (canMutateSession && identityVerified) {
    window.__openclawSlackHuddle = {
      ...(sameRecordedIdentity && !meetingOwnerConflict ? priorMeeting : {}),
      identity: expectedIdentity,
      sessionId: sessionId || priorMeeting?.sessionId,
      verifiedAt: Date.now(),
      // A confirmed call retires join/admission evidence; later ownership rests on the recorded call.
      ...(inCall
        ? { inCallControl, inCallUrl: location.href, joinRequested: false, awaitingAdmission: false }
        : {}),
      ...(!inCall && lobbyWaiting && !inCallControl ? { awaitingAdmission: true } : {}),
      ...(!inCall && inCallControl && (confirmation || multiDevice)
        ? { joinRequested: false, inCallControl: undefined, awaitingAdmission: false }
        : {}),
    };
  } else if (canMutateSession && priorMeeting && !currentIdentity && !lobbyWaiting) {
    delete window.__openclawSlackHuddle;
  }
  const microphone = preview ? first(selectors.previewMicrophone) : first(selectors.microphone);
  const readMicrophone = () => {
    const current = preview ? first(selectors.previewMicrophone) : first(selectors.microphone);
    return toggleState(current, "microphone") || (!preview && (
      firstWithin(current, selectors.mutedIcon) ? "off" :
      firstWithin(current, selectors.unmutedIcon) ? "on" : undefined
    ));
  };
  let microphoneState = identityVerified ? readMicrophone() : undefined;
  const camera = document.querySelector('button[role="switch"][aria-label="Camera"]');
  let cameraState = identityVerified ? (toggleState(camera, "camera") || (!camera ? "off" : undefined)) : undefined;
  const { isVirtualAudioDevice, selectedMicrophoneLabel } = meetingAudioInput;
  let audioInputRouted;
  let audioInputDeviceLabel;
  let audioInputRouteError;
  if (identityVerified && allowMicrophone) {
    audioInputDeviceLabel = selectedMicrophoneLabel();
    audioInputRouted = Boolean(audioInputDeviceLabel);
  }
  let manualAction;
  const hostname = location.hostname.toLowerCase();
  const loginPage = (hostname === "slack.com" || /^[a-z0-9-]+\\.slack\\.com$/.test(hostname)) &&
    /^\\/(?:signin|workspace-signin|get-started|check-login|ssb\\/signin)(?:\\/|$)/i.test(location.pathname);
  let microphonePermissionState;
  if (allowMicrophone && navigator.permissions?.query) {
    try { microphonePermissionState = (await navigator.permissions.query({ name: "microphone" })).state; } catch {}
  }
  if (committedOwnerConflict && !canMutateSession) {
    manualAction = manualActionFor("slack-session-conflict", "This Slack tab is owned by another active huddle session.");
  } else if (!inCall && (loginPage || firstRaw(selectors.signIn))) {
    manualAction = manualActionFor("slack-login-required", "Sign the OpenClaw Chrome profile into Slack as the claw's Slack account, then retry.");
  } else if (!inCall && inCallControl && !confirmation && !multiDevice && !pendingJoin) {
    manualAction = manualActionFor("slack-session-conflict", "This Slack account is already in another huddle in this browser. Leave that huddle, then retry.");
  } else if (multiDevice) {
    manualAction = manualActionFor("slack-session-conflict", "This Slack account is already in a huddle on another device. Resolve the Slack device prompt, then retry.");
  } else if (confirmation) {
    manualAction = manualActionFor("slack-confirmation-required", "Complete the Slack confirmation, then retry: " + text(confirmation));
  } else if (!inCall && lobbyWaiting) {
    manualAction = manualActionFor("slack-admission-required", "Request to join this huddle in Slack and wait for admission, then retry status.");
  } else if (!inCall && join && /^start huddle$/i.test(text(join))) {
    manualAction = manualActionFor("slack-huddle-not-active", "No one is in this huddle yet. Start the huddle in Slack, then ask again.");
  } else if ((allowMicrophone && (microphonePermissionState === "denied" || microphonePermissionState === "prompt")) ||
    (!inCall && /allow (?:slack (?:to )?)?(?:access to |use (?:your )?)?(?:the |your )?microphone|microphone permission/i.test(huddleText))) {
    manualAction = manualActionFor("slack-permission-required", "Allow Slack microphone permission in the OpenClaw Chrome profile, then retry.");
  }
  const ownsCameraScope = inCall || Boolean(preview);
  if (canMutateSession && identityVerified && ownsCameraScope && !manualAction && cameraState === "on" && !unavailable(camera)) {
    camera.click();
    await waitForUi();
    cameraState = toggleState(document.querySelector('button[role="switch"][aria-label="Camera"]'), "camera");
  }
  if (canMutateSession && identityVerified && inCall && allowMicrophone && !audioInputRouted && !manualAction) {
    if (microphoneState === "on" && !unavailable(microphone)) {
      microphone.click();
      await waitForUi();
      microphoneState = readMicrophone();
    }
    const audioSettings = first(selectors.deviceSettings);
    if (!unavailable(audioSettings)) {
      audioSettings.click();
      await waitForUi();
      const choice = selectors.audioDeviceOptions.flatMap((selector) => [...document.querySelectorAll(selector)])
        .find((node) => isVirtualAudioDevice(text(node)) && !unavailable(node));
      if (choice) {
        clickable(choice)?.click?.();
        await waitForUi();
      }
      audioInputDeviceLabel = selectedMicrophoneLabel();
      audioInputRouted = Boolean(audioInputDeviceLabel);
    }
  }
  if (canMutateSession && identityVerified && !manualAction && (inCall || (autoJoin && join && /^join huddle$/i.test(text(join))))) {
    // Join muted until Slack reports the virtual input; the host's physical microphone must never go live.
    const desiredMicrophoneState = allowMicrophone && audioInputRouted ? "on" : "off";
    if (microphoneState !== desiredMicrophoneState && microphoneState && !unavailable(microphone)) {
      microphone.click();
      await waitForUi();
      microphoneState = readMicrophone();
    }
    if (microphoneState !== desiredMicrophoneState) {
      manualAction = manualActionFor("slack-microphone-required", !allowMicrophone
        ? "Turn off the Slack huddle microphone for observe-only mode, then retry."
        : desiredMicrophoneState === "on"
          ? "Turn on the Slack huddle microphone, then retry."
          : "Mute the Slack huddle microphone until the OpenClaw virtual microphone is selected, then retry.");
    }
  }
  if (identityVerified && ownsCameraScope && cameraState !== "off" && !manualAction) {
    manualAction = manualActionFor("slack-camera-required", "Turn off the Slack huddle camera, then retry.");
  }
  let clickedJoin = false;
  if (canMutateSession && identityVerified && autoJoin && !inCall && !manualAction &&
      !unavailable(join) && /^join huddle$/i.test(text(join))) {
    window.__openclawSlackHuddle.joinRequested = true;
    join.click();
    clickedJoin = true;
    notes.push("Clicked Join Huddle for an active Slack huddle.");
  }`,
    manualActionSource: "",
    platform: {
      displayName: "Slack huddle",
      globals: {
        audioOutputs: "__openclawSlackHuddleAudioOutputs",
        captionArchive: "__openclawSlackHuddleCaptionArchive",
        captions: "__openclawSlackHuddleCaptions",
        meeting: "__openclawSlackHuddle",
      },
      manualActionReasonPrefix: "slack",
    },
  });
}
