const storageUrlPattern =
  /^https:\/\/api[.]wisewolflanguage[.]com[.]br\/storage\/v1\/object\/(?:public|sign|authenticated)\/resumes\/([^?#]+)(?:\?[^#]*)?$/;

const safeFileNamePattern =
  /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,180}[.](?:pdf|doc|docx)$/iu;

/**
 * Converts a trusted Wise Wolf Storage URL into a canonical, tenant-scoped
 * object path. Encoded separators and dot-segment traversal are rejected
 * before the path is passed to the service-role Storage client.
 */
export function authorizedResumePath(url: string, tenantId: string): string | null {
  const match = url.match(storageUrlPattern);
  if (!match) return null;

  try {
    let decodedPath = match[1];
    for (let pass = 0; pass < 3; pass++) {
      const next = decodeURIComponent(decodedPath);
      if (next === decodedPath) break;
      decodedPath = next;
    }

    const segments = decodedPath.split("/");
    const fileName = segments[1] ?? "";
    if (
      segments.length !== 2 ||
      segments[0] !== tenantId ||
      !safeFileNamePattern.test(fileName) ||
      decodedPath.includes("%") ||
      decodedPath.includes("\\")
    ) return null;

    return `${tenantId}/${fileName}`;
  } catch {
    return null;
  }
}
