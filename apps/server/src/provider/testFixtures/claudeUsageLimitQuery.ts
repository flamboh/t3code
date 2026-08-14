// @effect-diagnostics globalDate:off -- This dev fixture simulates the external Claude harness clock.
// @effect-diagnostics globalTimers:off -- Only the fixture simulates Claude's wait; production uses the native watchdog.
import type {
  Options,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

interface FixtureQueryInput {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}

interface FixtureQuery extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
}

interface UsageLimitFixtureState {
  readonly resetsAt: number;
}

function initMessage(sessionId: string, model: string | undefined): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "usage-limit-fixture",
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: model ?? "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    session_id: sessionId,
    uuid: `fixture-init-${sessionId}`,
  } as unknown as SDKMessage;
}

class ClaudeUsageLimitFixtureQuery implements FixtureQuery {
  readonly #input: FixtureQueryInput;
  readonly #sessionId: string;
  readonly #state: Map<string, UsageLimitFixtureState>;
  readonly #resetDelayMs: number;
  readonly #closedListeners = new Set<() => void>();
  #closed = false;

  constructor(input: {
    readonly query: FixtureQueryInput;
    readonly sessionId: string;
    readonly state: Map<string, UsageLimitFixtureState>;
    readonly resetDelayMs: number;
  }) {
    this.#input = input.query;
    this.#sessionId = input.sessionId;
    this.#state = input.state;
    this.#resetDelayMs = input.resetDelayMs;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    yield initMessage(this.#sessionId, this.#input.options.model);

    const nativeResume =
      this.#input.options.resume === this.#sessionId &&
      this.#input.options.env?.CLAUDE_CODE_RETRY_WATCHDOG === "1" &&
      this.#input.options.env?.CLAUDE_CODE_RESUME_INTERRUPTED_TURN === "1";
    if (!nativeResume) {
      const prompt = await this.#input.prompt[Symbol.asyncIterator]().next();
      if (prompt.done || this.#closed) return;

      const resetsAt = Date.now() + this.#resetDelayMs;
      this.#state.set(this.#sessionId, { resetsAt });
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt,
        },
        session_id: this.#sessionId,
        uuid: `fixture-rate-limit-${this.#sessionId}`,
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] simulated Claude usage limit"],
        terminal_reason: "blocking_limit",
        session_id: this.#sessionId,
        uuid: `fixture-limited-result-${this.#sessionId}`,
      } as unknown as SDKMessage;
      return;
    }

    const stored = this.#state.get(this.#sessionId);
    await this.#waitUntil(stored?.resetsAt ?? Date.now() + this.#resetDelayMs);
    if (this.#closed) return;

    this.#state.delete(this.#sessionId);
    yield {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0 },
      session_id: this.#sessionId,
      uuid: `fixture-rate-limit-allowed-${this.#sessionId}`,
    } as unknown as SDKMessage;
    yield {
      type: "assistant",
      session_id: this.#sessionId,
      uuid: `fixture-assistant-${this.#sessionId}`,
      parent_tool_use_id: null,
      message: {
        id: `fixture-message-${this.#sessionId}`,
        type: "message",
        role: "assistant",
        model: this.#input.options.model ?? "claude-sonnet-4-6",
        content: [
          {
            type: "text",
            text: "Mock Claude resumed automatically through the native watchdog.",
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {},
      },
    } as unknown as SDKMessage;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      errors: [],
      session_id: this.#sessionId,
      uuid: `fixture-success-${this.#sessionId}`,
    } as unknown as SDKMessage;
  }

  async #waitUntil(timestamp: number): Promise<void> {
    const delayMs = Math.max(0, timestamp - Date.now());
    if (delayMs === 0 || this.#closed) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.#closedListeners.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      this.#closedListeners.add(finish);
    });
  }

  async interrupt(): Promise<void> {
    this.close();
  }

  async setModel(_model?: string): Promise<void> {}
  async setPermissionMode(_mode: PermissionMode): Promise<void> {}
  async setMaxThinkingTokens(_maxThinkingTokens: number | null): Promise<void> {}

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closedListeners) listener();
    this.#closedListeners.clear();
  }
}

/**
 * Dev-only Claude query stand-in. The delay simulates Claude Code's native
 * retry watchdog; production auto-continue never schedules a T3 timer.
 */
export function makeClaudeUsageLimitQueryFactory(input?: {
  readonly resetDelayMs?: number;
}): (query: FixtureQueryInput) => FixtureQuery {
  const state = new Map<string, UsageLimitFixtureState>();
  const resetDelayMs = input?.resetDelayMs ?? 45_000;
  let fallbackSessionIndex = 0;

  return (query) => {
    const sessionId =
      query.options.resume ??
      query.options.sessionId ??
      `fixture-session-${fallbackSessionIndex++}`;
    return new ClaudeUsageLimitFixtureQuery({ query, sessionId, state, resetDelayMs });
  };
}
