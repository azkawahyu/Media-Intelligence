import { describe, expect, it, vi } from "vitest";
import { ensureStorage } from "./bootstrap.js";

const config = { storageName: "Server B Media", mediaRoot: "/media" };

describe("ensureStorage", () => {
  it("creates the storage row when it is missing", async () => {
    const created = { id: "storage-1", name: config.storageName, rootPath: config.mediaRoot };
    const client = {
      storage: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
      },
    };

    await expect(
      ensureStorage(client as unknown as Parameters<typeof ensureStorage>[0], config),
    ).resolves.toEqual(created);
    expect(client.storage.create).toHaveBeenCalledWith({
      data: { name: config.storageName, rootPath: config.mediaRoot },
    });
  });

  it("does nothing when the matching storage row exists", async () => {
    const existing = { id: "storage-1", name: config.storageName, rootPath: config.mediaRoot };
    const client = {
      storage: {
        findUnique: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
      },
    };

    await expect(
      ensureStorage(client as unknown as Parameters<typeof ensureStorage>[0], config),
    ).resolves.toEqual(existing);
    expect(client.storage.create).not.toHaveBeenCalled();
  });

  it("fails instead of rewriting a mismatched root path", async () => {
    const client = {
      storage: {
        findUnique: vi.fn().mockResolvedValue({
          id: "storage-1",
          name: config.storageName,
          rootPath: "/other-media",
        }),
        create: vi.fn(),
      },
    };

    await expect(
      ensureStorage(client as unknown as Parameters<typeof ensureStorage>[0], config),
    ).rejects.toThrow("Refusing to rewrite");
    expect(client.storage.create).not.toHaveBeenCalled();
  });
});
