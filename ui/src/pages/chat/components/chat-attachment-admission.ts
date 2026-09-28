// All composer intake enforces per-file policy.attachments ceilings and one
// send's total maxBatchBytes, derived from policy.maxPayload. Otherwise the
// browser refuses only after encoding the batch; an oversized frame it does
// not refuse is dropped by the Gateway with 1009 for every pane. Empty files fail admission.
import { resolveChatAttachmentFrameBudgetBytes } from "../../../../../src/shared/chat-attachment-frame-budget.ts";
import type { GatewayHelloOk } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { showToast } from "../../../lib/toast.ts";
import { getChatAttachmentDataUrl } from "../attachment-payload-store.ts";

export type ChatAttachmentLimits = {
  maxBytes: number;
  maxImageBytes: number;
  maxBatchBytes: number;
};

type ChatAttachmentHelloPolicy = NonNullable<GatewayHelloOk["policy"]>;

const limitsByPolicy = new WeakMap<ChatAttachmentHelloPolicy, ChatAttachmentLimits>();

export function resolveChatAttachmentLimits(
  policy: ChatAttachmentHelloPolicy | undefined,
): ChatAttachmentLimits | undefined {
  if (!policy?.attachments) {
    return undefined;
  }
  let limits = limitsByPolicy.get(policy);
  if (!limits) {
    limits = {
      ...policy.attachments,
      maxBatchBytes: resolveChatAttachmentFrameBudgetBytes(policy.maxPayload ?? Infinity),
    };
    limitsByPolicy.set(policy, limits);
  }
  return limits;
}

function skippedFilesMessage(messageKey: string, names: readonly string[]): string {
  return t(messageKey, {
    names: names
      .slice(0, 3)
      .map((name) => (name.trim() ? name : t("chat.attachments.attachedFile")))
      .join(", "),
    more: names.length > 3 ? ` +${names.length - 3}` : "",
  });
}

export function attachmentsTooLargeMessage(names: readonly string[]): string {
  return skippedFilesMessage("chat.attachments.tooLarge", names);
}

function skippedFilesToast(messageKey: string, skipped: readonly File[]): void {
  if (skipped.length === 0) {
    return;
  }
  showToast({
    message: skippedFilesMessage(
      messageKey,
      skipped.map((file) => file.name),
    ),
  });
}

export function admitAttachmentFiles(
  candidates: readonly File[],
  limits: ChatAttachmentLimits | undefined,
  stagedBytes: number,
): File[] {
  const admitted: File[] = [];
  const empty: File[] = [];
  const oversized: File[] = [];
  let total = stagedBytes;
  for (const file of candidates) {
    if (file.size === 0) {
      empty.push(file);
    } else if (
      limits &&
      (file.size > (file.type.startsWith("image/") ? limits.maxImageBytes : limits.maxBytes) ||
        total + file.size > limits.maxBatchBytes)
    ) {
      oversized.push(file);
    } else {
      admitted.push(file);
      total += file.size;
    }
  }
  skippedFilesToast("chat.attachments.readFailed", empty);
  skippedFilesToast("chat.attachments.tooLarge", oversized);
  return admitted;
}

function attachmentBytes(attachment: ChatAttachment): number {
  const size = attachment.sizeBytes;
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) {
    return size;
  }
  const dataUrl = getChatAttachmentDataUrl(attachment);
  const payload = dataUrl?.match(/^data:[^,]*;base64,([\s\S]*)$/i)?.[1]?.replace(/\s/g, "");
  return payload
    ? Math.max(0, Math.floor((payload.length * 3) / 4) - (payload.match(/=+$/)?.[0].length ?? 0))
    : 0;
}

export function chatAttachmentBatchBytes(attachments: readonly ChatAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachmentBytes(attachment), 0);
}

export function oversizedAttachmentBatch(
  attachments: readonly ChatAttachment[],
  limits: ChatAttachmentLimits | undefined,
): ChatAttachment[] {
  if (!limits) {
    return [];
  }
  let total = 0;
  return attachments.filter((attachment) => {
    const size = attachmentBytes(attachment);
    const ceiling = attachment.mimeType.startsWith("image/")
      ? limits.maxImageBytes
      : limits.maxBytes;
    if (size > ceiling || total + size > limits.maxBatchBytes) {
      return true;
    }
    total += size;
    return false;
  });
}
