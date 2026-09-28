import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EffectOutboxV2, layer as effectOutboxLayer } from "./EffectOutbox.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import * as MessageMediaSnapshots from "./MessageMediaSnapshots.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import {
  ProviderEventIngestorV2,
  layer as providerEventIngestorLayer,
} from "./ProviderEventIngestor.ts";

const StoresLayer = Layer.mergeAll(eventStoreLayer, projectionStoreLayer, effectOutboxLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const EventSinkLayer = eventSinkLayer.pipe(Layer.provide(StoresLayer));
const DependenciesLayer = Layer.mergeAll(StoresLayer, EventSinkLayer, idAllocatorLayer);
const TestLayer = Layer.mergeAll(
  DependenciesLayer,
  providerEventIngestorLayer.pipe(Layer.provide(DependenciesLayer)),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-media-snapshot-" })),
  Layer.provideMerge(NodeServices.layer),
);

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:media-snapshot");
const runId = RunId.make("run:media-snapshot");

function threadCreated(now: DateTime.Utc): OrchestrationV2DomainEvent {
  return {
    id: "event:media-snapshot:thread" as OrchestrationV2DomainEvent["id"],
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("project:media-snapshot"),
      title: "Media snapshots",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
}

function assistantMessage(input: {
  readonly key: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly now: DateTime.Utc;
}) {
  return {
    id: TurnItemId.make(`turn-item:media-snapshot:${input.key}`),
    threadId,
    runId,
    nodeId: NodeId.make("node:media-snapshot"),
    providerThreadId: ProviderThreadId.make("provider-thread:media-snapshot"),
    providerTurnId: ProviderTurnId.make("provider-turn:media-snapshot"),
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: input.streaming ? "running" : "completed",
    title: null,
    startedAt: input.now,
    completedAt: input.streaming ? null : input.now,
    updatedAt: input.now,
    type: "assistant_message",
    messageId: MessageId.make(`message:media-snapshot:${input.key}`),
    text: input.text,
    streaming: input.streaming,
  } satisfies OrchestrationV2TurnItem;
}

const ingest = (turnItem: OrchestrationV2TurnItem) =>
  Effect.gen(function* () {
    const ingestor = yield* ProviderEventIngestorV2;
    yield* ingestor.ingestNormalized({
      providerSessionId: ProviderSessionId.make("provider-session:media-snapshot"),
      providerInstanceId,
      threadId,
      runId,
      event: { type: "turn_item.updated", driver, turnItem },
    });
  });

it("finds the absolute local images a message embeds", () => {
  assert.deepEqual(
    MessageMediaSnapshots.localMarkdownImagePaths(
      [
        "![before](/tmp/before.png) and ![again](/tmp/before.png)",
        "![spaced](</tmp/with space.webp>)",
        "![url](file:///tmp/from%20url.jpg#frag)",
        '<img src="/tmp/html.gif" width="200"> <img alt=x src=/tmp/unquoted.png>',
        "![query](/tmp/query.png?v=2)",
        "![relative](shots/rel.png) ![remote](https://example.com/a.png)",
        "![notes](/tmp/notes.txt) ![protocol](//cdn.example.com/a.png)",
        "![win](C:\\shots\\win.png) ![unc](file://server/share/unc.png)",
        "![localhost](file://localhost/tmp/localhost.png)",
        '![parens](/tmp/shot(1).png) ![titled](/tmp/titled.png "Title")',
        "![escaped](/tmp/escaped\\).png)",
        "![shot][Capture] ![collapsed][] ![shortcut] ![undefined][nope]",
        "",
        "[capture]: /tmp/reference.png",
        "[collapsed]: </tmp/collapsed ref.jpg>",
        "[shortcut]: file:///tmp/shortcut.webp",
        "[capture]: /tmp/shadowed.png",
      ].join("\n"),
    ),
    [
      "/tmp/before.png",
      "/tmp/with space.webp",
      "/tmp/from url.jpg",
      "/tmp/html.gif",
      "/tmp/unquoted.png",
      "/tmp/query.png",
      "C:\\shots\\win.png",
      "\\\\server\\share\\unc.png",
      "/tmp/localhost.png",
      "/tmp/shot(1).png",
      "/tmp/titled.png",
      "/tmp/escaped).png",
      "/tmp/reference.png",
      "/tmp/collapsed ref.jpg",
      "/tmp/shortcut.webp",
    ],
  );
});

it.layer(TestLayer)("MessageMediaSnapshotService", (it) => {
  it.effect("keeps the bytes a completed message embedded after the file changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const eventSink = yield* EventSinkV2;
      const outbox = yield* EffectOutboxV2;
      const projections = yield* ProjectionStoreV2;
      const snapshots = yield* MessageMediaSnapshots.make;
      const now = yield* DateTime.now;
      yield* eventSink.write({ events: [threadCreated(now)] });

      const sourceDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-media-source-" });
      const shot = path.join(sourceDir, "shot.png");
      const oversized = path.join(sourceDir, "huge.png");
      const notes = path.join(sourceDir, "notes.txt");
      yield* fileSystem.writeFile(shot, new Uint8Array([1, 2, 3]));
      yield* fileSystem.writeFile(
        oversized,
        new Uint8Array(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1),
      );
      yield* fileSystem.writeFileString(notes, "not an image");
      const disguisedNotes = path.join(sourceDir, "disguised.png");
      yield* fileSystem.symlink(notes, disguisedNotes);
      const text = [
        `![after](${shot})`,
        `![missing](${path.join(sourceDir, "missing.png")})`,
        `![huge](${oversized})`,
        `![notes](${notes})`,
        `![disguised](${disguisedNotes})`,
      ].join("\n");

      const streaming = assistantMessage({ key: "streaming", text, streaming: true, now });
      yield* ingest(streaming);
      assert.isTrue(
        Option.isNone(yield* outbox.get(`effect:message-media.snapshot:${streaming.id}`)),
      );

      const completed = assistantMessage({ key: "completed", text, streaming: false, now });
      yield* ingest(completed);
      const queued = yield* outbox.get(`effect:message-media.snapshot:${completed.id}`);
      assert.isTrue(Option.isSome(queued));
      const request = Option.getOrThrow(queued).request;
      assert.strictEqual(request.type, "message-media.snapshot");
      if (request.type !== "message-media.snapshot") return;

      yield* snapshots.snapshot({ threadId, runId: request.runId, turnItemId: request.turnItemId });

      const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"]);
      const recorded = turnItems.find((item) => item.id === completed.id);
      assert.strictEqual(recorded?.type, "assistant_message");
      if (recorded?.type !== "assistant_message") return;
      assert.deepEqual(
        recorded.mediaSnapshots?.map((snapshot) => snapshot.path),
        [shot],
      );
      const attachmentId = recorded.mediaSnapshots![0]!.attachmentId;

      yield* fileSystem.writeFile(shot, new Uint8Array([9, 9, 9, 9]));
      const snapshotPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId,
      });
      assert.isNotNull(snapshotPath);
      assert.deepEqual(Array.from(yield* fileSystem.readFile(snapshotPath!)), [1, 2, 3]);
      assert.include(yield* projections.getThreadAttachmentIds(threadId), attachmentId);

      yield* ingest(completed);
      const { turnItems: afterResend } = yield* projections.getThreadRecords(threadId, [
        "turnItems",
      ]);
      const resent = afterResend.find((item) => item.id === completed.id);
      assert.deepEqual(
        resent?.type === "assistant_message" ? resent.mediaSnapshots : undefined,
        recorded.mediaSnapshots,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps snapshots when a re-send built before the snapshot commits after it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const eventSink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const snapshots = yield* MessageMediaSnapshots.make;
      const now = yield* DateTime.now;

      const sourceDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-media-source-" });
      const shot = path.join(sourceDir, "race.png");
      yield* fileSystem.writeFile(shot, new Uint8Array([4, 5, 6]));
      const completed = assistantMessage({
        key: "race",
        text: `![race](${shot})`,
        streaming: false,
        now,
      });
      yield* ingest(completed);

      const staleResend: OrchestrationV2DomainEvent = {
        id: "event:media-snapshot:race-resend" as OrchestrationV2DomainEvent["id"],
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: completed.nodeId,
        occurredAt: now,
        payload: completed,
      };
      yield* snapshots.snapshot({ threadId, runId, turnItemId: completed.id });
      const [stored] = yield* eventSink.write({ events: [staleResend] });

      const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"]);
      const recorded = turnItems.find((item) => item.id === completed.id);
      const kept = recorded?.type === "assistant_message" ? recorded.mediaSnapshots : undefined;
      assert.deepEqual(
        kept?.map((snapshot) => snapshot.path),
        [shot],
      );
      assert.deepEqual(
        stored?.event.type === "turn-item.updated" &&
          stored.event.payload.type === "assistant_message"
          ? stored.event.payload.mediaSnapshots
          : undefined,
        kept,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("gives identical bytes under different extensions their own attachment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const projections = yield* ProjectionStoreV2;
      const snapshots = yield* MessageMediaSnapshots.make;
      const now = yield* DateTime.now;

      const sourceDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-media-source-" });
      const png = path.join(sourceDir, "same.png");
      const jpg = path.join(sourceDir, "same.JPG");
      yield* fileSystem.writeFile(png, new Uint8Array([4, 5, 6]));
      yield* fileSystem.writeFile(jpg, new Uint8Array([4, 5, 6]));
      const completed = assistantMessage({
        key: "extensions",
        text: `![png](${png}) ![jpg](${jpg})`,
        streaming: false,
        now,
      });
      yield* ingest(completed);

      yield* snapshots.snapshot({ threadId, runId, turnItemId: completed.id });

      const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"]);
      const recorded = turnItems.find((item) => item.id === completed.id);
      const stored = (recorded?.type === "assistant_message" ? recorded.mediaSnapshots : [])?.map(
        (snapshot) =>
          path.extname(
            resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: snapshot.attachmentId,
            }) ?? "",
          ),
      );
      assert.deepEqual(stored, [".png", ".jpg"]);
    }).pipe(Effect.scoped),
  );

  it.effect("removes the copies it made when the snapshot is not committed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const eventSink = yield* EventSinkV2;
      const ids = yield* IdAllocatorV2;
      const projections = yield* ProjectionStoreV2;
      const snapshots = yield* MessageMediaSnapshots.make;
      const now = yield* DateTime.now;

      const sourceDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-media-source-" });
      const shot = path.join(sourceDir, "orphan.png");
      yield* fileSystem.writeFile(shot, new Uint8Array([7, 8, 9, 10]));
      const completed = assistantMessage({
        key: "orphan",
        text: `![orphan](${shot})`,
        streaming: false,
        now,
      });
      yield* ingest(completed);

      const commandId = CommandId.make(`command:effect:message-media.snapshot:${completed.id}`);
      yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "message-media.snapshot",
        acceptedAt: now,
        effects: [],
        events: [
          {
            id: yield* ids.allocate.event({ threadId, commandId }),
            type: "turn-item.updated",
            threadId,
            runId,
            nodeId: completed.nodeId,
            occurredAt: now,
            payload: completed,
          },
        ],
      });
      const listAttachments = Effect.gen(function* () {
        const exists = yield* fileSystem.exists(config.attachmentsDir);
        return exists ? (yield* fileSystem.readDirectory(config.attachmentsDir)).toSorted() : [];
      });
      const attachmentsBefore = yield* listAttachments;

      yield* snapshots.snapshot({ threadId, runId, turnItemId: completed.id });

      const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"]);
      const recorded = turnItems.find((item) => item.id === completed.id);
      assert.isUndefined(
        recorded?.type === "assistant_message" ? recorded.mediaSnapshots : undefined,
      );
      assert.deepEqual(yield* listAttachments, attachmentsBefore);
    }).pipe(Effect.scoped),
  );
});
