import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import { makeClaudeUsageLimitQueryFactory } from "./claudeUsageLimitQuery.ts";

async function* onePrompt(): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    session_id: "fixture-session",
    parent_tool_use_id: null,
    message: { role: "user", content: "trigger the fixture" },
  } as SDKUserMessage;
}

describe("Claude usage-limit dev query", () => {
  it("rejects the first turn and resumes natively without another prompt", async () => {
    const createQuery = makeClaudeUsageLimitQueryFactory({ resetDelayMs: 0 });
    const first = createQuery({
      prompt: onePrompt(),
      options: { sessionId: "fixture-session" } as Options,
    });
    const firstMessages = [];
    for await (const message of first) firstMessages.push(message);

    expect(firstMessages.map((message) => message.type)).toEqual([
      "system",
      "rate_limit_event",
      "result",
    ]);
    expect(firstMessages[1]).toMatchObject({
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
    });

    const resumed = createQuery({
      prompt: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined),
        }),
      },
      options: {
        resume: "fixture-session",
        env: {
          CLAUDE_CODE_RETRY_WATCHDOG: "1",
          CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
        },
      } as Options,
    });
    const resumedMessages = [];
    for await (const message of resumed) resumedMessages.push(message);

    expect(resumedMessages.map((message) => message.type)).toEqual([
      "system",
      "rate_limit_event",
      "assistant",
      "result",
    ]);
    expect(resumedMessages[1]).toMatchObject({ rate_limit_info: { status: "allowed" } });
  });
});
