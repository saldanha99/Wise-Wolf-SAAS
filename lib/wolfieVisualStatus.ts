/**
 * Visual status of the Wolfie tutor.
 *
 * A provider notice (e.g. live voice unavailable because the voice provider has no credit) is information, not a
 * failure of the current answer: text practice keeps working. Only a real error may put the avatar in ERROR,
 * otherwise the HUD says "Não foi possível responder" and the caption hides a reply that the server did deliver.
 */
export type WolfieVisualBaseState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SYNTHESIZING' | 'SPEAKING' | 'INTERRUPTED';
export type WolfieVisualState = WolfieVisualBaseState | 'ERROR';

export function wolfieVisualState(error: string | null, state: WolfieVisualBaseState): WolfieVisualState {
  return error ? 'ERROR' : state;
}

/**
 * Caption for a classic (non-realtime) reply. When the reply is spoken, `speak()` drives the caption sentence by
 * sentence; when auto-speak is off (muted by the user or forced off because voice is unavailable) the reply must be
 * shown at once, or the learner sees an empty caption.
 */
export function classicReplyCaption(autoSpeakEnabled: boolean, replyText: string): string | null {
  const text = replyText.trim();
  if (!text || autoSpeakEnabled) return null;
  return text;
}

/**
 * How a live-voice fallback is shown. Every fallback hands the conversation to the classic mode, where the learner
 * can still type (and, when the microphone works, speak), so the answer is not lost: it is a notice, not an error.
 * Only an expired sign-in is a real error, because the classic mode would fail too.
 */
export type RealtimeFallbackPresentation = {
  kind: 'notice' | 'error';
  text: string;
  /** Voice replies stay off only when the voice provider itself is blocked. */
  disableAutoSpeak: boolean;
  /** Billing stays on screen; other notices fade after a few seconds. */
  persistent: boolean;
};

export function realtimeFallbackPresentation(reason: string, message: string): RealtimeFallbackPresentation {
  if (reason === 'authentication_required') {
    return { kind: 'error', text: message, disableAutoSpeak: false, persistent: false };
  }
  if (reason === 'provider_billing_blocked') {
    return { kind: 'notice', text: message, disableAutoSpeak: true, persistent: true };
  }
  const text = reason === 'microphone_unavailable'
    ? `${message} Você pode continuar digitando.`
    : `${message} O Wolfie seguiu no modo clássico: você pode digitar ou segurar para falar.`;
  return { kind: 'notice', text, disableAutoSpeak: false, persistent: false };
}
