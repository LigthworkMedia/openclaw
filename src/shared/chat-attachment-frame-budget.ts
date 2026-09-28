// A chat.send frame carries attachments as base64 (4/3 expansion) plus the
// JSON envelope and message text. Advertising more than one WS frame can carry
// lets the client encode a payload the server hard-drops with 1009 for every
// pane — the exact failure the hello-ok policy exists to prevent.
const WS_FRAME_ENVELOPE_SLACK_BYTES = 256 * 1024;

export function resolveChatAttachmentFrameBudgetBytes(maxPayloadBytes: number): number {
  return Math.max(0, Math.floor(((maxPayloadBytes - WS_FRAME_ENVELOPE_SLACK_BYTES) * 3) / 4));
}
