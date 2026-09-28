import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../../src/agents/internal-runtime-context.js";
import { clampText } from "../lib/format.ts";

const SIDEBAR_NARRATION_MAX_LENGTH = 120;

/** Compact the newest prose into one quiet, stable sidebar line. */
export function deriveSidebarNarrationLine(text: string): string {
  // Fences are dropped before the paragraph split, not just by the shared
  // flattener: a fenced block contains blank lines, so splitting first would
  // let code fragments become the "newest paragraph" and win the line.
  const paragraphs = text.replace(/```[\s\S]*?```/g, " ").split(/\n\s*\n/);
  let paragraph = "";
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    paragraph = flattenMarkdownToPlainText(paragraphs[index] ?? "");
    if (paragraph) {
      break;
    }
  }
  if (!paragraph) {
    return "";
  }
  const fragments = paragraph.match(/[^.!?…]+(?:[.!?…]+(?=\s|$)|$)/g);
  const newest =
    fragments?.map((fragment) => fragment.trim()).findLast((fragment) => Boolean(fragment)) ??
    paragraph;
  return clampText(newest, SIDEBAR_NARRATION_MAX_LENGTH);
}

export function trailingInternalDelimiterPrefix(text: string): string {
  const tokens = [INTERNAL_RUNTIME_CONTEXT_BEGIN, INTERNAL_RUNTIME_CONTEXT_END];
  for (
    let length = Math.min(text.length, ...tokens.map((token) => token.length - 1));
    length >= 1;
    length -= 1
  ) {
    const suffix = text.slice(-length);
    if (tokens.some((token) => token.startsWith(suffix))) {
      return suffix;
    }
  }
  return "";
}
