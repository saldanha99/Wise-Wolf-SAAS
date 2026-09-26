// Originais das aulas no Google Drive da escola → lixeira (migration
// 20260927120000) e o pedido de exclusão dos registros de um aluno.
//
// Decisão da direção (26/09/2026): documento da transcrição, das anotações do
// Gemini e planilha de presença vão para a LIXEIRA do Drive da conta central 90
// dias depois da aula; a direção apaga tudo de um aluno a pedido dele. O
// servidor só move arquivo cujo id veio da Meet API ou da planilha que o sistema
// guardou — nunca procura por nome. Estas regras só descrevem o estado para a
// tela; quem decide é o banco.

/** get_meet_originals_retention_status (direção, "Conta central Google"). */
export interface MeetOriginalsStatus {
  ok: boolean;
  trash_after_days: number;
  drive_delete_ready: boolean;
  waiting: number;
  next_due_at: string | null;
  due: number;
  failing: number;
  last_error_code: string | null;
  other_account: number;
  trashed: number;
  gone: number;
  refused: number;
  last_trashed_at: string | null;
  erasures: number;
  last_erasure_at: string | null;
}

/** get_student_lesson_records_erasure_preview (direção, ficha do aluno). */
export interface ErasurePreview {
  sessions: number;
  raw_copies: number;
  attendance_reports: number;
  drafts: number;
  approved_summaries: number;
  memories: number;
  card: boolean;
  originals_pending: number;
  originals_done: number;
  rooms_to_discover: number;
  rooms_beyond_window: number;
  drive_delete_ready: boolean;
  last_erasure_at: string | null;
}

export interface ErasureResult {
  sessions: number;
  raw_copies_deleted: number;
  attendance_reports_deleted: number;
  summary_versions_deleted: number;
  memories_deleted: number;
  card_deleted: boolean;
  originals_queued: number;
  sessions_to_discover: number;
}

const count = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
};
const when = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

/** Lê a prévia do servidor; resposta sem ok vira null (a tela mostra o erro). */
export function readErasurePreview(raw: unknown): ErasurePreview | null {
  if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
  const data = raw as Record<string, unknown>;
  return {
    sessions: count(data.sessions),
    raw_copies: count(data.raw_copies),
    attendance_reports: count(data.attendance_reports),
    drafts: count(data.drafts),
    approved_summaries: count(data.approved_summaries),
    memories: count(data.memories),
    card: data.card === true,
    originals_pending: count(data.originals_pending),
    originals_done: count(data.originals_done),
    rooms_to_discover: count(data.rooms_to_discover),
    rooms_beyond_window: count(data.rooms_beyond_window),
    drive_delete_ready: data.drive_delete_ready === true,
    last_erasure_at: when(data.last_erasure_at),
  };
}

/**
 * O que será apagado, na ordem em que a tela lista. Itens zerados aparecem
 * também (a direção confere que não há nada ali), exceto o cartão ausente.
 */
export function erasureItems(preview: ErasurePreview): { key: string; label: string }[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const items = [
    { key: 'raw', label: `${plural(preview.raw_copies, 'cópia', 'cópias')} da transcrição e das anotações guardadas no sistema` },
    { key: 'attendance', label: `${plural(preview.attendance_reports, 'relatório', 'relatórios')} de presença guardado${preview.attendance_reports === 1 ? '' : 's'}` },
    { key: 'drafts', label: `${plural(preview.drafts, 'rascunho', 'rascunhos')} de resumo e ${plural(preview.approved_summaries, 'resumo aprovado', 'resumos aprovados')}` },
    { key: 'memories', label: `${plural(preview.memories, 'registro', 'registros')} de memória vindo${preview.memories === 1 ? '' : 's'} das aulas no Meet` },
  ];
  if (preview.card) items.push({ key: 'card', label: 'o cartão do aluno (objetivo, temas e preferências)' });
  return items;
}

/** O que acontece com os originais no Google Drive da escola. */
export function erasureOriginalsText(preview: ErasurePreview): string {
  const parts: string[] = [];
  if (preview.originals_pending) {
    parts.push(`${preview.originals_pending} ${preview.originals_pending === 1 ? 'original vai' : 'originais vão'} para a lixeira do Google Drive da escola`);
  }
  if (preview.rooms_to_discover) {
    parts.push(`${preview.rooms_to_discover} ${preview.rooms_to_discover === 1 ? 'sala recente tem' : 'salas recentes têm'} os documentos conferidos no Meet e também vai para a lixeira`);
  }
  const base = parts.length
    ? `${parts.join('; ')}.`
    : 'Não há original no Google Drive esperando a lixeira para este aluno.';
  const waiting = preview.drive_delete_ready || !(preview.originals_pending || preview.rooms_to_discover)
    ? ''
    : ' A lixeira do Drive ainda não está autorizada na conta central: esses originais esperam a autorização (Conta central Google).';
  const old = preview.rooms_beyond_window
    ? ` ${preview.rooms_beyond_window} ${preview.rooms_beyond_window === 1 ? 'aula antiga não teve' : 'aulas antigas não tiveram'} a lista de documentos conferida a tempo: confira na pasta "Meet Recordings" do Drive da escola.`
    : '';
  return `${base}${waiting}${old}`;
}

// Motivos por arquivo (último erro da lixeira), em português.
const ORIGINAL_ERRORS: Record<string, string> = {
  google_drive_delete_disabled: 'a lixeira dos originais está desligada nesta instalação',
  google_drive_scope_missing: 'a conta central ainda não autorizou mover arquivos para a lixeira — reconecte a conta central',
  google_organizer_changed: 'os arquivos são da conta central anterior; só ela consegue movê-los',
  google_permission_or_edition_required: 'o Google recusou a operação — confira as permissões da conta central',
  google_reconnect_required: 'o acesso Google expirou — reconecte a conta central',
  google_drive_trash_unconfirmed: 'o Google não confirmou a lixeira; nova tentativa em seguida',
  google_rate_limited: 'o Google pediu para esperar; nova tentativa em seguida',
  google_request_uncertain: 'o Google não respondeu; nova tentativa em seguida',
  google_provider_error: 'o Google falhou; nova tentativa em seguida',
};
export function originalsErrorText(code: string | null | undefined): string {
  const value = String(code || '');
  return ORIGINAL_ERRORS[value] || (value ? 'falha ao mover; nova tentativa em seguida' : '');
}

/** Lê a situação da lixeira; resposta sem ok vira null. */
export function readOriginalsStatus(raw: unknown): MeetOriginalsStatus | null {
  if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
  const data = raw as Record<string, unknown>;
  return {
    ok: true,
    trash_after_days: count(data.trash_after_days) || 90,
    drive_delete_ready: data.drive_delete_ready === true,
    waiting: count(data.waiting),
    next_due_at: when(data.next_due_at),
    due: count(data.due),
    failing: count(data.failing),
    last_error_code: when(data.last_error_code),
    other_account: count(data.other_account),
    trashed: count(data.trashed),
    gone: count(data.gone),
    refused: count(data.refused),
    last_trashed_at: when(data.last_trashed_at),
    erasures: count(data.erasures),
    last_erasure_at: when(data.last_erasure_at),
  };
}
