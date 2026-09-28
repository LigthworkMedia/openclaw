import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { AgentActivityItemSchema } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SidebarToolActivity } from "./app-sidebar-session-types.ts";
import { deriveSidebarNarrationLine } from "./sidebar-narration-line.ts";

/** Read only prepared display metadata, never raw arguments or tool output. */
export function readSidebarToolActivity(
  stream: unknown,
  value: unknown,
  previous?: SidebarToolActivity,
): SidebarToolActivity | undefined {
  if (stream !== "tool" && stream !== "item") {
    return undefined;
  }
  const data = asNullableObjectRecord(value);
  const item = stream === "item" ? Value.Clean(AgentActivityItemSchema, { ...data }) : undefined;
  if (stream === "item" && (!Value.Check(AgentActivityItemSchema, item) || item.kind !== "tool")) {
    return undefined;
  }
  const name = typeof data?.name === "string" ? data.name.trim() : "";
  if (!name || data?.hideFromChannelProgress === true || data?.suppressChannelProgress === true) {
    return undefined;
  }
  const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
  const sameCall = previous?.name === name && previous.toolCallId === toolCallId;
  const text = Value.Check(AgentActivityItemSchema, item)
    ? deriveSidebarNarrationLine(item.progressText?.trim() || item.meta?.trim() || "") || undefined
    : sameCall
      ? previous.text
      : undefined;
  return { name, toolCallId, text };
}
