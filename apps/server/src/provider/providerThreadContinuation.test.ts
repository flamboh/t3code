import {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProviderServiceShape } from "./Services/ProviderService.ts";
import {
  continueProviderThreadAfterReauthentication,
  EXPLICIT_PROVIDER_CONTINUATION_PROMPT,
} from "./providerThreadContinuation.ts";

const threadId = ThreadId.make("thread-claude-auth");
const instanceId = ProviderInstanceId.make("claude-work");
const timestamp = "2026-09-02T12:00:00.000Z";

function makeThread(session: OrchestrationThreadShell["session"]): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId: ProjectId.make("project-claude-auth"),
    title: "Claude auth",
    modelSelection: ModelSelection.make({
      instanceId,
      model: "claude-sonnet-4-5",
    }),
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    session,
    latestUserMessageAt: timestamp,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    planProgress: null,
  };
}

describe("continueProviderThreadAfterReauthentication", () => {
  it.effect("continues the matching failed Claude thread with the shared explicit prompt", () =>
    Effect.gen(function* () {
      const sends: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
      const sendTurn: ProviderServiceShape["sendTurn"] = (input) =>
        Effect.sync(() => {
          sends.push(input);
          return { threadId, turnId: TurnId.make("continued-turn") };
        });
      const continued = yield* continueProviderThreadAfterReauthentication({
        threadId,
        instanceId,
        getThreadShellById: () =>
          Effect.succeed(
            Option.some(
              makeThread({
                threadId,
                status: "error",
                providerName: "claudeAgent",
                providerInstanceId: instanceId,
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: "Authentication failed",
                lastErrorClass: "auth_error",
                updatedAt: timestamp,
              }),
            ),
          ),
        sendTurn,
      });

      assert.isTrue(continued);
      assert.deepEqual(sends[0], {
        threadId,
        input: EXPLICIT_PROVIDER_CONTINUATION_PROMPT,
        interactionMode: "plan",
      });
    }),
  );

  it.effect("does not continue after the thread has moved beyond the authentication error", () =>
    Effect.gen(function* () {
      const sends: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
      const sendTurn: ProviderServiceShape["sendTurn"] = (input) =>
        Effect.sync(() => {
          sends.push(input);
          return { threadId, turnId: TurnId.make("unexpected-turn") };
        });
      const continued = yield* continueProviderThreadAfterReauthentication({
        threadId,
        instanceId,
        getThreadShellById: () =>
          Effect.succeed(
            Option.some(
              makeThread({
                threadId,
                status: "running",
                providerName: "claudeAgent",
                providerInstanceId: instanceId,
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: timestamp,
              }),
            ),
          ),
        sendTurn,
      });

      assert.isFalse(continued);
      assert.equal(sends.length, 0);
    }),
  );
});
