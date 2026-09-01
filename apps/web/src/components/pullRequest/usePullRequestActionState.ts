import { useAtom } from "@effect/atom-react";
import type { PullRequestAction, PullRequestState } from "@t3tools/contracts";
import { useEffect } from "react";

import {
  beginPullRequestAction,
  completePullRequestAction,
  failPullRequestAction,
  observePullRequestDetail,
  pullRequestActionStateAtom,
} from "@t3tools/client-runtime/state/pull-request-actions";

export function usePullRequestActionState(
  pullRequestKey: string,
  detail: {
    readonly state: PullRequestState | null;
    readonly isPending: boolean;
  },
) {
  const [state, setState] = useAtom(pullRequestActionStateAtom(pullRequestKey));

  const { state: detailState, isPending } = detail;
  useEffect(() => {
    setState((current) => observePullRequestDetail(current, { state: detailState, isPending }));
  }, [detailState, isPending, setState, state.mergeHold]);

  return {
    pendingAction: state.pendingAction,
    mergeHold: state.mergeHold,
    beginAction: (action: PullRequestAction) =>
      setState((current) => beginPullRequestAction(current, action)),
    completeAction: (action: PullRequestAction) =>
      setState((current) => completePullRequestAction(current, action)),
    failAction: () => setState((current) => failPullRequestAction(current)),
  };
}
