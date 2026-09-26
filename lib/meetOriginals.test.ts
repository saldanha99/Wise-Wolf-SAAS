import { describe, expect, it } from 'vitest';
import {
  erasureItems, erasureOriginalsText, erasureResultOriginalsText, originalsErrorText, readErasurePreview,
  readErasureResult, readOriginalsStatus, readTrashAvailability, trashState, UNKNOWN_TRASH_AVAILABILITY,
} from './meetOriginals';

const preview = (overrides: Record<string, unknown> = {}) => ({
  ok: true, sessions: 3, raw_copies: 2, attendance_reports: 1, drafts: 1, approved_summaries: 1,
  memories: 2, card: true, originals_pending: 2, originals_other_account: 0, originals_done: 1, rooms_to_discover: 1,
  rooms_other_account: 0, rooms_beyond_window: 0, rooms_attendance_unregistered: 0,
  discovery_deadline: '2026-10-20T15:00:00Z', connection_status: 'CONNECTED',
  drive_delete_ready: true, last_erasure_at: null, ...overrides,
});
const ACTIVE = { enabled: true, granted: true, attendanceEnabled: true };
const OFF = { enabled: false, granted: false, attendanceEnabled: true };

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

  it('plano do Planner com a base das aulas aprovadas: a base sai, o plano fica', () => {
    // Integração com o Planner (20260927130000): o item só aparece com plano afetado.
    expect(erasureItems(readErasurePreview(preview())!).map(item => item.key)).not.toContain('planner');
    const one = erasureItems(readErasurePreview(preview({ planner_basis: 1 }))!);
    expect(one.find(item => item.key === 'planner')?.label)
      .toBe('a base das aulas aprovadas copiada em 1 plano do Planner (o plano fica)');
    const many = erasureItems(readErasurePreview(preview({ planner_basis: 3 }))!);
    expect(many.find(item => item.key === 'planner')?.label)
      .toBe('a base das aulas aprovadas copiada em 3 planos do Planner (os planos ficam)');
    expect(readErasureResult({ ok: true, planner_basis_cleared: 2 })?.planner_basis_cleared).toBe(2);
  });

  it('lixeira ligada e autorizada: os originais vão para a lixeira, com o prazo da conferência', () => {
    expect(erasureOriginalsText(readErasurePreview(preview())!, ACTIVE)).toBe(
      '2 originais registrados vão para a lixeira do Google Drive da escola. '
      + '1 sala recente ainda tem a lista de documentos conferida no Meet até 20/10/2026; o que for achado vai para a lixeira.');
  });

  it('lixeira desligada, sem autorização ou desconhecida: NÃO promete a lixeira', () => {
    const off = erasureOriginalsText(readErasurePreview(preview())!, OFF);
    expect(off).toContain('a lixeira automática não está ligada nesta instalação');
    expect(off).toContain('o que for achado fica marcado para a lixeira');
    expect(off).not.toContain('vão para a lixeira do Google Drive');
    // Com a flag ligada e a conta sem o escopo drive, manda reconectar.
    const unauthorized = erasureOriginalsText(readErasurePreview(preview({ drive_delete_ready: false }))!,
      { enabled: true, granted: false, attendanceEnabled: true });
    expect(unauthorized).toContain('Reconectar conta central');
    // Escopo concedido não basta: com a flag desligada, a lixeira não está ligada.
    expect(trashState(OFF, true)).toBe('OFF');
    expect(erasureOriginalsText(readErasurePreview(preview())!)).toContain('não deu para confirmar');
    expect(erasureOriginalsText(readErasurePreview(preview({ originals_pending: 0, rooms_to_discover: 0 }))!, ACTIVE))
      .toBe('Não há original no Google Drive esperando a lixeira para este aluno.');
  });

  it('o que a conta atual não alcança vai para conferência manual', () => {
    const text = erasureOriginalsText(readErasurePreview(preview({
      originals_other_account: 2, rooms_other_account: 1, rooms_beyond_window: 2, rooms_attendance_unregistered: 3,
      connection_status: 'REAUTH_REQUIRED',
    }))!, ACTIVE);
    expect(text).toContain('3 originais ou salas são da conta central anterior');
    expect(text).toContain('apague à mão no Google Drive daquela conta');
    expect(text).toContain('2 aulas antigas não tiveram a lista de documentos conferida a tempo');
    expect(text).toContain('3 aulas não têm planilha de presença registrada pelo sistema');
    expect(text).toContain('(a conta central precisa estar conectada até lá)');
    // Instalação sem relatório de presença: nada de mandar conferir planilha.
    expect(erasureOriginalsText(readErasurePreview(preview({ rooms_attendance_unregistered: 3 }))!,
      { ...ACTIVE, attendanceEnabled: false })).not.toContain('planilha de presença');
    // Sem saber se há relatório: pergunta condicional.
    expect(erasureOriginalsText(readErasurePreview(preview({ rooms_attendance_unregistered: 1 }))!,
      { ...ACTIVE, attendanceEnabled: null })).toContain('Se o relatório de presença estiver ligado: 1 aula não tem');
  });

  it('resultado: diz o que entrou na lixeira só quando ela está ligada', () => {
    const result = readErasureResult({ ok: true, originals_queued: 1, sessions_to_discover: 0, rooms_other_account: 1 })!;
    expect(erasureResultOriginalsText(result, ACTIVE, true)).toBe(
      'O 1 original registrado entrou na fila da lixeira do Google Drive da escola. '
      + '1 original ou sala é da conta central anterior: só ela mexe nesses arquivos — apague à mão no Google Drive daquela conta.');
    expect(erasureResultOriginalsText(result, OFF, true)).toContain('só vai para ela quando for ligada');
    expect(readErasureResult({ ok: false })).toBeNull();
  });

  it('disponibilidade vem do status da edge; sem status, nada se sabe', () => {
    expect(readTrashAvailability({ drive_delete_enabled: true, drive_delete_granted: false, attendance_report_enabled: true }))
      .toEqual({ enabled: true, granted: false, attendanceEnabled: true });
    expect(readTrashAvailability(null)).toEqual(UNKNOWN_TRASH_AVAILABILITY);
    expect(trashState(UNKNOWN_TRASH_AVAILABILITY, true)).toBe('UNKNOWN');
  });
});

describe('situação da lixeira', () => {
  it('lê os números e usa 90 dias quando o servidor não diz', () => {
    const status = readOriginalsStatus({ ok: true, trashed: 4, due: '2', last_error_code: 'google_drive_scope_missing', attendance_unidentified: 1 })!;
    expect(status.trashed).toBe(4);
    expect(status.due).toBe(2);
    expect(status.trash_after_days).toBe(90);
    expect(status.attendance_unidentified).toBe(1);
    expect(readOriginalsStatus({})).toBeNull();
  });

  it('explica o motivo da falha em português, sem código cru', () => {
    expect(originalsErrorText('google_drive_scope_missing')).toContain('reconecte a conta central');
    expect(originalsErrorText('google_organizer_changed')).toContain('conta central anterior');
    expect(originalsErrorText('codigo_novo')).toBe('falha ao mover; nova tentativa em seguida');
    expect(originalsErrorText(null)).toBe('');
  });
});
