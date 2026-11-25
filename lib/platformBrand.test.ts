import { describe, expect, it } from 'vitest';
import { documentTitleFor, PLATFORM_NAME, PLATFORM_SIGNATURE, showsPlatformSignature } from './platformBrand';

describe('platformBrand', () => {
  it('signs only for the Wise Wolf tenant', () => {
    expect(showsPlatformSignature('school-wise-wolf')).toBe(true);
    expect(showsPlatformSignature('demo-escola')).toBe(false);
    expect(showsPlatformSignature(null)).toBe(false);
  });
  it('tab title is the school name, never the platform brand for a client school', () => {
    expect(documentTitleFor('Escola Demo')).toBe('Escola Demo');
    expect(documentTitleFor('  ')).toBe(PLATFORM_NAME);
    expect(documentTitleFor('Escola Demo')).not.toMatch(/WiseCore|EduCore/);
  });
  it('signature names WiseCore and Wise Wolf', () => {
    expect(PLATFORM_SIGNATURE).toBe('WiseCore — criada pela Wise Wolf');
  });
});
