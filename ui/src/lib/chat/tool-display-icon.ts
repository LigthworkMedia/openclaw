import SHARED_TOOL_DISPLAY_JSON from "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import type { IconName } from "../../components/icons.ts";

const EMOJI_ICON_MAP: Record<string, IconName> = {
  "🧩": "puzzle",
  "🛠️": "wrench",
  "🧰": "wrench",
  "📖": "fileText",
  "✍️": "edit",
  "📝": "penLine",
  "📎": "paperclip",
  "🌐": "globe",
  "📺": "monitor",
  "🧾": "fileText",
  "🔐": "settings",
  "💻": "monitor",
  "🔌": "plug",
  "💬": "messageSquare",
};

export function resolveToolDisplayIcon(name: string): IconName {
  const tools: Record<string, { emoji?: string }> = SHARED_TOOL_DISPLAY_JSON.tools;
  const spec = tools[name.trim().toLowerCase()] ?? SHARED_TOOL_DISPLAY_JSON.fallback;
  return EMOJI_ICON_MAP[spec.emoji ?? ""] ?? "puzzle";
}
