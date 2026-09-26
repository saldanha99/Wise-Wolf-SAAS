// Textos da situação dos documentos do Meet (tela "Sala e resumo").
// Puro, sem Supabase: a tela e os testes usam direto.

// Motivo gravado em cada documento da aula (google_meet_artifact_imports) e na
// sala que o Google não criou. Código desconhecido vira texto genérico.
const ARTIFACT_ERRORS: Record<string,string> = {
  google_document_permission_required: 'a conta da escola não tem acesso ao documento',
  google_document_unavailable: 'o Google Docs não entregou o arquivo',
  google_document_missing: 'o Google não indicou o documento',
  google_document_not_generated: 'o Google não gerou o documento',
  google_document_too_large: 'o documento passa do tamanho aceito',
  google_meet_storage_unavailable: 'a plataforma não conseguiu gravar',
  google_permission_or_edition_required: 'o Google não liberou o recurso para esta conta',
  google_room_creation_uncertain: 'o Google não confirmou a criação',
  google_rate_limited: 'o Google pediu para esperar',
};
export function googleMeetIssueText(code: string | null | undefined): string {
  return (code && ARTIFACT_ERRORS[code]) || 'falha na comunicação com o Google';
}

export interface MeetArtifactImport {
  provider_name: string;
  kind: 'TRANSCRIPT' | 'SMART_NOTES';
  status: 'PENDING' | 'IMPORTED' | 'EMPTY' | 'FAILED';
  source: 'DRIVE_EXPORT' | 'MEET_ENTRIES' | null;
  last_error_code: string | null;
  failed_attempts: number;
}

/** Uma linha por documento na tela "Sala e resumo". */
export function describeArtifactImport(row: MeetArtifactImport): string {
  if (row.status === 'IMPORTED') {
    return row.source === 'MEET_ENTRIES'
      ? `Importada pelas falas da reunião (${googleMeetIssueText(row.last_error_code)}).`
      : 'Importado.';
  }
  if (row.status === 'EMPTY') return 'Sem fala registrada: o documento veio vazio.';
  if (row.status === 'PENDING') return 'O Google ainda está gerando o documento.';
  return `Não importado: ${googleMeetIssueText(row.last_error_code)}. Nova tentativa na próxima importação.`;
}
