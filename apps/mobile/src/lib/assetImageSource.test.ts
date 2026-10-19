import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { assetImageCacheKey, assetImageSource } from "./assetImageSource";

const environmentId = EnvironmentId.make("environment-1");

describe("assetImageSource", () => {
  it("caches an attachment under one key across re-signed URLs", () => {
    const resource = { _tag: "attachment", attachmentId: "thread-1-photo.jpg" } as const;
    const first = assetImageSource(
      environmentId,
      resource,
      "https://host/api/assets/token-a/p.jpg",
    );
    const second = assetImageSource(
      environmentId,
      resource,
      "https://host/api/assets/token-b/p.jpg",
    );

    expect(first.cacheKey).toBeDefined();
    expect(second).toStrictEqual({
      uri: "https://host/api/assets/token-b/p.jpg",
      cacheKey: first.cacheKey,
    });
    expect(
      assetImageSource(EnvironmentId.make("environment-2"), resource, "https://other/p.jpg")
        .cacheKey,
    ).not.toBe(first.cacheKey);
  });

  it("keeps ids that contain colons from sharing a key", () => {
    const uri = "https://host/api/assets/token/p.jpg";
    const left = assetImageSource(
      EnvironmentId.make("a"),
      { _tag: "attachment", attachmentId: "b:c" },
      uri,
    );
    const right = assetImageSource(
      EnvironmentId.make("a:b"),
      { _tag: "attachment", attachmentId: "c" },
      uri,
    );

    expect(left.cacheKey).not.toBe(right.cacheKey);
  });

  it("keeps workspace files keyed by URL because they can change on disk", () => {
    const source = assetImageSource(
      environmentId,
      { _tag: "draft-workspace-file", cwd: "/repo", path: "logo.png" },
      "https://host/api/assets/token-a/logo.png",
    );

    expect(source).toStrictEqual({ uri: "https://host/api/assets/token-a/logo.png" });
  });

  it("keys tool output images by their item and position", () => {
    const resource = {
      _tag: "tool-output-image",
      threadId: ThreadId.make("thread-1"),
      itemId: TurnItemId.make("item-1"),
      index: 0,
    } as const;

    expect(assetImageCacheKey(environmentId, resource)).toBe(
      assetImageCacheKey(environmentId, { ...resource }),
    );
    expect(assetImageCacheKey(environmentId, resource)).not.toBe(
      assetImageCacheKey(environmentId, { ...resource, index: 1 }),
    );
  });

  it("keys GitHub uploads but not repository files that can change at a branch", () => {
    const upload = assetImageCacheKey(environmentId, {
      _tag: "github-media",
      cwd: "/repo",
      url: "https://github.com/user-attachments/assets/0f3c2b1a-1111-2222-3333-444455556666",
    });
    const branchFile = assetImageCacheKey(environmentId, {
      _tag: "github-media",
      cwd: "/repo",
      url: "https://raw.githubusercontent.com/owner/repo/main/docs/shot.png",
    });

    expect(upload).toBeDefined();
    expect(branchFile).toBeUndefined();
    expect(
      assetImageCacheKey(EnvironmentId.make("environment-2"), {
        _tag: "github-media",
        cwd: "/repo",
        url: "https://github.com/user-attachments/assets/0f3c2b1a-1111-2222-3333-444455556666",
      }),
    ).not.toBe(upload);
  });

  it("keys repository files pinned to a commit SHA across blob and raw links", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const key = (url: string) =>
      assetImageCacheKey(environmentId, { _tag: "github-media", cwd: "/repo", url });

    const pinned = key(`https://raw.githubusercontent.com/owner/repo/${sha}/docs/shot.png`);

    expect(pinned).toBeDefined();
    expect(key(`https://github.com/owner/repo/blob/${sha}/docs/shot.png`)).toBe(pinned);
    expect(
      key(`https://raw.githubusercontent.com/owner/repo/${"a".repeat(64)}/shot.png`),
    ).toBeDefined();
    expect(key("https://github.com/owner/repo/blob/v1.2.3/docs/shot.png")).toBeUndefined();
    expect(
      key(`https://raw.githubusercontent.com/owner/repo/${sha.slice(0, 12)}/shot.png`),
    ).toBeUndefined();
  });

  it("keys host files by the version the server read, and by URL without one", () => {
    const resource = {
      _tag: "media-file",
      threadId: ThreadId.make("thread-1"),
      path: "/tmp/shot.png",
    } as const;
    const first = assetImageCacheKey(environmentId, resource, "5:1000");

    expect(first).toBeDefined();
    expect(assetImageCacheKey(environmentId, resource, "5:1000")).toBe(first);
    expect(assetImageCacheKey(environmentId, resource, "5:2000")).not.toBe(first);
    expect(assetImageCacheKey(environmentId, resource)).toBeUndefined();
  });
});
