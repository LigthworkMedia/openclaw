import {
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
} from "@openclaw/gateway-client/browser";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../../../../src/shared/regexp.js";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import {
  accumulatedStreamText,
  advanceAccumulatedStreamText,
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  streamCausalInterval,
  resolveCumulativeAssistantTail,
  type StreamCausalBoundaryState,
} from "./stream-causal-boundary.ts";
import {
  hasAssistantStreamPartReplacement,
  visibleAssistantStreamParts,
  type ToolStreamReconciliationState,
} from "./stream-reconciliation.ts";
import {
  extractToolMessageRefs,
  resolveLiveToolStreamRefs,
  resolveMatchingLiveToolIdentity,
} from "./tool-stream-identity.ts";

type AssistantMessageVisibility = (message: unknown) => boolean;
type StreamVisibility = (stream: string) => boolean;

function matchCommentaryOccurrence(source: string, text: string): RegExpExecArray | null {
  const pattern = text.split(/\s+/u).map(escapeRegExp).join("\\s+");
  const matcher = new RegExp(pattern, "gu");
  for (const match of source.matchAll(matcher)) {
    const before = source.slice(0, match.index);
    const after = source.slice(match.index + match[0].length);
    const startsItem = !before.trim() || /(?:\r?\n){2}[ \t]*$/u.test(before);
    const endsItem = !after.trim() || /^(?:[ \t]*\r?\n){2}/u.test(after);
    if (startsItem && endsItem) {
      return match;
    }
  }
  return null;
}

function matchTrailingCommentaryOccurrence(source: string, text: string): RegExpExecArray | null {
  const pattern = text.split(/\s+/u).map(escapeRegExp).join("\\s+");
  const matcher = new RegExp(pattern, "gu");
  for (const match of source.matchAll(matcher)) {
    const before = source.slice(0, match.index);
    const after = source.slice(match.index + match[0].length);
    if ((!before.trim() || /(?:\r?\n){2}[ \t]*$/u.test(before)) && !after.trim()) {
      return match;
    }
  }
  return null;
}

function commentaryProjection(text: string): string {
  return stripInlineDirectiveTagsForDelivery(text).text.replace(/\s+/gu, " ").trim();
}

function pruneAccumulatedStreamSegments(
  segments: readonly ChatStreamSegment[],
  activeRunId: string | null | undefined,
  shouldPrune: (segment: ChatStreamSegment, index: number) => boolean,
  retiredItemId?: string,
): ChatStreamSegment[] {
  return segments.flatMap((segment, index) => {
    if (!shouldPrune(segment, index)) {
      return [segment];
    }
    // Durable rows replace display, not the producer's cumulative baseline.
    // A segment owned by a different run than the active one has no future
    // deltas to trim, so retaining it would leak sibling-run state.
    const foreignRun = Boolean(segment.runId && activeRunId && segment.runId !== activeRunId);
    if (foreignRun || !streamSegmentUsesAccumulatedText(segment)) {
      return [];
    }
    if (retiredItemId && segment.cumulative && segment.itemStartOffset === undefined) {
      return [segment];
    }
    const retained = {
      ...segment,
      persisted: true as const,
      ...(retiredItemId ? { retiredItemId } : {}),
    };
    const itemPrefix =
      retiredItemId && segment.itemStartOffset
        ? segment.text.slice(0, segment.itemStartOffset)
        : "";
    const accumulatedBefore = accumulatedStreamText(segments.slice(0, index));
    const preservesNewPrefix =
      Boolean(itemPrefix) &&
      advanceAccumulatedStreamText(accumulatedBefore, itemPrefix) !== accumulatedBefore;
    return preservesNewPrefix
      ? [
          {
            text: itemPrefix,
            ts: segment.ts,
            runId: segment.runId,
            pendingCommentaryPrefixFor: retiredItemId,
          },
          retained,
        ]
      : [retained];
  });
}

export function discardStreamSegmentIndexes(
  state: StreamCausalBoundaryState,
  discardedIndexes: readonly number[],
  retiredItemId?: string,
): void {
  if (!state.chatStreamSegments || discardedIndexes.length === 0) {
    return;
  }
  const discarded = new Set(discardedIndexes);
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (_segment, index) => discarded.has(index),
    retiredItemId,
  );
}

