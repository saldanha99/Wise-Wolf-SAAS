import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

import MeetOriginalsRetentionCard from './MeetOriginalsRetentionCard';

const status = (overrides: Record<string, unknown> = {}) => ({
  ok: true, trash_after_days: 90, drive_delete_ready: true, waiting: 12, next_due_at: '2026-12-01T15:00:00Z',
  due: 0, failing: 0, last_error_code: null, other_account: 0, trashed: 7, gone: 1, refused: 0,
  last_trashed_at: '2026-09-27T12:00:00Z', erasures: 0, last_erasure_at: null, ...overrides,
});

beforeEach(() => rpc.mockReset());

describe('Originais no Drive (direção)', () => {
  it('mostra o que já foi para a lixeira e o que espera o prazo', async () => {
    rpc.mockResolvedValue({ data: status(), error: null });
    render(<MeetOriginalsRetentionCard deleteEnabled deleteGranted />);
    await screen.findByText(/na lixeira/);
    expect(rpc).toHaveBeenCalledWith('get_meet_originals_retention_status');
    expect(screen.getByText('7').closest('li')?.textContent).toBe('7 na lixeira (último em 27/09/2026)');
    expect(screen.getByText('12').closest('li')?.textContent).toBe('12 aguardando o prazo (próximo em 01/12/2026)');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lixeira ligada sem a permissão nova: pede para reconectar; falha aparece com o motivo', async () => {
    rpc.mockResolvedValue({ data: status({ failing: 2, last_error_code: 'google_drive_scope_missing', other_account: 1 }), error: null });
    render(<MeetOriginalsRetentionCard deleteEnabled deleteGranted={false} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Reconectar conta central');
    expect((await screen.findByTestId('originals-failing')).textContent).toContain('2 arquivos não foram movidos ainda: a conta central ainda não autorizou');
    expect(screen.getByText(/conta central anterior: só ela consegue movê-los/)).toBeTruthy();
  });

  it('lixeira desligada na instalação é dita com clareza', async () => {
    rpc.mockResolvedValue({ data: status({ trashed: 0 }), error: null });
    render(<MeetOriginalsRetentionCard deleteEnabled={false} deleteGranted={false} />);
    expect(await screen.findByText(/ainda não foi ligada nesta instalação/)).toBeTruthy();
  });
});
