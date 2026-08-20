import { describe, expect, it } from 'vitest';
import { nullableUuid } from './dbValues';

describe('nullableUuid', () => {
  it('converts missing and blank form values to null', () => {
    expect(nullableUuid(undefined)).toBeNull();
    expect(nullableUuid(null)).toBeNull();
    expect(nullableUuid('')).toBeNull();
    expect(nullableUuid('   ')).toBeNull();
  });

  it('keeps a selected UUID and trims incidental whitespace', () => {
    expect(nullableUuid(' 41e42bd8-ad01-40b2-a7fd-385f66951774 '))
      .toBe('41e42bd8-ad01-40b2-a7fd-385f66951774');
  });
});
