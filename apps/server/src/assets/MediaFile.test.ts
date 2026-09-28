import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { openMediaFile, readMediaFileCapped } from "./MediaFile.ts";

it.layer(NodeServices.layer)("readMediaFileCapped", (it) => {
  it.effect(
    "reads a file within the cap and rejects one that is larger or grew after opening",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-media-file-" });
        const filePath = yield* fileSystem
          .realPath(directory)
          .pipe(Effect.map((canonical) => path.join(canonical, "shot.png")));
        yield* fileSystem.writeFile(filePath, new Uint8Array([1, 2, 3, 4]));

        const file = yield* openMediaFile(filePath);
        assert.isNotNull(file);
        if (file === null) return;
        assert.deepEqual(
          Array.from((yield* readMediaFileCapped(filePath, file, 4)) ?? []),
          [1, 2, 3, 4],
        );
        assert.isNull(yield* readMediaFileCapped(filePath, file, 3));

        yield* fileSystem.writeFile(filePath, new Uint8Array(64));
        assert.isNull(yield* readMediaFileCapped(filePath, file, 1024));
      }).pipe(Effect.scoped),
  );
});