export function reconcilePersistedAssistantStream(
  state: ToolStreamReconciliationState,
  replayedCommentaryItemId?: string,
): void {
  const runId = state.chatRunId;
  if (!runId) {
    return;
  }
  for (const segment of state.chatStreamSegments ?? []) {
    if (segment.runId !== runId || !segment.retiredItemId || !segment.pendingCommentary) {
      continue;
    }
    if (segment.pendingCommentary.requiresReplayItemId && !replayedCommentaryItemId) {
      continue;
    }
    if (
      segment.pendingCommentary.replayItemId &&
      replayedCommentaryItemId &&
      segment.pendingCommentary.replayItemId !== replayedCommentaryItemId
    ) {
      const source = state.chatStreamItemPrefix;
      if (source === undefined) {
        continue;
      }
      const settledPrefix = accumulatedStreamText(
        (state.chatStreamSegments ?? []).filter(
          (owner) => owner.retiredItemId && owner.pendingCommentary === undefined,
        ),
      );
      const searchStart = Math.max(
        segment.pendingCommentary.prefixLength,
        settledPrefix && source.startsWith(settledPrefix) ? settledPrefix.length : 0,
      );
      const tail = source.slice(searchStart);
      const match = matchCommentaryOccurrence(tail, segment.pendingCommentary.text);
      const matchEnd = match ? match.index + match[0].length : 0;
      if (!match) {
        continue;
      }
      const visiblePrefix = tail.slice(0, match.index);
      const accumulated = accumulatedStreamText(state.chatStreamSegments ?? []);
      if (
        visiblePrefix &&
        advanceAccumulatedStreamText(accumulated, visiblePrefix) !== accumulated
      ) {
        state.chatStreamSegments = [
          ...(state.chatStreamSegments ?? []),
          {
            text: visiblePrefix,
            ts: state.chatStreamStartedAt ?? segment.ts,
            runId,
            pendingCommentaryPrefixFor: segment.retiredItemId,
          },
        ];
      }
      const retiredPrefix = source.slice(0, searchStart + matchEnd);
      state.chatStreamSegments = state.chatStreamSegments?.map((owner) =>
        owner === segment ? { ...owner, text: retiredPrefix, pendingCommentary: undefined } : owner,
      );
      continue;
    }
    const handoff = retireCommentaryStream(state, {
      runId,
      itemId: segment.retiredItemId,
      text: segment.pendingCommentary.text,
      timestamp: segment.ts,
    });
    if (handoff) {
      state.chatStreamSegments = state.chatStreamSegments?.map((owner) =>
        owner.runId === runId && owner.itemId === segment.retiredItemId
          ? { ...owner, text: handoff.text }
          : owner,
      );
      if (state.chatStreamItemId === segment.retiredItemId && state.chatStream !== null) {
        state.chatStreamItemPrefix = state.chatStream;
      }
    }
  }
  const stream = state.chatStream ?? accumulatedStreamText(state.chatStreamSegments ?? []);
  if (!stream) {
    return;
  }
  const messages = (state.chatMessages ?? []).filter((message) => {
    const identity = readSessionMessageIdentity(message);
    return (
      identity?.role === "assistant" &&
      identity.id &&
      !identity.isImported &&
      identity.runId === runId &&
      !readAssistantStreamSegmentIdentity(message)
    );
  });
  const tail = resolveCumulativeAssistantTail(messages, stream, runId);
  const prefix = stream.slice(0, stream.length - (tail?.length ?? 0));
  if (!prefix) {
    return;
  }
  retireCumulativePrefix(state, runId, prefix, Date.now());
}

function retireCumulativePrefix(
  state: ToolStreamReconciliationState,
  runId: string,
  prefix: string,
  timestamp: number,
  retirement?: { itemId: string; segmentIndex?: number },
): void {
  const stream = state.chatStream ?? accumulatedStreamText(state.chatStreamSegments ?? []);
  let segments = state.chatStreamSegments ?? [];
  const accumulated = state.chatStream === null ? stream : accumulatedStreamText(segments);
  const shouldPrune = (segment: ChatStreamSegment, index: number) =>
    (!retirement || index === retirement.segmentIndex) &&
    segment.persisted !== true &&
    segment.runId === runId &&
    streamSegmentUsesAccumulatedText(segment) &&
    prefix.startsWith(segment.text);
  // Preserve renderer identity fast paths when persistence retires no segments.
  if (segments.some(shouldPrune)) {
    segments = pruneAccumulatedStreamSegments(segments, runId, shouldPrune, retirement?.itemId);
    state.chatStreamSegments = segments;
  }
  if (retirement?.itemId === state.chatStreamItemId) {
    state.chatStreamItemPrefix = prefix;
  }
  if (advanceAccumulatedStreamText(accumulated, prefix) === accumulated) {
    return;
  }
  // Persistence can overtake chat deltas. Retire only the observed cumulative
  // prefix; keep the received buffer intact so later deltas cannot restart it.
  const last = segments.at(-1);
  const extendsPersisted =
    last?.persisted &&
    last.runId === runId &&
    !last.boundaryRunId &&
    !last.toolCallId &&
    !last.retiredItemId &&
    !retirement;
  state.chatStreamSegments = [
    ...(extendsPersisted ? segments.slice(0, -1) : segments),
    {
      ...(extendsPersisted ? last : {}),
      text: prefix,
      ts: state.chatStreamStartedAt ?? timestamp,
      runId,
      persisted: true,
      ...(retirement ? { retiredItemId: retirement.itemId } : {}),
    },
  ];
}

