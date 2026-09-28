import {
  ChatAttachmentId,
  CommandId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2MediaSnapshot,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { openMediaFile, readMediaFileCapped } from "../assets/MediaFile.ts";
import { createDeterministicAttachmentId } from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

const MAX_SNAPSHOTS_PER_MESSAGE = 20;
const MAX_SNAPSHOT_BYTES_PER_MESSAGE = 4 * PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;

const MARKDOWN_IMAGE_PATTERN = /!\[((?:\\.|[^\]\\\n])*)\]/g;
const MARKDOWN_REFERENCE_LABEL_PATTERN = /\[((?:\\.|[^\]\\\n])*)\]/y;
const MARKDOWN_REFERENCE_DEFINITION_PATTERN =
  /^ {0,3}\[((?:\\.|[^\]\\\n])+)\]:[ \t]*(?:\n[ \t]*)?(<[^>\n]*>|\S+)/gm;
const MARKDOWN_ESCAPABLE_PATTERN = /[!-/:-@[-`{-~]/;
const HTML_IMAGE_PATTERN = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN = /^\/[A-Za-z]:[\\/]/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripSlashPrefixedWindowsDrive(path: string): string {
  return SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN.test(path) ? path.slice(1) : path;
}

/** Mirrors the clients' markdown image classification for absolute host paths. */
function localImagePath(destination: string): string | null {
  const trimmed = destination.trim();
  const source = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  let path: string;
  if (/^file:/i.test(source)) {
    try {
      const url = new URL(source);
      if (url.hostname !== "" && url.hostname.toLowerCase() !== "localhost") return null;
      path = url.pathname;
    } catch {
      return null;
    }
  } else {
    path = source.split("#", 1)[0]!.split("?", 1)[0]!;
  }
  path = stripSlashPrefixedWindowsDrive(safeDecode(path));
  const absolute = (path.startsWith("/") && !path.startsWith("//")) || isWindowsAbsolutePath(path);
  return absolute && isWorkspaceImagePreviewPath(path) ? path : null;
}

function markdownReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Reads an inline link destination starting at `start`, allowing balanced parentheses. */
function markdownInlineDestination(text: string, start: number): string {
  let index = start;
  while (text[index] === " " || text[index] === "\t") index++;
  if (text[index] === "<") {
    const end = text.indexOf(">", index);
    const destination = end === -1 ? "" : text.slice(index, end + 1);
    return destination.includes("\n") ? "" : destination;
  }
  let depth = 0;
  let destination = "";
  for (; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "\\" && next !== undefined && MARKDOWN_ESCAPABLE_PATTERN.test(next)) {
      destination += next;
      index++;
      continue;
    }
    if (/\s/.test(char)) break;
    if (char === "(") depth++;
    if (char === ")" && depth-- === 0) break;
    destination += char;
  }
  return destination;
}

/** Absolute host image paths a message embeds, in order and without duplicates. */
export function localMarkdownImagePaths(text: string): ReadonlyArray<string> {
  if (!text.includes("![") && !/<img\b/i.test(text)) return [];
  const definitions = new Map<string, string>();
  for (const match of text.matchAll(MARKDOWN_REFERENCE_DEFINITION_PATTERN)) {
    const label = markdownReferenceLabel(match[1]!);
    if (!definitions.has(label)) definitions.set(label, match[2]!);
  }
  const paths = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const end = match.index + match[0].length;
    let destination: string | undefined;
    if (text[end] === "(") {
      destination = markdownInlineDestination(text, end + 1);
    } else {
      MARKDOWN_REFERENCE_LABEL_PATTERN.lastIndex = end;
      const reference = MARKDOWN_REFERENCE_LABEL_PATTERN.exec(text)?.[1];
      destination = definitions.get(
        markdownReferenceLabel(
          reference === undefined || reference.trim() === "" ? match[1]! : reference,
        ),
      );
    }
    const path = destination === undefined ? null : localImagePath(destination);
    if (path !== null) paths.add(path);
  }
  for (const match of text.matchAll(HTML_IMAGE_PATTERN)) {
    const path = localImagePath(match[1] ?? match[2] ?? "");
    if (path !== null) paths.add(path);
  }
  return [...paths];
}

/** Queue one snapshot per completed assistant message that embeds local images. */
export function messageMediaSnapshotEffects(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
): ReadonlyArray<PendingOrchestrationEffectV2> {
  const effects = new Map<string, PendingOrchestrationEffectV2>();
  for (const event of events) {
    if (event.type !== "turn-item.updated") continue;
    const item = event.payload;
    if (
      item.type !== "assistant_message" ||
      item.streaming ||
      item.mediaSnapshots !== undefined ||
      localMarkdownImagePaths(item.text).length === 0
    ) {
      continue;
    }
    const id = `effect:message-media.snapshot:${item.id}`;
    effects.set(id, {
      id,
      commandId: CommandId.make(`command:effect:message-media.snapshot:${item.id}`),
      threadId: item.threadId,
      request: { type: "message-media.snapshot", runId: item.runId, turnItemId: item.id },
    });
  }
  return [...effects.values()];
}

interface MessageMediaSnapshotTarget {
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly turnItemId: TurnItemId;
}

export class MessageMediaSnapshotService extends Context.Reference<{
  readonly snapshot: (input: MessageMediaSnapshotTarget) => Effect.Effect<void>;
}>("t3/orchestration-v2/MessageMediaSnapshotService", {
  defaultValue: () => ({ snapshot: () => Effect.void }),
}) {}

export const live = Layer.effect(
  MessageMediaSnapshotService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const eventSink = yield* EventSinkV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const ids = yield* IdAllocatorV2;
    const path = yield* Path.Path;
    const projections = yield* ProjectionStoreV2;

    const copyIntoAttachments = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly sourcePath: string;
      readonly maxBytes: number;
    }) {
      const sourcePath = yield* fileSystem.realPath(input.sourcePath);
      if (!isWorkspaceImagePreviewPath(sourcePath)) return null;
      const bytes = yield* Effect.scoped(
        Effect.flatMap(openMediaFile(sourcePath), (file) =>
          file === null
            ? Effect.succeed(null)
            : readMediaFileCapped(sourcePath, file, input.maxBytes),
        ),
      );
      if (bytes === null) return null;
      const digest = Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes));
      const attachmentId = createDeterministicAttachmentId(
        input.threadId,
        `media-snapshot:${digest}`,
      );
      const targetPath =
        attachmentId === null
          ? null
          : resolveAttachmentRelativePath({
              attachmentsDir: config.attachmentsDir,
              relativePath: `${attachmentId}${path.extname(sourcePath).toLowerCase()}`,
            });
      if (attachmentId === null || targetPath === null) return null;
      const created = !(yield* fileSystem.exists(targetPath));
      if (created) {
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        const partialPath = `${targetPath}.part`;
        yield* fileSystem.writeFile(partialPath, bytes);
        yield* fileSystem.rename(partialPath, targetPath);
      }
      return {
        attachmentId: ChatAttachmentId.make(attachmentId),
        path: targetPath,
        size: bytes.byteLength,
        created,
      };
    });

    /** Copies only stay in the attachment store once a committed message references them. */
    const removeUnreferencedCopies = Effect.fnUntraced(function* (
      threadId: ThreadId,
      copies: ReadonlyArray<{ readonly attachmentId: ChatAttachmentId; readonly path: string }>,
    ) {
      if (copies.length === 0) return;
      const referenced = new Set(yield* projections.getThreadAttachmentIds(threadId));
      yield* Effect.forEach(
        copies.filter((copy) => !referenced.has(copy.attachmentId)),
        (copy) => fileSystem.remove(copy.path, { force: true }),
        { discard: true },
      );
    });

    const unsnapshottedMessage = Effect.fnUntraced(function* (input: MessageMediaSnapshotTarget) {
      const records = yield* projections.getThreadRecords(input.threadId, ["turnItems"], {
        turnItemRunIds: [input.runId],
        turnItemTypes: ["assistant_message"],
      });
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      return records.thread.deletedAt === null &&
        item?.type === "assistant_message" &&
        !item.streaming &&
        item.mediaSnapshots === undefined
        ? item
        : null;
    });

    const snapshot = Effect.fn("MessageMediaSnapshotService.snapshot")(
      function* (input: MessageMediaSnapshotTarget) {
        const item = yield* unsnapshottedMessage(input);
        if (item === null) return;
        const createdCopies: Array<{ attachmentId: ChatAttachmentId; path: string }> = [];
        yield* Effect.gen(function* () {
          const mediaSnapshots: Array<OrchestrationV2MediaSnapshot> = [];
          let budgetBytes = MAX_SNAPSHOT_BYTES_PER_MESSAGE;
          for (const sourcePath of localMarkdownImagePaths(item.text).slice(
            0,
            MAX_SNAPSHOTS_PER_MESSAGE,
          )) {
            const copied = yield* copyIntoAttachments({
              threadId: input.threadId,
              sourcePath,
              maxBytes: Math.min(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, budgetBytes),
            }).pipe(Effect.orElseSucceed(() => null));
            if (copied === null) continue;
            if (copied.created) createdCopies.push(copied);
            budgetBytes -= copied.size;
            mediaSnapshots.push({ path: sourcePath, attachmentId: copied.attachmentId });
          }
          if (mediaSnapshots.length === 0) return false;
          const latest = yield* unsnapshottedMessage(input);
          if (latest === null) return false;
          const commandId = CommandId.make(`command:effect:message-media.snapshot:${item.id}`);
          const now = yield* DateTime.now;
          const result = yield* eventSink.commitCommand({
            commandId,
            threadId: input.threadId,
            commandType: "message-media.snapshot",
            acceptedAt: now,
            effects: [],
            events: [
              {
                id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                type: "turn-item.updated",
                threadId: input.threadId,
                ...(latest.runId === null ? {} : { runId: latest.runId }),
                ...(latest.nodeId === null ? {} : { nodeId: latest.nodeId }),
                occurredAt: now,
                payload: { ...latest, mediaSnapshots },
              },
            ],
          });
          return result.committed;
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) && exit.value
              ? Effect.void
              : removeUnreferencedCopies(input.threadId, createdCopies).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Failed to remove uncommitted message media", { cause }),
                  ),
                ),
          ),
        );
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to snapshot message media", { cause }),
      ),
    );

    return { snapshot };
  }),
);
