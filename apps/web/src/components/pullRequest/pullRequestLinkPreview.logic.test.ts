import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePullRequestLinkPreviewTarget } from "./pullRequestLinkPreview.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function project(input: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly displayName: string;
}) {
  return {
    id: ProjectId.make(input.id),
    environmentId: input.environmentId,
    repositoryIdentity: {
      canonicalKey: `github.com/${input.displayName.toLowerCase()}`,
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: `https://github.com/${input.displayName}.git`,
      },
      displayName: input.displayName,
      provider: "github",
    },
  };
}

describe("resolvePullRequestLinkPreviewTarget", () => {
  it("resolves the project on the markdown's environment and preserves provider spelling", () => {
    const local = project({
      id: "project-local",
      environmentId: localEnvironmentId,
      displayName: "PingDotGG/T3Code",
    });
    const remote = project({
      id: "project-remote",
      environmentId: remoteEnvironmentId,
      displayName: "pingdotgg/t3code",
    });

    expect(
      resolvePullRequestLinkPreviewTarget({
        href: "https://github.com/pingdotgg/t3code/pull/9171/files",
        environmentId: localEnvironmentId,
        canReadPullRequests: true,
        projects: [remote, local],
      }),
    ).toEqual({
      environmentId: localEnvironmentId,
      reference: {
        projectId: local.id,
        repository: "PingDotGG/T3Code",
        number: 9171,
      },
    });
  });

  it("does not cross environments to find a matching repository", () => {
    expect(
      resolvePullRequestLinkPreviewTarget({
        href: "https://github.com/pingdotgg/t3code/pull/9171",
        environmentId: localEnvironmentId,
        canReadPullRequests: true,
        projects: [
          project({
            id: "project-remote",
            environmentId: remoteEnvironmentId,
            displayName: "pingdotgg/t3code",
          }),
        ],
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: "the environment cannot read pull requests",
      environmentId: localEnvironmentId,
      canReadPullRequests: false,
      href: "https://github.com/pingdotgg/t3code/pull/9171",
    },
    {
      name: "the markdown has no environment",
      environmentId: null,
      canReadPullRequests: true,
      href: "https://github.com/pingdotgg/t3code/pull/9171",
    },
    {
      name: "the link is an issue",
      environmentId: localEnvironmentId,
      canReadPullRequests: true,
      href: "https://github.com/pingdotgg/t3code/issues/9171",
    },
  ])("leaves the link alone when $name", ({ environmentId, canReadPullRequests, href }) => {
    expect(
      resolvePullRequestLinkPreviewTarget({
        href,
        environmentId,
        canReadPullRequests,
        projects: [
          project({
            id: "project-local",
            environmentId: localEnvironmentId,
            displayName: "pingdotgg/t3code",
          }),
        ],
      }),
    ).toBeNull();
  });
});

describe("resolvePullRequestLinkPreviewTarget for repository references", () => {
  const local = project({
    id: "project-local",
    environmentId: localEnvironmentId,
    displayName: "PingDotGG/T3Code",
  });

  it("reads a same-repository #N autolink through the host's issue page", () => {
    expect(
      resolvePullRequestLinkPreviewTarget({
        href: "https://github.com/pingdotgg/t3code/issues/9171",
        environmentId: localEnvironmentId,
        canReadPullRequests: true,
        projects: [local],
        isRepositoryReference: true,
      }),
    ).toEqual({
      environmentId: localEnvironmentId,
      reference: { projectId: local.id, repository: "PingDotGG/T3Code", number: 9171 },
    });
  });

  it("leaves an authored issue link alone", () => {
    expect(
      resolvePullRequestLinkPreviewTarget({
        href: "https://github.com/pingdotgg/t3code/issues/9171",
        environmentId: localEnvironmentId,
        canReadPullRequests: true,
        projects: [local],
      }),
    ).toBeNull();
  });
});
