import { supabase } from './supabase';

const MESSAGES: Record<string,string> = {
  google_integration_not_configured: 'A conexão Google ainda precisa ser configurada pela administração.',
  google_pedagogy_disabled: 'A documentação pelo Meet ainda não foi ativada nesta instalação.',
  google_connection_required: 'Conecte a conta organizadora da escola.',
  google_reconnect_required: 'O acesso Google expirou ou foi revogado. Reconecte a conta organizadora.',
  google_permission_or_edition_required: 'O Google não liberou este recurso. Confira edição da conta, APIs habilitadas e permissões concedidas.',
  google_document_permission_required: 'A conta conectada não tem acesso a este documento do Meet.',
  documentation_consent_required: 'Registre a autorização de documentação desta aula antes de criar a sala ou importar conteúdo.',
  google_room_not_ready: 'A sala oficial ainda não foi criada e configurada.',
  google_room_reconciliation_required: 'Esta aula ficou com dois links de sala. A direção precisa escolher qual vale; enquanto isso, a aula usa o link de sempre.',
  google_room_creation_in_progress: 'A sala está sendo criada agora. Aguarde um minuto e atualize.',
  google_room_retry_scheduled: 'O Google recusou criar a sala. Uma nova tentativa automática já está agendada.',
  google_room_claim_lost: 'Outra tentativa de criar esta sala está em andamento. Atualize em instantes.',
  google_request_uncertain: 'O Google não confirmou a operação. Uma nova tentativa acontece sozinha.',
  google_oauth_unavailable: 'O Google não respondeu agora. A conexão continua ativa; tente de novo em alguns minutos.',
  google_oauth_rejected: 'O Google recusou as credenciais do aplicativo da escola. A administração precisa conferir a configuração OAuth.',
  google_organizer_changed: 'Esta sala pertence à conta organizadora anterior. Reconecte a mesma conta para acessar seus documentos.',
  google_identity_email_required: 'O professor precisa ter um e-mail Google válido no cadastro para receber o papel de coanfitrião.',
  google_summary_ai_not_configured: 'A estruturação adicional por IA está desativada. Você pode revisar as notas nativas manualmente.',
  google_summary_pricing_required: 'Cadastre o preço do modelo antes de gerar um resumo pela API.',
  google_summary_generation_rate_limited: 'Um resumo foi solicitado recentemente. Aguarde dois minutos antes de gerar novamente.',
  google_artifacts_required: 'Ainda não há documentos importados para produzir o resumo.',
  summary_objective_and_next_step_required: 'Preencha objetivo da aula e próximo passo antes de aprovar.',
  invalid_summary_evidence: 'Há uma citação que não corresponde à fonte importada. Revise as evidências.',
  google_meet_student_scope_required: 'Você não tem acesso pedagógico a este aluno.',
  google_meet_admin_required: 'Somente a direção pode conectar ou desconectar a conta organizadora.',
  google_resource_unavailable: 'O recurso não está disponível nesta conta Google. Confira a configuração com a administração.',
  google_cohost_setup_failed: 'A sala foi criada, mas o papel de coanfitrião ainda precisa ser configurado. Tente concluir a configuração.',
  // Parte 2 (migration 20260926180000): identidade do professor, troca de conta,
  // transcrição bruta e marcação manual.
  google_teacher_identity_required: 'O professor desta aula ainda não confirmou a conta Google dele (em "Salas e continuidade"). Sem isso a sala da escola não é criada e a aula usa o link de sempre.',
  teacher_google_identity_required: 'Confirme sua conta Google antes de autorizar: é ela que entra como coanfitriã da sala.',
  google_meet_teacher_required: 'Só o próprio professor confirma a conta Google dele.',
  google_identity_in_use: 'Esta conta Google já está confirmada para outro professor da escola.',
  google_identity_unverified: 'O Google não confirmou o e-mail desta conta. Use uma conta com e-mail verificado.',
  google_organizer_change_requires_confirmation: 'Esta não é a conta que criou as salas da escola. Para trocar de conta mesmo assim, use "Trocar para outra conta".',
  google_meet_raw_access_required: 'A transcrição e os rascunhos desta aula ficam só com o professor da aula, a coordenação e a direção.',
  google_room_update_unconfirmed: 'O Google não confirmou a mudança na sala. Uma nova tentativa acontece sozinha.',
  somente_a_direcao: 'Só a direção registra ou retira a autorização de documentação de uma aula.',
  registre_a_base_e_o_comprovante_da_autorizacao: 'Informe o motivo e onde está o comprovante (pelo menos 10 caracteres).',
  termo_recusado_ou_revogado_pelo_aluno: 'O aluno (ou o responsável) recusou ou revogou o registro das aulas. A escola não liga a documentação por cima dessa decisão.',
  termo_recusado_ou_revogado_pelo_professor: 'O professor recusou ou revogou o registro das aulas. A escola não liga a documentação por cima dessa decisão.',
  sem_permissao: 'Você não tem permissão para esta ação.',
};

/**
 * Texto para um erro do servidor (edge google-meet ou RPC do banco). A RPC
 * devolve o código dentro da mensagem; código desconhecido vira texto genérico.
 */
export function googleMeetErrorMessage(raw: string | null | undefined, fallback = 'Não foi possível concluir a operação com o Google Meet. Tente novamente ou consulte a administração.'): string {
  const textValue = String(raw || '');
  if (MESSAGES[textValue]) return MESSAGES[textValue];
  const code = Object.keys(MESSAGES).sort((a, b) => b.length - a.length).find(key => textValue.includes(key));
  return code ? MESSAGES[code] : fallback;
}
export async function googleMeetAction<T = any>(action: string, body: Record<string,unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('google-meet', { body: { ...body, action } });
  let payload = data;
  if (error) {
    try { payload = await (error as any).context?.json(); } catch { /* A network error may not have a response. */ }
  }
  if (error || payload?.error) {
    const code = typeof payload?.error === 'string' ? payload.error : '';
    throw new Error(googleMeetErrorMessage(code));
  }
  return payload as T;
}
