import { describe, expect, it } from 'vitest';
import { chunk, SYNC_BATCH_SIZE } from './HubBulkApproval';

describe('HubBulkApproval', () => {
  it('copies to the Hub in batches of at most 5 (sync-hub-material dies past 150 s)', () => {
    expect(SYNC_BATCH_SIZE).toBe(5);
    const ids = Array.from({ length: 49 }, (_, i) => `id-${i}`);
    const batches = chunk(ids, SYNC_BATCH_SIZE);
    expect(batches).toHaveLength(10);
    expect(batches.every(b => b.length <= 5)).toBe(true);
    expect(batches.flat()).toEqual(ids);
  });

  it('handles an empty list', () => {
    expect(chunk([], SYNC_BATCH_SIZE)).toEqual([]);
  });
});

describe('HubBulkApproval approve batches', () => {
  it('splits the approval into calls of at most 200 ids (RPC cap)', async () => {
    const { APPROVE_BATCH_SIZE } = await import('./HubBulkApproval');
    expect(APPROVE_BATCH_SIZE).toBe(200);
    expect(chunk(Array.from({ length: 401 }, (_, i) => i), APPROVE_BATCH_SIZE).map(b => b.length)).toEqual([200, 200, 1]);
  });
});
