import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  isSupportedMediaExtension,
  type AppConfig,
} from "./config.js";
import { relativePathFromRoot } from "./paths.js";

export interface DiscoveredFile {
  storageId: string;
  relativePath: string;
  filename: string;
  extension: string;
  fileSize: number;
  modifiedAt: Date;
}

export interface ScanStorageOptions {
  storageId: string;
  supportedMediaExtensions: readonly string[];
  onFile: (file: DiscoveredFile) => void | Promise<void>;
}

/**
 * Recursively discover supported media under the validated MEDIA_ROOT.
 * Files are delivered as soon as their attributes are read; this function does
 * not collect the discovered set and never writes to the source directory.
 */
export async function scanStorage(
  config: Pick<AppConfig, "mediaRoot" | "supportedMediaExtensions">,
  storageId: string,
  onFile: ScanStorageOptions["onFile"],
): Promise<void> {
  const resolvedRoot = path.resolve(config.mediaRoot);
  await visitDirectory(resolvedRoot, resolvedRoot, {
    storageId,
    supportedMediaExtensions: config.supportedMediaExtensions,
    onFile,
  });
}

export const scanConfiguredStorage = scanStorage;

async function visitDirectory(
  root: string,
  directory: string,
  options: ScanStorageOptions,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await visitDirectory(root, absolutePath, options);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!isSupportedMediaExtension(extension, options.supportedMediaExtensions)) {
      continue;
    }

    const attributes = await stat(absolutePath);
    await options.onFile({
      storageId: options.storageId,
      relativePath: relativePathFromRoot(root, absolutePath),
      filename: entry.name,
      extension,
      fileSize: attributes.size,
      modifiedAt: attributes.mtime,
    });
  }
}