function completePendingCommentary(
  state: ToolStreamReconciliationState,
  retired: ChatStreamSegment,
): { text: string } | null {
  const pending = retired.pendingCommentary;
  const stream = state.chatStream ?? accumulatedStreamText(state.chatStreamSegments ?? []);
  if (!pending || !stream?.startsWith(retired.text)) {
    return null;
  }
  const expectedText = pending.text;
  const rawTail = stream.slice(pending.prefixLength);
  const delivered = stripInlineDirectiveTagsForDelivery(rawTail).text;
  const projected = delivered.replace(/\s+/gu, " ").trim();
  let prefix = stream;
  let text = expectedText;
  let pendingCommentary: ChatStreamSegment["pendingCommentary"];
  if (expectedText.startsWith(projected) && projected !== expectedText) {
    pendingCommentary = { ...pending, text: expectedText };
  } else {
    // Match only this already-owned occurrence. A coalesced delta may also
    // contain new output, including another identical commentary paragraph.
    const pattern = expectedText.split(/\s+/u).map(escapeRegExp).join("\\s+");
    const match = new RegExp(`^\\s*${pattern}`, "u").exec(delivered);
    if (!match) {
      return null;
    }
    const suffix = delivered.slice(match[0].length).trimEnd();
    const source = rawTail.trimEnd();
    if (suffix && !source.endsWith(suffix)) {
      return null;
    }
    // A shorter item revision changes display, not bytes already owned by it.
    prefix = stream.slice(
      0,
      Math.max(retired.text.length, pending.prefixLength + source.length - suffix.length),
    );
    text = match[0].replace(/^(?:[ \t]*\r?\n)+/u, "").trimEnd();
  }
  state.chatStreamSegments = state.chatStreamSegments?.map((segment) => {
    if (segment === retired) {
      return { ...segment, text: prefix, pendingCommentary };
    }
    if (segment.pendingCommentaryPrefixFor === retired.retiredItemId) {
      return segment;
    }
    // A tool may have rolled the observed partial into another segment before
    // completion. It is the same cumulative occurrence, not new visible text.
    return segment.runId === retired.runId &&
      streamSegmentUsesAccumulatedText(segment) &&
      segment.text.startsWith(retired.text) &&
      prefix.startsWith(segment.text)
      ? { ...segment, persisted: true }
      : segment;
  });
  return { text };
}

