import type { ProviderInstanceId, ProviderInteractionMode, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";

export const EXPLICIT_PROVIDER_CONTINUATION_PROMPT = "Continue where you left off.";

/** Uses the provider continuation capability added for server-update recovery. */
export const continueProviderThread = Effect.fn("continueProviderThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly interactionMode: ProviderInteractionMode;
  readonly getCapabilities: ProviderServiceShape["getCapabilities"];
  readonly sendTurn: ProviderServiceShape["sendTurn"];
}) {
  const capabilities = yield* input.getCapabilities(input.instanceId);
  yield* input.sendTurn({
    threadId: input.threadId,
    ...(capabilities.promptlessTurnContinuation === true
      ? { continuation: true }
      : { input: EXPLICIT_PROVIDER_CONTINUATION_PROMPT }),
    interactionMode: input.interactionMode,
  });
});

/**
 * Continues the thread that prompted a provider reauthentication attempt.
 * A later user turn clears the authentication error, so the guard also keeps
 * a delayed browser callback from steering work the user already restarted.
 */
export const continueProviderThreadAfterReauthentication = Effect.fn(
  "continueProviderThreadAfterReauthentication",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"];
  readonly getCapabilities: ProviderServiceShape["getCapabilities"];
  readonly sendTurn: ProviderServiceShape["sendTurn"];
}) {
  const thread = Option.getOrUndefined(yield* input.getThreadShellById(input.threadId));
  const session = thread?.session;
  if (
    thread === undefined ||
    session === undefined ||
    session === null ||
    session.status !== "error" ||
    session.lastErrorClass !== "auth_error" ||
    (session.providerInstanceId ?? thread.modelSelection.instanceId) !== input.instanceId
  ) {
    return false;
  }

  yield* continueProviderThread({
    threadId: thread.id,
    instanceId: input.instanceId,
    interactionMode: thread.interactionMode,
    getCapabilities: input.getCapabilities,
    sendTurn: input.sendTurn,
  });
  return true;
});
