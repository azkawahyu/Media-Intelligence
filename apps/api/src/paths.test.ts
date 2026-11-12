import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { relativePathFromRoot, resolveInsideRoot } from "./paths.js";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tmip-paths-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveInsideRoot", () => {
  it("resolves valid nested, spaced, and Unicode relative paths", async () => {
    const root = await createTemporaryRoot();
    const relativePath = path.join("新闻", "2026", "September", "Program Final 01.mxf");

    expect(resolveInsideRoot(root, relativePath)).toBe(path.join(root, relativePath));
  });

  it.each([
    "../outside",
    "../../outside",
    "C:\\outside\\video.mxf",
    "\\\\server\\share\\video.mxf",
  ])("rejects escaping path %s", async (relativePath) => {
    const root = await createTemporaryRoot();

    expect(() => resolveInsideRoot(root, relativePath)).toThrow("escapes");
  });

  it("rejects an absolute path outside the configured root", async () => {
    const root = await createTemporaryRoot();
    const outside = path.resolve(root, "..", "outside");

    expect(() => resolveInsideRoot(root, outside)).toThrow("escapes");
  });
});

describe("relativePathFromRoot", () => {
  it("returns a normalized storage-relative path", async () => {
    const root = await createTemporaryRoot();
    const absolutePath = path.join(root, "News", "Archive", "clip.mxf");

    expect(relativePathFromRoot(root, absolutePath)).toBe("News/Archive/clip.mxf");
  });

  it("rejects an absolute path outside the configured root", async () => {
    const root = await createTemporaryRoot();
    const outside = path.resolve(root, "..", "outside");

    expect(() => relativePathFromRoot(root, outside)).toThrow("escapes");
  });
});
