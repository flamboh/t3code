import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { immutableGithubMediaUrl } from "@t3tools/shared/githubMedia";
import type { ImageSource } from "expo-image";

/**
 * Every mint signs a new URL, so a URL-keyed cache misses each time. Content
 * that cannot change caches under its identity instead, and host files under
 * their path plus the version the server read from disk. Anything else stays
 * keyed by URL.
 */
export function assetImageCacheKey(
  environmentId: EnvironmentId,
  resource: AssetResource,
  fileRevision?: string,
): string | undefined {
  switch (resource._tag) {
    case "attachment":
      return `t3-attachment:${JSON.stringify([environmentId, resource.attachmentId])}`;
    case "tool-output-image":
      return `t3-tool-output:${JSON.stringify([
        environmentId,
        resource.threadId,
        resource.itemId,
        resource.index,
      ])}`;
    case "github-media": {
      const url = immutableGithubMediaUrl(resource.url);
      return url === null ? undefined : `t3-github-media:${JSON.stringify([environmentId, url])}`;
    }
    case "workspace-file":
    case "media-file":
    case "draft-workspace-file":
      return fileRevision === undefined
        ? undefined
        : `t3-file:${JSON.stringify([
            environmentId,
            resource._tag,
            resource._tag === "draft-workspace-file" ? resource.cwd : resource.threadId,
            resource.path,
            fileRevision,
          ])}`;
    case "project-favicon":
    case "native-app-icon":
      return undefined;
  }
}

export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  uri: string,
): ImageSource {
  const cacheKey = assetImageCacheKey(environmentId, resource);
  return cacheKey === undefined ? { uri } : { uri, cacheKey };
}
