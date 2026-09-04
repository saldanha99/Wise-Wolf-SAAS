import { describe, expect, it } from 'vitest';

function deriveSlug(tenant: { slug?: string | null; name?: string | null; domain?: string | null; id?: string | null }): string {
  if (tenant.slug && tenant.slug.trim()) {
    return tenant.slug.trim();
  }
  const candidate = tenant.name || tenant.domain || tenant.id || 'escola';
  const cleaned = candidate
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned.length >= 3 ? cleaned : `${cleaned || 'escola'}-portal`.slice(0, 40);
}

describe('Tenant slug fallback and normalization', () => {
  it('preserves existing valid slug if present', () => {
    expect(deriveSlug({ slug: 'escola-modelo' })).toBe('escola-modelo');
  });

  it('derives valid slug from tenant name when slug is null or empty', () => {
    expect(deriveSlug({ slug: '', name: 'Colégio Ápice & Idiomas' })).toBe('colegio-apice-idiomas');
  });

  it('derives valid slug from domain if name is not available', () => {
    expect(deriveSlug({ slug: null, domain: 'idiomas-teste.com' })).toBe('idiomas-teste-com');
  });

  it('ensures minimum length requirements with padding when candidate is too short', () => {
    const slug = deriveSlug({ slug: '', name: 'a' });
    expect(slug.length).toBeGreaterThanOrEqual(3);
    expect(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(slug)).toBe(true);
  });
});