/** Transfer one cumulative occurrence to its first keyed owner. */
export function retireCommentaryStream(
  state: ToolStreamReconciliationState,
  commentary: {
    runId: string;
    itemId: string;
    text: string;
    timestamp: number;
  },
): { text: string } | null {
  if (state.chatRunId !== commentary.runId) {
    return null;
  }
  const retired = state.chatStreamSegments?.find(
    (segment) => segment.runId === commentary.runId && segment.retiredItemId === commentary.itemId,
  );
  if (retired) {
    // Item revisions replace the expected text; only the observed cumulative
    // prefix must stay monotonic. Keep that update even while chat lags behind.
    const owner =
      retired.pendingCommentary && retired.pendingCommentary.text !== commentary.text
        ? { ...retired, pendingCommentary: { ...retired.pendingCommentary, text: commentary.text } }
        : retired;
    if (owner !== retired) {
      state.chatStreamSegments = state.chatStreamSegments?.map((segment) =>
        segment === retired ? owner : segment,
      );
    }
    return completePendingCommentary(state, owner);
  }
  // Only the first keyed event can acquire an unowned cumulative occurrence.
  // A later update without a pending retirement must not consume new output.
  if (
    state.chatStreamSegments?.some(
      (segment) => segment.runId === commentary.runId && segment.itemId === commentary.itemId,
    )
  ) {
    return null;
  }
  const part = visibleAssistantStreamParts(state, {
    includeCurrent: true,
    isHiddenStreamText: () => false,
  }).at(-1);
  if (
    !part ||
    (part.itemId && part.itemId !== commentary.itemId) ||
    part.runId !== commentary.runId ||
    part.boundaryRunId
  ) {
    return null;
  }
  const preceding = (state.chatStreamSegments ?? []).slice(0, part.segmentIndex);
  const prefix = accumulatedStreamText(preceding);
  const rawTail =
    prefix && part.replacementText.startsWith(prefix)
      ? part.replacementText.slice(prefix.length)
      : part.replacementText;
  const text = stripInlineDirectiveTagsForDelivery(rawTail)
    .text.replace(/^(?:[ \t]*\r?\n)+/u, "")
    .trimEnd();
  // The preamble producer flattens whitespace. Keep the cumulative formatting
  // when that exact projection identifies the same complete occurrence.
  const projectedText = text.replace(/\s+/gu, " ").trim();
  if (!text || (text !== commentary.text && projectedText !== commentary.text)) {
    if (!projectedText || !commentary.text.startsWith(projectedText)) {
      return null;
    }
    // Retire observed bytes immediately. Keep completion with the cumulative
    // owner so replacing the keyed display with history cannot lose the handoff.
    retireCumulativePrefix(state, commentary.runId, part.replacementText, commentary.timestamp, {
      itemId: commentary.itemId,
      segmentIndex: part.segmentIndex,
    });
    state.chatStreamSegments = state.chatStreamSegments?.map((segment) =>
      segment.runId === commentary.runId && segment.retiredItemId === commentary.itemId
        ? {
            ...segment,
            pendingCommentary: { text: commentary.text, prefixLength: prefix?.length ?? 0 },
          }
        : segment,
    );
    return { text: commentary.text };
  }
  retireCumulativePrefix(state, commentary.runId, part.replacementText, commentary.timestamp, {
    itemId: commentary.itemId,
    segmentIndex: part.segmentIndex,
  });
  return { text };
}

/** A durable commentary row immediately replaces its keyed live projection.
 * Waiting for terminal cleanup renders both copies throughout the active run. */
