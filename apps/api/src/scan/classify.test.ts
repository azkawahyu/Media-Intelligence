import { describe, expect, it } from "vitest";
import { classifyDiscoveredFile } from "./classify.js";
import type { DiscoveredFile } from "../scanner.js";

const discovered: DiscoveredFile = {
  storageId: "storage-1",
  relativePath: "news/program.mxf",
  filename: "program.mxf",
  extension: ".mxf",
  fileSize: 100,
  modifiedAt: new Date("2026-09-30T10:00:00.000Z"),
};

function existing(overrides: Partial<DiscoveredFile> = {}) {
  return {
    storageId: discovered.storageId,
    relativePath: discovered.relativePath,
    fileSize: BigInt(overrides.fileSize ?? discovered.fileSize),
    modifiedAt: overrides.modifiedAt ?? discovered.modifiedAt,
  };
}

describe("classifyDiscoveredFile", () => {
  it("classifies an unknown file as NEW", () => {
    expect(classifyDiscoveredFile(discovered, null)).toBe("NEW");
  });

  it("classifies equal size and mtime as UNCHANGED", () => {
    expect(classifyDiscoveredFile(discovered, existing())).toBe("UNCHANGED");
  });

  it("classifies a size difference as UPDATED", () => {
    expect(classifyDiscoveredFile(discovered, existing({ fileSize: 101 }))).toBe("UPDATED");
  });

  it("classifies an mtime difference as UPDATED", () => {
    expect(
      classifyDiscoveredFile(
        discovered,
        existing({ modifiedAt: new Date("2026-09-30T10:00:01.000Z") }),
      ),
    ).toBe("UPDATED");
  });

  it("classifies both differences as UPDATED", () => {
    expect(
      classifyDiscoveredFile(
        discovered,
        existing({
          fileSize: 101,
          modifiedAt: new Date("2026-09-30T10:00:01.000Z"),
        }),
      ),
    ).toBe("UPDATED");
  });
});
