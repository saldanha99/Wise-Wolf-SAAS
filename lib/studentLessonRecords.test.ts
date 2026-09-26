import { describe, expect, it } from 'vitest';
import {
  consentStatusText,
  exclusionRequestUrl,
  formatClassDate,
  lessonRecordsErrorMessage,
  parseStudentLessonRecords,
  pendingReviewText,
  rawCopyText,
  revokeHowToText,
  type StudentRecordConsent,
} from './studentLessonRecords';

const baseConsent: StudentRecordConsent = {
  status: 'AUTHORIZED',
  decidedAt: '2026-09-20T15:00:00Z',
  signerRelation: 'GUARDIAN',
  requiresGuardian: true,
  guardianReason: 'AGE_UNKNOWN',
  linkExpiresAt: null,
};

describe('parseStudentLessonRecords', () => {
  it('lê a resposta da RPC e descarta o que não é texto', () => {
    const view = parseStudentLessonRecords({
      ok: true,
      school_name: 'Wise Wolf',
      school_whatsapp: '11988887777',
      consent: { status: 'NOT_EFFECTIVE', requires_guardian: true, guardian_reason: 'ESTRANHO', link_expires_at: '2026-10-05T12:00:00Z' },
      term: { version: 'v2', body: 'Texto do termo.' },
      pending_review: 2,
      records: [
        {
          session_id: 's1', class_date: '2026-09-23', scheduled_start_at: '2026-09-23T17:00:00Z',
          teacher_name: 'Teacher Lais', lesson_objective: ' Pedir comida ',
          content_practiced: ['would like', '', 42, 'menu'], recommended_next_step: 'Reclamar com educação',
          homework_assigned: null, raw_copy_until: '2026-12-22T17:30:00Z',
        },
        { lesson_objective: 'sem id — descartado' },
      ],
    });
    expect(view).not.toBeNull();
    expect(view!.records).toHaveLength(1);
    expect(view!.records[0]).toMatchObject({
      sessionId: 's1', objective: 'Pedir comida', practiced: ['would like', 'menu'], homework: null,
    });
    // Motivo fora da lista com responsável exigido conta como idade desconhecida.
    expect(view!.consent).toMatchObject({ status: 'NOT_EFFECTIVE', requiresGuardian: true, guardianReason: 'AGE_UNKNOWN' });
    expect(view!.pendingReview).toBe(2);
    expect(view!.term).toEqual({ version: 'v2', body: 'Texto do termo.' });
  });

  it('resposta sem ok ou com status desconhecido não inventa autorização', () => {
    expect(parseStudentLessonRecords(null)).toBeNull();
    expect(parseStudentLessonRecords({ records: [] })).toBeNull();
    const view = parseStudentLessonRecords({ ok: true, consent: { status: 'TALVEZ' }, records: 'x' });
    expect(view!.consent.status).toBe('NONE');
    expect(view!.records).toEqual([]);
    expect(view!.term).toBeNull();
  });
});

describe('textos da tela', () => {
  it('data da aula sai do dia da escola, sem virar o dia pelo fuso', () => {
    expect(formatClassDate({ classDate: '2026-09-01', startsAt: '2026-09-02T02:30:00Z' })).toBe('01/09/2026');
  });

  it('cópia bruta: com data diz até quando; sem data, que já foi apagada', () => {
    expect(rawCopyText('2026-12-22T17:30:00Z')).toContain('22/12/2026');
    expect(rawCopyText(null)).toContain('já foi apagada');
    expect(pendingReviewText(0)).toBe('');
    expect(pendingReviewText(1)).toContain('1 aula');
  });

  it('revogar: com link vivo aponta o link; sem link, a escola', () => {
    expect(revokeHowToText({ ...baseConsent, linkExpiresAt: '2026-10-05T12:00:00Z' }))
      .toMatch(/link do termo .*WhatsApp do seu responsável.*05\/10\/2026.*Não autorizo/);
    expect(revokeHowToText({ ...baseConsent, requiresGuardian: false }))
      .toBe('Para revogar, peça à escola pelo WhatsApp: ela registra a revogação ou manda um link novo do termo para o WhatsApp do seu cadastro.');
  });

  it('situação do termo é dita sem prometer transcrição que não acontece', () => {
    expect(consentStatusText(baseConsent)).toContain('pelo seu responsável');
    expect(consentStatusText({ ...baseConsent, status: 'NOT_EFFECTIVE' })).toContain('não vale');
    expect(consentStatusText({ ...baseConsent, status: 'REVOKED' })).toContain('revogada');
    expect(consentStatusText({ ...baseConsent, status: 'NONE', decidedAt: null })).toContain('Ainda não há resposta');
  });

  it('pedido de exclusão vai pronto para o WhatsApp da escola; sem número, sem link', () => {
    const url = exclusionRequestUrl({ schoolName: 'Wise Wolf', schoolWhatsapp: '11988887777' });
    expect(url).toMatch(/^https:\/\/wa\.me\/5511988887777\?text=/);
    expect(decodeURIComponent(url!.split('text=')[1])).toContain('exclusão do registro das minhas aulas');
    expect(exclusionRequestUrl({ schoolName: 'Wise Wolf', schoolWhatsapp: null })).toBeNull();
  });

  it('erro da RPC vira texto para o aluno', () => {
    expect(lessonRecordsErrorMessage({ code: 'PGRST202', message: 'Could not find the function' })).toContain('ainda não está disponível');
    expect(lessonRecordsErrorMessage({ code: '42501', message: 'somente_o_aluno' })).toContain('próprio aluno');
    expect(lessonRecordsErrorMessage(null)).toContain('Não foi possível');
  });
});