export function prunePersistedAssistantStreamSegments(
  state: ToolStreamReconciliationState,
  message: unknown,
): void {
  const identity = readAssistantStreamSegmentIdentity(message);
  if (!identity || !state.chatStreamSegments) {
    return;
  }
  const text = extractTextCached(message);
  const replacedIndexes = state.chatStreamSegments.flatMap((segment, index) => {
    const runId = normalizeOptionalString(segment.runId);
    // Client-materialized commentary can be untagged; known run ownership
    // must still prevent a reused item id from pruning a sibling run.
    const sameRun = !identity.runId || !runId || identity.runId === runId;
    return normalizeOptionalString(segment.itemId) === identity.itemId && sameRun ? [index] : [];
  });
  if (replacedIndexes.length === 0) {
    const runId = identity.runId ?? state.chatRunId;
    if (
      runId &&
      runId === state.chatRunId &&
      text &&
      !state.chatStreamSegments.some(
        (segment) => segment.runId === runId && segment.retiredItemId === identity.itemId,
      )
    ) {
      if (!state.chatStreamItemId || state.chatStreamItemId === identity.itemId) {
        const stream = state.chatStream ?? "";
        const pattern = text.split(/\s+/u).map(escapeRegExp).join("\\s+");
        const match = new RegExp(`${pattern}\\s*$`, "u").exec(stream);
        const prefix = state.chatStreamItemPrefix || (match ? stream.slice(0, match.index) : "");
        const accumulated = accumulatedStreamText(state.chatStreamSegments);
        if (prefix && advanceAccumulatedStreamText(accumulated, prefix) !== accumulated) {
          state.chatStreamSegments = [
            ...state.chatStreamSegments,
            {
              text: prefix,
              ts: state.chatStreamStartedAt ?? Date.now(),
              runId,
              pendingCommentaryPrefixFor: identity.itemId,
            },
          ];
        }
        const handoff = retireCommentaryStream(state, {
          runId,
          itemId: identity.itemId,
          text,
          timestamp: Date.now(),
        });
        if (handoff) {
          return;
        }
      }
      if (state.chatStreamItemId && state.chatStreamItemId !== identity.itemId) {
        const source = state.chatStreamItemPrefix;
        if (source === undefined) {
          return;
        }
        const accumulated = accumulatedStreamText(state.chatStreamSegments);
        const retiredPrefix = accumulatedStreamText(
          state.chatStreamSegments.filter((segment) => Boolean(segment.retiredItemId)),
        );
        const searchStart =
          retiredPrefix && source.startsWith(retiredPrefix) ? retiredPrefix.length : 0;
        const match = matchCommentaryOccurrence(source.slice(searchStart), text);
        const matchStart = match ? searchStart + match.index : 0;
        const matchEnd = match ? matchStart + match[0].length : 0;
        if (match) {
          const retirementSegmentIndex = state.chatStreamSegments.findLastIndex(
            (segment) =>
              segment.runId === runId &&
              streamSegmentUsesAccumulatedText(segment) &&
              segment.text.length >= matchEnd &&
              source.startsWith(segment.text),
          );
          const visiblePrefix = source.slice(0, matchStart);
          if (
            visiblePrefix &&
            (retirementSegmentIndex >= 0 ||
              advanceAccumulatedStreamText(accumulated, visiblePrefix) !== accumulated)
          ) {
            state.chatStreamSegments = [
              ...state.chatStreamSegments,
              {
                text: visiblePrefix,
                ts: state.chatStreamStartedAt ?? Date.now(),
                runId,
                pendingCommentaryPrefixFor: identity.itemId,
              },
            ];
          }
          retireCumulativePrefix(state, runId, source.slice(0, matchEnd), Date.now(), {
            itemId: identity.itemId,
            ...(retirementSegmentIndex >= 0 ? { segmentIndex: retirementSegmentIndex } : {}),
          });
        }
        return;
      }
      const accumulated = accumulatedStreamText(state.chatStreamSegments);
      const baseline = state.chatStream ?? accumulated ?? "";
      const segments =
        baseline && advanceAccumulatedStreamText(accumulated, baseline) !== accumulated
          ? [
              ...state.chatStreamSegments,
              {
                text: baseline,
                ts: state.chatStreamStartedAt ?? Date.now(),
                runId,
                pendingCommentaryPrefixFor: identity.itemId,
              },
            ]
          : state.chatStreamSegments;
      // Persistence arrived before this commentary occurrence reached the
      // cumulative chat stream. Roll the observed prefix into its own visible
      // segment, then keep a one-occurrence receipt anchored after that prefix.
      state.chatStreamSegments = [
        ...segments,
        {
          text: baseline,
          ts: Date.now(),
          runId,
          persisted: true,
          retiredItemId: identity.itemId,
          pendingCommentary: {
            text,
            prefixLength: baseline.length,
            replayItemId: identity.itemId,
          },
        },
      ];
    }
    return;
  }
  const currentItemText =
    state.chatStreamItemId === identity.itemId && state.chatStream
      ? state.chatStream.slice(state.chatStreamItemPrefix?.length ?? 0)
      : undefined;
  const currentItemSnapshot =
    state.chatStream &&
    currentItemText &&
    text &&
    commentaryProjection(currentItemText) === commentaryProjection(text)
      ? state.chatStream
      : undefined;
  const laterItemPrefix =
    state.chatStreamItemId && state.chatStreamItemId !== identity.itemId
      ? state.chatStreamItemPrefix
      : undefined;
  const replaced = new Set(replacedIndexes);
  state.chatStreamSegments = state.chatStreamSegments.map((segment, index) => {
    if (!replaced.has(index) || !segment.cumulative) {
      return segment;
    }
    let nextSegment = segment;
    if (laterItemPrefix && text) {
      const searchStart = segment.itemStartOffset ?? 0;
      const match = matchCommentaryOccurrence(laterItemPrefix.slice(searchStart), text);
      const matchEnd = match ? searchStart + match.index + match[0].length : 0;
      const durablePrefix = matchEnd > 0 ? laterItemPrefix.slice(0, matchEnd) : "";
      if (durablePrefix.startsWith(segment.text)) {
        nextSegment = { ...segment, text: durablePrefix };
      }
    }
    if (
      currentItemSnapshot &&
      commentaryProjection(currentItemSnapshot).startsWith(commentaryProjection(nextSegment.text))
    ) {
      nextSegment = { ...nextSegment, text: currentItemSnapshot };
    }
    if (nextSegment.itemStartOffset !== undefined) {
      return nextSegment;
    }
    const trailing = text ? matchTrailingCommentaryOccurrence(nextSegment.text, text) : null;
    if (trailing) {
      return { ...nextSegment, itemStartOffset: trailing.index };
    }
    return currentItemSnapshot ? { ...nextSegment, itemStartOffset: 0 } : nextSegment;
  });
  discardStreamSegmentIndexes(state, replacedIndexes, identity.itemId);
  const runId = identity.runId ?? state.chatRunId;
  if (
    !currentItemSnapshot &&
    runId &&
    text &&
    !state.chatStreamSegments.some(
      (segment) => segment.runId === runId && segment.retiredItemId === identity.itemId,
    )
  ) {
    const baseline = accumulatedStreamText(state.chatStreamSegments) ?? "";
    state.chatStreamSegments = [
      ...state.chatStreamSegments,
      {
        text: baseline,
        ts: Date.now(),
        runId,
        persisted: true,
        retiredItemId: identity.itemId,
        pendingCommentary: {
          text,
          prefixLength: baseline.length,
          replayItemId: identity.itemId,
          requiresReplayItemId: true,
        },
      },
    ];
  }
  if (currentItemSnapshot) {
    state.chatStreamItemPrefix = currentItemSnapshot;
  }
}

