import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SUPPORTED_MEDIA_EXTENSIONS } from "./config.js";
import { scanStorage, type DiscoveredFile } from "./scanner.js";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tmip-scanner-"));
  temporaryRoots.push(root);
  return root;
}

async function createFile(root: string, relativePath: string, content = "media"): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

async function collect(root: string, storageId = "storage-test"): Promise<DiscoveredFile[]> {
  const discovered: DiscoveredFile[] = [];
  await scanStorage(
    { mediaRoot: root, supportedMediaExtensions: DEFAULT_SUPPORTED_MEDIA_EXTENSIONS },
    storageId,
    (file) => {
      discovered.push(file);
    },
  );
  return discovered;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("scanStorage", () => {
  it("discovers supported files recursively and ignores unsupported files", async () => {
    const root = await createTemporaryRoot();
    await createFile(root, path.join("news", "a.mp4"));
    await createFile(root, path.join("news", "archive", "b.mxf"));
    await createFile(root, "program.mov");
    await createFile(root, "notes.txt");
    await createFile(root, "image.jpg");

    const discovered = await collect(root);

    expect(discovered.map(({ relativePath }) => relativePath).sort()).toEqual([
      "news/a.mp4",
      "news/archive/b.mxf",
      "program.mov",
    ]);
    expect(discovered.every(({ relativePath }) => !relativePath.includes(root))).toBe(true);
  });

  it("preserves distinct relative paths for same-named files", async () => {
    const root = await createTemporaryRoot();
    await createFile(root, path.join("news", "video.mxf"));
    await createFile(root, path.join("sports", "video.mxf"));

    const discovered = await collect(root);

    expect(discovered.map(({ relativePath }) => relativePath).sort()).toEqual([
      "news/video.mxf",
      "sports/video.mxf",
    ]);
    expect(new Set(discovered.map(({ relativePath }) => relativePath)).size).toBe(2);
  });

  it("matches supported extensions case-insensitively", async () => {
    const root = await createTemporaryRoot();
    await createFile(root, "video.mxf");
    // Windows filesystems are commonly case-insensitive, so keep the two case
    // variants in separate directories while testing their file extensions.
    await createFile(root, path.join("uppercase", "VIDEO.MXF"));
    await createFile(root, "clip.mp4");

    const discovered = await collect(root);

    expect(discovered.map(({ filename }) => filename).sort()).toEqual([
      "VIDEO.MXF",
      "clip.mp4",
      "video.mxf",
    ]);
    expect(discovered.map(({ extension }) => extension).sort()).toEqual([
      ".mp4",
      ".mxf",
      ".mxf",
    ]);
  });

  it("collects stable filesystem attributes", async () => {
    const root = await createTemporaryRoot();
    const relativePath = path.join("nested", "Program Final 01.mxf");
    const absolutePath = path.join(root, relativePath);
    const modifiedAt = new Date("2020-01-02T03:04:05.000Z");
    await createFile(root, relativePath, "known-size");
    await utimes(absolutePath, modifiedAt, modifiedAt);

    const [discovered] = await collect(root);

    expect(discovered).toMatchObject({
      storageId: "storage-test",
      relativePath: "nested/Program Final 01.mxf",
      filename: "Program Final 01.mxf",
      extension: ".mxf",
      fileSize: 10,
    });
    expect(discovered?.modifiedAt.getTime()).toBe(modifiedAt.getTime());
  });

  it("does not mutate the source tree or file contents", async () => {
    const root = await createTemporaryRoot();
    const relativePath = path.join("7 Unicode", "媒体 file.mkv");
    await createFile(root, relativePath, "immutable-content");
    const before = await readFile(path.join(root, relativePath));

    await collect(root);

    const after = await readFile(path.join(root, relativePath));
    expect(after).toEqual(before);
  });
});
