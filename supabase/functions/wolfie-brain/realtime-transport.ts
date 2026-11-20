/**
 * Which transport owns a Wolfie conversation.
 *
 * The database keeps one transport per conversation (trigger
 * guard_wolfie_session_turn_transport): a conversation that started in the
 * classic mode rejects live (OpenAI Realtime) turns with
 * wolfie_session_transport_mismatch. When the learner switches from Clássico to
 * Ao vivo, the live voice must open a new conversation instead of reusing the
 * classic one, or every live turn is lost (the screen shows the reply, the
 * server answers CONVERSATION_FINISHED and nothing is saved).
 */
export interface WolfieSessionTransportAnchors {
  realtime_first_client_turn_id?: string | null;
  classic_first_client_turn_id?: string | null;
  classic_handoff_at?: string | null;
}

export function canReuseSessionForRealtime(
  session: WolfieSessionTransportAnchors,
): boolean {
  if (session.classic_handoff_at) return false;
  return !session.classic_first_client_turn_id;
}
