import path from "node:path";

export class PathContainmentError extends Error {
  constructor(relativePath: string) {
    super(`Path escapes the configured storage root: "${relativePath}"`);
    this.name = "PathContainmentError";
  }
}

function isWindowsAbsolutePath(value: string): boolean {
  return path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^\\\\/.test(value);
}

function assertAbsoluteInsideRoot(root: string, candidate: string, originalPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new PathContainmentError(originalPath);
  }

  return resolvedCandidate;
}

/**
 * Resolve a storage-relative path without allowing it to escape the storage root.
 * Node's native path semantics are used for resolution; Windows drive-letter and
 * UNC paths are rejected explicitly even when this code runs on POSIX.
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  if (
    path.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    isWindowsAbsolutePath(relativePath)
  ) {
    throw new PathContainmentError(relativePath);
  }

  return assertAbsoluteInsideRoot(
    root,
    path.resolve(root, relativePath),
    relativePath,
  );
}

/**
 * Return a storage-relative path for an absolute path that is inside root.
 * Storage paths use POSIX separators so they are stable across host platforms.
 */
export function relativePathFromRoot(root: string, absolutePath: string): string {
  // A Windows absolute path cannot be interpreted safely with POSIX semantics
  // (and vice versa), so reject cross-platform drive/UNC paths explicitly.
  if (
    !path.isAbsolute(absolutePath) ||
    (!path.win32.isAbsolute(root) && path.win32.isAbsolute(absolutePath))
  ) {
    throw new PathContainmentError(absolutePath);
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(absolutePath);
  const containedPath = assertAbsoluteInsideRoot(root, resolvedPath, absolutePath);
  const relative = path.relative(resolvedRoot, containedPath);

  return relative.split(path.sep).join("/");
}

export const toStorageRelativePath = relativePathFromRoot;
