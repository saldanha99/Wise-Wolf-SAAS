import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  invoke: vi.fn(),
}));

const realtimeController = vi.hoisted(() => ({
  phase: 'idle',
  connected: false,
  isUserSpeaking: false,
  isAssistantSpeaking: false,
  userTranscript: '',
  assistantTranscript: '',
  lastUserTranscript: '',
  lastAssistantTranscript: '',
  lastCompletedTurn: null,
  userTranscriptConfidence: null,
  inputTranscriptIsRoughGuide: true,
  localAudioLevel: 0,
  remoteAudioLevel: 0,
  muted: false,
  error: null,
  fallbackReason: null,
  connect: vi.fn(async () => ({ ok: false, fallback: true })),
  disconnect: vi.fn(),
  interrupt: vi.fn(() => false),
  sendText: vi.fn(() => false),
  applyServerGuidance: vi.fn(async () => true),
  setMuted: vi.fn(),
  toggleMuted: vi.fn(),
  resumeAudio: vi.fn(async () => true),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: supabaseMocks.rpc,
    from: supabaseMocks.from,
    functions: { invoke: supabaseMocks.invoke },
  },
}));

vi.mock('../src/services/useWolfieRealtime', () => ({
  useWolfieRealtime: () => realtimeController,
}));

vi.mock('../src/components/wolfie/visuals/featureFlags', () => ({
  WOLFIE_SCENARIO_UI_V2_ENABLED: false,
}));

vi.mock('./WolfieAvatar', () => ({
  WolfieAvatar: () => <div aria-label="Avatar nativo do Wolfie" />,
}));

import WolfieTutor from './WolfieTutor';

const accountId = '11111111-1111-4111-8111-111111111111';

const renderHubTutor = (
  account = accountId,
  onUsageCommitted = vi.fn(),
  onClose?: (summary: any) => void,
) => {
  render(
    <WolfieTutor
      user={{ name: 'Marina', levelBadge: 'B2' }}
      voiceMode={false}
      topic="Entrevistas"
      experienceMode="interview"
      correctionMode="selective"
      languageMode="bilingual"
      difficulty="adaptive"
      scenario="Uma entrevista para uma vaga internacional."
      studentGoal="Responder com exemplos concretos."
      targetSkill="speaking, writing"
      experienceId="job-interviews"
      experienceUniverse="career"
      experienceAudiences={['adult', 'professional']}
      hubContext={{
        accountId: account,
        onUsageCommitted,
      }}
      onClose={onClose}
    />,
  );
  return { onUsageCommitted };
};

describe('Transporte do Wolfie no Hub', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        cancel: vi.fn(),
        getVoices: vi.fn(() => []),
        onvoiceschanged: null,
        speak: vi.fn(),
      },
    });
  });

  beforeEach(() => {
    supabaseMocks.rpc.mockReset();
    supabaseMocks.from.mockReset();
    supabaseMocks.invoke.mockReset();
  });

  afterEach(() => cleanup());

  it('pula tier e histórico escolares e envia somente texto pela API autorizada do Hub', async () => {
    supabaseMocks.invoke.mockResolvedValue({
      data: {
        aiText: 'Tell me about a result you are proud of.',
        conversationId: '22222222-2222-4222-8222-222222222222',
      },
      error: null,
    });
    const onUsageCommitted = vi.fn();
    renderHubTutor(accountId, onUsageCommitted);

    const input = screen.getByPlaceholderText('Type in English...');
    fireEvent.change(input, { target: { value: 'I improved retention by 20%.' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(supabaseMocks.invoke).toHaveBeenCalledTimes(1));
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(supabaseMocks.from).not.toHaveBeenCalled();
    expect(supabaseMocks.invoke).toHaveBeenCalledWith(
      'wolf-tutor-api',
      expect.objectContaining({
        body: expect.objectContaining({
          hubMode: true,
          accountId,
          text: 'I improved retention by 20%.',
          studentLevel: 'B2',
          includeAudio: false,
          requestKey: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        }),
      }),
    );
    expect(supabaseMocks.invoke.mock.calls[0]?.[1]?.body).not.toHaveProperty('learnerProfile');
    await waitFor(() => expect(onUsageCommitted).toHaveBeenCalledTimes(1));
  });

  it('falha fechado quando o contexto da conta não é um UUID', async () => {
    renderHubTutor('conta-invalida');

    const input = screen.getByPlaceholderText('Type in English...');
    fireEvent.change(input, { target: { value: 'Hello Wolfie' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('Não foi possível confirmar a conta desta assinatura.')).toBeTruthy();
    expect(supabaseMocks.invoke).not.toHaveBeenCalled();
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(supabaseMocks.from).not.toHaveBeenCalled();
  });

  it('não fecha nem conclui a sessão enquanto um turno ainda está sendo processado', async () => {
    let resolveRequest: ((value: {
      data: Record<string, unknown>;
      error: null;
    }) => void) | undefined;
    supabaseMocks.invoke.mockReturnValue(new Promise(resolve => {
      resolveRequest = resolve;
    }));
    const onClose = vi.fn();
    const onUsageCommitted = vi.fn();
    renderHubTutor(accountId, onUsageCommitted, onClose);

    const input = screen.getByPlaceholderText('Type in English...');
    fireEvent.change(input, { target: { value: 'I led a complex migration.' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(supabaseMocks.invoke).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /fechar wolfie tutor/i }));

    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/aguarde o wolfie confirmar este turno/i)).toBeTruthy();

    resolveRequest?.({
      data: {
        aiText: 'That is a strong example.',
        conversationId: '22222222-2222-4222-8222-222222222222',
      },
      error: null,
    });
    await waitFor(() => expect(onUsageCommitted).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /fechar wolfie tutor/i }));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({
      learnerTurns: 1,
      sessionCompleted: false,
      conversationId: '22222222-2222-4222-8222-222222222222',
    }));
  });
});
