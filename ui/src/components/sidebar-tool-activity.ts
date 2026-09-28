import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { AgentActivityItemSchema } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SidebarToolActivity } from "./app-sidebar-session-types.ts";
import { deriveSidebarNarrationLine } from "./sidebar-narration-line.ts";

/** Read public progress only. Null withdraws the previous matching call; undefined ignores an event. */
export function readSidebarToolActivity(
  stream: unknown,
  value: unknown,
  previous?: SidebarToolActivity,
): SidebarToolActivity | null | undefined {
  if (stream !== "tool" && stream !== "item") {
    return undefined;
  }
  const data = asNullableObjectRecord(value);
  const item = stream === "item" ? Value.Clean(AgentActivityItemSchema, { ...data }) : undefined;
  if (stream === "item" && (!Value.Check(AgentActivityItemSchema, item) || item.kind !== "tool")) {
    return undefined;
  }
  const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
  if (data?.hideFromChannelProgress === true || data?.suppressChannelProgress === true) {
    // Later tool frames may omit or contradict descriptive metadata; the
    // started call ID owns identity. The controller separately fences its run.
    return toolCallId && previous?.toolCallId === toolCallId ? null : undefined;
  }
  const name = typeof data?.name === "string" ? data.name.trim() : "";
  if (!name) {
    return undefined;
  }
  const sameCall = previous?.name === name && previous.toolCallId === toolCallId;
  const text = Value.Check(AgentActivityItemSchema, item)
    ? deriveSidebarNarrationLine(item.progressText?.trim() || "") || undefined
    : sameCall
      ? previous.text
      : undefined;
  return { name, toolCallId, text };
}
