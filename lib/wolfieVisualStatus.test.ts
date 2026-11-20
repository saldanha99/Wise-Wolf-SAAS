import { describe, expect, it } from 'vitest';
import { classicReplyCaption, wolfieVisualState } from './wolfieVisualStatus';

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
