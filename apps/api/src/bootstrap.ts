import type { PrismaClient, Storage } from "@prisma/client";

export interface StorageRepository {
  findUnique(args: { where: { name: string } }): Promise<Storage | null>;
  create(args: { data: { name: string; rootPath: string } }): Promise<Storage>;
}

export interface StorageBootstrapConfig {
  storageName: string;
  mediaRoot: string;
}

export async function ensureStorage(
  client: Pick<PrismaClient, "storage"> | { storage: StorageRepository },
  config: StorageBootstrapConfig,
): Promise<Storage> {
  const existing = await client.storage.findUnique({
    where: { name: config.storageName },
  });

  if (existing === null) {
    return client.storage.create({
      data: {
        name: config.storageName,
        rootPath: config.mediaRoot,
      },
    });
  }

  if (existing.rootPath !== config.mediaRoot) {
    throw new Error(
      `Storage "${config.storageName}" is configured with rootPath "${existing.rootPath}", ` +
        `but MEDIA_ROOT is "${config.mediaRoot}". Refusing to rewrite the existing Storage row.`,
    );
  }

  return existing;
}
