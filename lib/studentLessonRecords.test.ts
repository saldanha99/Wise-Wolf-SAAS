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
  notEffectiveReason: null,
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
          homework_assigned: null, transcript_until: '2026-12-22T17:30:00Z', notes_until: null,
          attendance_until: 42,
        },
        { lesson_objective: 'sem id — descartado' },
      ],
    });
    expect(view).not.toBeNull();
    expect(view!.records).toHaveLength(1);
    expect(view!.records[0]).toMatchObject({
      sessionId: 's1', objective: 'Pedir comida', practiced: ['would like', 'menu'], homework: null,
      transcriptUntil: '2026-12-22T17:30:00Z', notesUntil: null, attendanceUntil: null,
    });
    // Motivo fora da lista com responsável exigido conta como idade desconhecida.
    expect(view!.consent).toMatchObject({ status: 'NOT_EFFECTIVE', requiresGuardian: true, guardianReason: 'AGE_UNKNOWN', notEffectiveReason: null });
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

  it('cópia bruta: cada tipo com o próprio nome e prazo; nunca "fica só este resumo"', () => {
    // A presença pode durar mais que a transcrição: o prazo dela não vira
    // "a transcrição fica até…".
    const both = rawCopyText({
      transcriptUntil: '2026-11-05T17:30:00Z', notesUntil: null, attendanceUntil: '2026-11-15T17:30:00Z',
    });
    expect(both).toContain('transcrição até 05/11/2026');
    expect(both).toContain('relatório de presença até 15/11/2026');
    expect(both).not.toMatch(/transcrição até 15\/11\/2026/);
    // Aprovada só a partir das anotações: não existe transcrição a citar.
    const notes = rawCopyText({ transcriptUntil: null, notesUntil: '2026-10-26T12:00:00Z', attendanceUntil: null });
    expect(notes).toBe('Cópias desta aula no sistema da escola: anotações do Google até 26/10/2026. Depois disso, são apagadas.');
    expect(notes).not.toContain('transcrição');
    // Sem cópia viva: não afirma que houve transcrição nem que "fica só o resumo".
    const none = rawCopyText({ transcriptUntil: null, notesUntil: null, attendanceUntil: null });
    expect(none).toContain('Nenhuma cópia');
    for (const text of [both, notes, none]) expect(text).not.toMatch(/fica só/);
  });

  it('pendentes: esperam a revisão do professor, sem dizer que é só transcrição', () => {
    expect(pendingReviewText(0)).toBe('');
    expect(pendingReviewText(1)).toContain('1 aula registrada está esperando a revisão');
    expect(pendingReviewText(1)).toContain('transcrição ou as anotações');
    expect(pendingReviewText(3)).toContain('3 aulas registradas');
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
    // Termo v3: quem aceitou a versão anterior lê que o termo mudou — não que
    // falta o código do WhatsApp (era o texto que sobrava sem o motivo).
    const updated = consentStatusText({ ...baseConsent, status: 'NOT_EFFECTIVE', notEffectiveReason: 'TERM_UPDATED' });
    expect(updated).toContain('O termo mudou depois da autorização de 20/09/2026');
    expect(updated).toContain('o seu responsável ler e aceitar a versão nova');
    expect(updated).not.toContain('código do WhatsApp');
    expect(consentStatusText({ ...baseConsent, status: 'NOT_EFFECTIVE', requiresGuardian: false, notEffectiveReason: 'TERM_UPDATED' }))
      .toContain('você ler e aceitar a versão nova');
    expect(consentStatusText({ ...baseConsent, status: 'NOT_EFFECTIVE', requiresGuardian: false, notEffectiveReason: 'UNVERIFIED' }))
      .toContain('código do WhatsApp');
    expect(consentStatusText({ ...baseConsent, status: 'NOT_EFFECTIVE', requiresGuardian: false, notEffectiveReason: 'GUARDIAN_REQUIRED' }))
      .toContain('seu responsável');
    expect(consentStatusText({ ...baseConsent, status: 'REVOKED' })).toContain('revogada');
    expect(consentStatusText({ ...baseConsent, status: 'NONE', decidedAt: null })).toContain('Ainda não há resposta');
  });

  it('pedido de exclusão vai pronto para o WhatsApp da escola; sem número, sem link', () => {
    const url = exclusionRequestUrl({ schoolName: 'Wise Wolf', schoolWhatsapp: '11988887777' });
    expect(url).toMatch(/^https:\/\/wa\.me\/5511988887777\?text=/);
    const message = decodeURIComponent(url!.split('text=')[1]);
    expect(message).toContain('exclusão do registro das minhas aulas');
    // A mensagem é o pedido do aluno, não uma lista do que a escola apaga.
    expect(message).not.toMatch(/resumos aprovados|transcrições/);
    expect(exclusionRequestUrl({ schoolName: 'Wise Wolf', schoolWhatsapp: null })).toBeNull();
  });

  it('erro da RPC vira texto para o aluno', () => {
    expect(lessonRecordsErrorMessage({ code: 'PGRST202', message: 'Could not find the function' })).toContain('ainda não está disponível');
    expect(lessonRecordsErrorMessage({ code: '42501', message: 'somente_o_aluno' })).toContain('próprio aluno');
    expect(lessonRecordsErrorMessage(null)).toContain('Não foi possível');
  });
});
