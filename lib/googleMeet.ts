import { supabase } from "./supabase";
const messages: Record<string, string> = {
  google_not_configured:
    "A escola ainda precisa configurar a integração Google.",
  google_connection_required: "Conecte sua conta Google para criar a sala.",
  google_reconnect_required: "Reconecte sua conta Google e tente novamente.",
  google_permission_or_plan:
    "O Google não autorizou esta operação. Verifique a licença de transcrição e as permissões da conta.",
  google_rate_limit:
    "O Google está recebendo muitas solicitações. Tente novamente em alguns minutos.",
  google_unavailable:
    "O Google não respondeu. Tente novamente em alguns minutos.",
  room_creation_needs_review:
    "A criação desta sala precisa ser conferida pela equipe antes de tentar novamente.",
  room_creation_in_progress:
    "A sala já está sendo criada. Atualize a lista em alguns instantes.",
  analysis_already_started:
    "Esta análise já foi iniciada. Atualize a lista; se continuar pendente, avise a coordenação.",
  analysis_needs_review:
    "Não foi possível validar as evidências da análise. A equipe precisa conferir esta transcrição.",
  analysis_not_configured:
    "A análise pedagógica ainda não foi configurada pela escola.",
  transcript_expired: "O prazo de acesso ao texto desta transcrição terminou.",
  analysis_too_large:
    "Esta transcrição é longa demais para análise automática. Solicite revisão da coordenação.",
  booking_not_authorized:
    "Este agendamento não está mais vinculado ao seu perfil.",
  room_student_changed:
    "O aluno deste agendamento mudou. Solicite uma nova sala à coordenação.",
};
export async function googleMeet<T = any>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("google-meet", {
    body: { ...body, action },
  });
  let code = data?.error;
  if (error) {
    try {
      code = (await error.context?.json())?.error || code;
    } catch { /* generic message below */ }
  }
  if (error || code) {
    throw new Error(
      messages[code] ||
        "Não foi possível concluir esta operação. Tente novamente ou avise a coordenação.",
    );
  }
  return data as T;
}