export function pruneHistoryReplacedStreamSegments(
  messages: unknown[],
  state: ToolStreamReconciliationState,
  opts: {
    isHiddenAssistantMessage: AssistantMessageVisibility;
    isHiddenStreamText: StreamVisibility;
    persistCommentary?: boolean;
  },
): boolean {
  if (!Array.isArray(state.chatStreamSegments)) {
    return false;
  }
  const replacedIndexes = new Set<number>();
  for (const part of visibleAssistantStreamParts(state, {
    includeCurrent: false,
    isHiddenStreamText: opts.isHiddenStreamText,
  })) {
    if (part.segmentIndex === undefined || (part.itemId && opts.persistCommentary !== true)) {
      continue;
    }
    const interval = streamCausalInterval(messages, part);
    if (
      hasAssistantStreamPartReplacement(
        messages,
        part,
        opts.isHiddenAssistantMessage,
        interval.start,
        interval.end,
      )
    ) {
      replacedIndexes.add(part.segmentIndex);
    }
  }
  if (replacedIndexes.size === 0) {
    return false;
  }
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (_segment, index) => replacedIndexes.has(index),
  );
  return true;
}

export function prunePersistedToolStreamMessages(
  state: ToolStreamReconciliationState,
  persistedToolIds: Set<string>,
) {
  if (persistedToolIds.size === 0) {
    return;
  }
  const liveToolRefs = resolveLiveToolStreamRefs(state);
  if (state.toolStreamById instanceof Map) {
    for (const id of persistedToolIds) {
      state.toolStreamById.delete(id);
    }
  }
  if (Array.isArray(state.toolStreamOrder)) {
    state.toolStreamOrder = state.toolStreamOrder.filter(
      (id): id is string => typeof id === "string" && !persistedToolIds.has(id),
    );
  }
  if (Array.isArray(state.chatToolMessages)) {
    state.chatToolMessages = state.chatToolMessages.filter((message) => {
      const refs = extractToolMessageRefs(message);
      return refs.every((ref) => {
        const identity = resolveMatchingLiveToolIdentity(ref, liveToolRefs);
        return identity === undefined || !persistedToolIds.has(identity);
      });
    });
  }
  if (!Array.isArray(state.chatStreamSegments)) {
    return;
  }
  let toolIndexedSegmentIndex = 0;
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (segment) => {
      if (segment.boundaryMarker === true || segment.persisted === true) {
        return false;
      }
      const explicitToolCallId = normalizeOptionalString(segment.toolCallId);
      const usesItemId = streamSegmentHasItemId(segment);
      const indexedToolRef = usesItemId ? undefined : liveToolRefs[toolIndexedSegmentIndex];
      if (!usesItemId) {
        toolIndexedSegmentIndex += 1;
      }
      const segmentRunId = normalizeOptionalString(segment.runId);
      const toolIdentity = explicitToolCallId
        ? resolveMatchingLiveToolIdentity(
            {
              id: explicitToolCallId,
              ...(segmentRunId ? { runId: segmentRunId } : {}),
            },
            liveToolRefs,
          )
        : indexedToolRef?.identity;
      return Boolean(toolIdentity && persistedToolIds.has(toolIdentity));
    },
  );
}
