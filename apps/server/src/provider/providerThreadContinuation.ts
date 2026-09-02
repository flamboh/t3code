import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";

export const EXPLICIT_PROVIDER_CONTINUATION_PROMPT = "Continue where you left off.";

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

  yield* input.sendTurn({
    threadId: thread.id,
    input: EXPLICIT_PROVIDER_CONTINUATION_PROMPT,
    interactionMode: thread.interactionMode,
  });
  return true;
});
