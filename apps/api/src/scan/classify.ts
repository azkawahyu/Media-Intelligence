import type { MediaFile } from "@prisma/client";
import type { DiscoveredFile } from "../scanner.js";

export type FileClassification = "NEW" | "UNCHANGED" | "UPDATED";

/**
 * Classify a discovered file using only its persisted identity and filesystem
 * attributes. This function deliberately performs no I/O.
 */
export function classifyDiscoveredFile(
  discovered: Pick<DiscoveredFile, "storageId" | "relativePath" | "fileSize" | "modifiedAt">,
  existing: Pick<MediaFile, "storageId" | "relativePath" | "fileSize" | "modifiedAt"> | null,
): FileClassification {
  if (existing === null) {
    return "NEW";
  }

  const sameIdentity =
    existing.storageId === discovered.storageId &&
    existing.relativePath === discovered.relativePath;
  const sameAttributes =
    existing.fileSize === BigInt(discovered.fileSize) &&
    existing.modifiedAt.getTime() === discovered.modifiedAt.getTime();

  return sameIdentity && sameAttributes ? "UNCHANGED" : "UPDATED";
}

export const classifyFile = classifyDiscoveredFile;
