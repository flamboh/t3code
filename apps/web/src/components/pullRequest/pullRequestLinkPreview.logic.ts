import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";

import {
  findProjectForChangeRequest,
  parseChangeRequestUrl,
  type ChangeRequestLink,
} from "~/lib/openPullRequestLink";

type LinkPreviewProject = Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">;

export interface PullRequestLinkPreviewTarget {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
}

/**
 * A same-repository `#N` autolink points at the host's issue page, since the writer's number may
 * name an issue or a pull request. Only an autolink is read this way: an authored issue link stays
 * an ordinary link, as it does for clicks.
 */
function parseRepositoryIssueUrl(href: string): ChangeRequestLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const match = /^\/(.+?)\/(?:-\/)?issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host: url.hostname.toLowerCase(), repository: repository.toLowerCase(), number }
    : null;
}

/**
 * Resolves only against projects on the environment that will answer the preview query. A link
 * that merely resembles a change request stays an ordinary link, as does one from another server.
 */
export function resolvePullRequestLinkPreviewTarget(input: {
  readonly href: string;
  readonly environmentId: EnvironmentId | null;
  readonly canReadPullRequests: boolean;
  readonly projects: ReadonlyArray<LinkPreviewProject>;
  readonly isRepositoryReference?: boolean;
}): PullRequestLinkPreviewTarget | null {
  if (input.environmentId === null || !input.canReadPullRequests) return null;
  const parsed =
    parseChangeRequestUrl(input.href) ??
    (input.isRepositoryReference ? parseRepositoryIssueUrl(input.href) : null);
  if (parsed === null) return null;
  const project = findProjectForChangeRequest(
    input.projects.filter((candidate) => candidate.environmentId === input.environmentId),
    parsed,
  );
  if (project === undefined) return null;
  return {
    environmentId: input.environmentId,
    reference: {
      projectId: project.id,
      repository: project.repositoryIdentity?.displayName ?? parsed.repository,
      number: parsed.number,
    },
  };
}
