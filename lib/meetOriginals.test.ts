import { describe, expect, it } from 'vitest';
import { erasureItems, erasureOriginalsText, originalsErrorText, readErasurePreview, readOriginalsStatus } from './meetOriginals';

const preview = (overrides: Record<string, unknown> = {}) => ({
  ok: true, sessions: 3, raw_copies: 2, attendance_reports: 1, drafts: 1, approved_summaries: 1,
  memories: 2, card: true, originals_pending: 2, originals_done: 1, rooms_to_discover: 1,
  rooms_beyond_window: 0, drive_delete_ready: true, last_erasure_at: null, ...overrides,
});

describe('prévia do pedido de exclusão', () => {
  it('resposta sem ok não vira prévia (a tela mostra o erro)', () => {
    expect(readErasurePreview(null)).toBeNull();
    expect(readErasurePreview({ ok: false })).toBeNull();
    expect(readErasurePreview({ ...preview(), sessions: -4 })?.sessions).toBe(0);
  });

  it('lista tudo o que será apagado, com singular e plural', () => {
    const items = erasureItems(readErasurePreview(preview())!);
    expect(items.map(item => item.key)).toEqual(['raw', 'attendance', 'drafts', 'memories', 'card']);
    expect(items[0].label).toBe('2 cópias da transcrição e das anotações guardadas no sistema');
    expect(items[1].label).toBe('1 relatório de presença guardado');
    expect(items[2].label).toBe('1 rascunho de resumo e 1 resumo aprovado');
    // Sem cartão, o item não aparece; zerados aparecem (a direção confere).
    const empty = erasureItems(readErasurePreview(preview({ card: false, raw_copies: 0 }))!);
    expect(empty.map(item => item.key)).not.toContain('card');
    expect(empty[0].label).toBe('0 cópias da transcrição e das anotações guardadas no sistema');
  });

  it('diz o que acontece com os originais no Drive, inclusive quando a lixeira não está autorizada', () => {
    expect(erasureOriginalsText(readErasurePreview(preview())!)).toBe(
      '2 originais vão para a lixeira do Google Drive da escola; 1 sala recente tem os documentos conferidos no Meet e também vai para a lixeira.');
    expect(erasureOriginalsText(readErasurePreview(preview({ drive_delete_ready: false }))!))
      .toContain('esperam a autorização');
    expect(erasureOriginalsText(readErasurePreview(preview({ originals_pending: 0, rooms_to_discover: 0, drive_delete_ready: false }))!))
      .toBe('Não há original no Google Drive esperando a lixeira para este aluno.');
    // Aula antiga sem lista conferida não é localizável sem busca por nome.
    expect(erasureOriginalsText(readErasurePreview(preview({ rooms_beyond_window: 2 }))!))
      .toContain('2 aulas antigas não tiveram a lista de documentos conferida a tempo');
  });
});

describe('situação da lixeira', () => {
  it('lê os números e usa 90 dias quando o servidor não diz', () => {
    const status = readOriginalsStatus({ ok: true, trashed: 4, due: '2', last_error_code: 'google_drive_scope_missing' })!;
    expect(status.trashed).toBe(4);
    expect(status.due).toBe(2);
    expect(status.trash_after_days).toBe(90);
    expect(readOriginalsStatus({})).toBeNull();
  });

  it('explica o motivo da falha em português, sem código cru', () => {
    expect(originalsErrorText('google_drive_scope_missing')).toContain('reconecte a conta central');
    expect(originalsErrorText('google_organizer_changed')).toContain('conta central anterior');
    expect(originalsErrorText('codigo_novo')).toBe('falha ao mover; nova tentativa em seguida');
    expect(originalsErrorText(null)).toBe('');
  });
});
