import { describe, expect, it } from 'vitest';
import {
  isWolfieTutorCloseBlocked,
  registerConfirmedWolfieTurn,
  resolveWolfieTutorSessionSummary,
} from './wolfieTutorSession';

describe('resumo autoritativo da sessão do Wolfie', () => {
  it.each([
    ['THINKING', false, false],
    ['LISTENING', false, false],
    ['IDLE', true, false],
    ['IDLE', false, true],
  ])('bloqueia fechamento em %s ou com persistência/confirmação pendente', (
    callState,
    classicRequestPending,
    realtimePersistencePending,
  ) => {
    expect(isWolfieTutorCloseBlocked({
      callState,
      classicRequestPending,
      realtimePersistencePending,
      confirmationPending: false,
      transcriptReviewPending: false,
    })).toBe(true);
  });

  it('conta apenas turnos substantivos confirmados e não duplica retries', () => {
    const confirmedTurnIds = new Set<string>();

    expect(registerConfirmedWolfieTurn(confirmedTurnIds, 'turn-1', false)).toBe(false);
    expect(registerConfirmedWolfieTurn(confirmedTurnIds, 'turn-1', true)).toBe(true);
    expect(registerConfirmedWolfieTurn(confirmedTurnIds, 'turn-1', true)).toBe(false);
    expect(registerConfirmedWolfieTurn(confirmedTurnIds, 'turn-2', true)).toBe(true);
    expect(confirmedTurnIds).toEqual(new Set(['turn-1', 'turn-2']));
  });

  it('só conclui com dois turnos confirmados, conversa verificável e sem trabalho pendente', () => {
    const base = {
      confirmedLearnerTurns: 2,
      retryRequired: false,
      sessionScore: 84.6,
      conversationId: 'conversation-1',
    };

    expect(resolveWolfieTutorSessionSummary({
      ...base,
      processingPending: false,
    })).toEqual({
      learnerTurns: 2,
      sessionCompleted: true,
      sessionScore: 85,
      conversationId: 'conversation-1',
    });

    expect(resolveWolfieTutorSessionSummary({
      ...base,
      processingPending: true,
    }).sessionCompleted).toBe(false);
    expect(resolveWolfieTutorSessionSummary({
      ...base,
      processingPending: false,
      retryRequired: true,
    }).sessionCompleted).toBe(false);
    expect(resolveWolfieTutorSessionSummary({
      ...base,
      processingPending: false,
      confirmedLearnerTurns: 1,
    }).sessionCompleted).toBe(false);
    expect(resolveWolfieTutorSessionSummary({
      ...base,
      processingPending: false,
      conversationId: null,
    }).sessionCompleted).toBe(false);
  });
});
