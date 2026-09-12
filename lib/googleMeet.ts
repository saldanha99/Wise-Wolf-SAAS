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
  google_room_reconciliation_required: 'Uma criação anterior ficou sem confirmação. A administração precisa reconciliar a sala antes de tentar novamente.',
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
};
export async function googleMeetAction<T = any>(action: string, body: Record<string,unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('google-meet', { body: { ...body, action } });
  let payload = data;
  if (error) {
    try { payload = await (error as any).context?.json(); } catch { /* A network error may not have a response. */ }
  }
  if (error || payload?.error) {
    const code = typeof payload?.error === 'string' ? payload.error : '';
    throw new Error(MESSAGES[code] || 'Não foi possível concluir a operação com o Google Meet. Tente novamente ou consulte a administração.');
  }
  return payload as T;
}
