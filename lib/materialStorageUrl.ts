const MATERIAL_STORAGE_MARKERS = [
  '/storage/v1/object/public/materials/',
  '/storage/v1/object/authenticated/materials/',
  '/storage/v1/object/sign/materials/',
];

export const parseMaterialStorageUrl = (fileUrl: string): {
  normalizedUrl: string;
  objectPath: string | null;
} => {
  const normalized = fileUrl.trim();
  if (!normalized) throw new Error('MATERIAL_URL_REQUIRED');
  const rawPath = normalized.split(/[?#]/, 1)[0];
  if (/%(?:2e|2f|5c|00)/i.test(rawPath) || /(?:^|\/)\.\.?(?:\/|$)/.test(rawPath)) {
    throw new Error('MATERIAL_PATH_INVALID');
  }

  const parsed = new URL(normalized);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('MATERIAL_URL_INVALID');
  }

  const marker = MATERIAL_STORAGE_MARKERS.find(candidate => parsed.pathname.startsWith(candidate));
  if (!marker) return { normalizedUrl: parsed.toString(), objectPath: null };

  const encodedPath = parsed.pathname.slice(marker.length);
  const objectPath = encodedPath
    .split('/')
    .map(segment => decodeURIComponent(segment))
    .join('/');
  if (!objectPath || objectPath.startsWith('/') || objectPath.split('/').includes('..')) {
    throw new Error('MATERIAL_PATH_INVALID');
  }

  return { normalizedUrl: parsed.toString(), objectPath };
};
