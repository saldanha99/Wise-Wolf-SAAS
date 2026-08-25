import { describe, expect, it } from 'vitest';
import { parseMaterialStorageUrl } from './materialStorageUrl';

describe('parseMaterialStorageUrl', () => {
  it('extracts legacy public storage paths', () => {
    expect(parseMaterialStorageUrl(
      'https://api.example.com/storage/v1/object/public/materials/1787356413788.pdf',
    ).objectPath).toBe('1787356413788.pdf');
  });

  it('extracts tenant-scoped authenticated paths', () => {
    expect(parseMaterialStorageUrl(
      'https://api.example.com/storage/v1/object/authenticated/materials/school-a/user-a/lesson%201.pdf',
    ).objectPath).toBe('school-a/user-a/lesson 1.pdf');
  });

  it('keeps approved external links outside storage signing', () => {
    const parsed = parseMaterialStorageUrl('https://example.com/material.pdf');
    expect(parsed.objectPath).toBeNull();
    expect(parsed.normalizedUrl).toBe('https://example.com/material.pdf');
  });

  it('does not treat an embedded storage-looking path as a Supabase object', () => {
    const parsed = parseMaterialStorageUrl(
      'https://example.com/proxy/storage/v1/object/public/materials/lesson.pdf',
    );
    expect(parsed.objectPath).toBeNull();
  });

  it.each([
    '',
    'javascript:alert(1)',
    'https://api.example.com/storage/v1/object/public/materials/',
    'https://api.example.com/storage/v1/object/public/materials/%2E%2E/secret.pdf',
  ])('rejects an unsafe material URL: %s', value => {
    expect(() => parseMaterialStorageUrl(value)).toThrow();
  });
});
