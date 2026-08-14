import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const OCCURRENCE = EventId.make("usage-occurrence");

function makeReadModel(usageLimit: OrchestrationReadModel["threads"][number]["session"] = null) {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: usageLimit,
      },
    ],
    updatedAt: NOW,
  } satisfies OrchestrationReadModel;
}

const session = {
  threadId: ThreadId.make("thread-1"),
  status: "interrupted" as const,
  providerName: "claudeAgent",
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  usageLimit: {
    occurrenceId: OCCURRENCE,
    provider: ProviderDriverKind.make("claudeAgent"),
    message: "rate limited",
  },
  updatedAt: NOW,
};

it.layer(NodeServices.layer)("usage-limit auto-continue decider", (it) => {
  it.effect("emits a reversible event only for the matching marker", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit.auto-continue.set",
          commandId: CommandId.make("command-1"),
          threadId: ThreadId.make("thread-1"),
          expectedOccurrenceId: OCCURRENCE,
          enabled: true,
          createdAt: NOW,
        },
        readModel: makeReadModel(session),
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event?.type).toBe("thread.usage-limit-auto-continue-set");
    }),
  );

  it.effect("rejects missing or stale markers", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit.auto-continue.set",
          commandId: CommandId.make("command-2"),
          threadId: ThreadId.make("thread-1"),
          expectedOccurrenceId: EventId.make("stale"),
          enabled: false,
          createdAt: NOW,
        },
        readModel: makeReadModel(session),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
