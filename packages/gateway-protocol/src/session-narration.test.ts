import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionNarrationEventSchema,
  SessionsMessagesSubscribeParamsSchema,
} from "./schema/sessions.js";

describe("session narration protocol", () => {
  it.each([
    [{ key: "agent:main:work" }, true],
    [{ key: "agent:main:work", mode: "narration" }, true],
    [{ key: "agent:main:work", mode: "narration", includeApprovals: true }, true],
    [{ key: "agent:main:work", mode: "full" }, false],
    [{ key: "agent:main:work", mode: true }, false],
  ])("validates the optional narration intent: %j", (params, valid) => {
    expect(Value.Check(SessionsMessagesSubscribeParamsSchema, params)).toBe(valid);
  });

  it("bounds digest text while requiring the session and run identity", () => {
    const digest = {
      sessionKey: "agent:main:work",
      agentId: "main",
      runId: "run-1",
      text: "x".repeat(16384),
    };
    expect(Value.Check(SessionNarrationEventSchema, digest)).toBe(true);
    expect(Value.Check(SessionNarrationEventSchema, { ...digest, text: "" })).toBe(true);
    expect(Value.Check(SessionNarrationEventSchema, { ...digest, text: `${digest.text}x` })).toBe(
      false,
    );
    expect(Value.Check(SessionNarrationEventSchema, { ...digest, runId: "" })).toBe(false);
    expect(Value.Check(SessionNarrationEventSchema, { ...digest, sessionKey: "" })).toBe(false);
  });
});
