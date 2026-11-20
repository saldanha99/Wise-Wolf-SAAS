import { describe, expect, it } from 'vitest';
import { classicReplyCaption, realtimeFallbackPresentation, wolfieVisualState } from './wolfieVisualStatus';

describe('wolfieVisualState', () => {
  it('stays in the real state when there is no error (a voice notice is not an error)', () => {
    expect(wolfieVisualState(null, 'IDLE')).toBe('IDLE');
    expect(wolfieVisualState(null, 'THINKING')).toBe('THINKING');
  });

  it('switches to ERROR only for a real error', () => {
    expect(wolfieVisualState('Erro ao conectar.', 'IDLE')).toBe('ERROR');
  });
});

describe('classicReplyCaption', () => {
  const reply = "Hello, Gabriela! I'm Wolfie. Let's talk about your daily routine.";

  it('shows the reply at once when auto-speak is off (voice unavailable or muted)', () => {
    expect(classicReplyCaption(false, reply)).toBe(reply);
  });

  it('leaves the caption to speak() when auto-speak is on', () => {
    expect(classicReplyCaption(true, reply)).toBeNull();
  });

  it('ignores empty replies', () => {
    expect(classicReplyCaption(false, '   ')).toBeNull();
  });
});

describe('realtimeFallbackPresentation', () => {
  it('shows a denied microphone as a notice, not as a failed answer', () => {
    const shown = realtimeFallbackPresentation(
      'microphone_unavailable',
      'Não foi possível acessar o microfone. Verifique a permissão do navegador.',
    );
    expect(shown.kind).toBe('notice');
    expect(shown.text).toContain('continuar digitando');
    expect(shown.disableAutoSpeak).toBe(false);
    expect(wolfieVisualState(null, 'IDLE')).toBe('IDLE');
  });

  it('keeps the billing notice on screen and voice replies off', () => {
    const shown = realtimeFallbackPresentation('provider_billing_blocked', 'A voz está indisponível.');
    expect(shown).toMatchObject({ kind: 'notice', disableAutoSpeak: true, persistent: true });
  });

  it('treats connection problems as a notice that fades', () => {
    expect(realtimeFallbackPresentation('connection_failed', 'A conexão caiu.')).toMatchObject({
      kind: 'notice',
      persistent: false,
    });
  });

  it('keeps an expired sign-in as a real error', () => {
    expect(realtimeFallbackPresentation('authentication_required', 'Entre de novo.').kind).toBe('error');
  });
});
