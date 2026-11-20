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
