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
  // Planilhas de presença guardadas sem o código da sala no nome (plano B da
  // importação): não vão para a lixeira sozinhas; a direção confere à mão.
  attendance_unidentified: number;
}

/**
 * O que a lixeira dos originais consegue fazer HOJE, pelo status da edge
 * google-meet: a flag da instalação (GOOGLE_MEET_DELETE_ORIGINALS_ENABLED), a
 * escrita no Drive autorizada pela conta central e o relatório de presença.
 * null = não deu para saber (a tela não promete a lixeira).
 */
export interface TrashAvailability {
  enabled: boolean | null;
  granted: boolean | null;
  attendanceEnabled: boolean | null;
}
export const UNKNOWN_TRASH_AVAILABILITY: TrashAvailability = { enabled: null, granted: null, attendanceEnabled: null };

/** get_student_lesson_records_erasure_preview (direção, ficha do aluno). */
export interface ErasurePreview {
  sessions: number;
  raw_copies: number;
  attendance_reports: number;
  drafts: number;
  approved_summaries: number;
  memories: number;
  card: boolean;
  // Planos do Planner com a base das aulas aprovadas copiada (a base sai; o
  // plano fica — integração com 20260927130000).
  planner_basis: number;
  // Originais que a conta central ATUAL move (ou moverá).
  originals_pending: number;
  // Da conta central anterior: só ela move — apagar à mão no Drive dela.
  originals_other_account: number;
  originals_done: number;
  rooms_to_discover: number;
  rooms_other_account: number;
  rooms_beyond_window: number;
  // Aulas terminadas sem planilha de presença registrada para a lixeira.
  rooms_attendance_unregistered: number;
  // Prazo da conferência mais próximo (28 dias depois da aula).
  discovery_deadline: string | null;
  connection_status: string | null;
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
  planner_basis_cleared: number;
  originals_queued: number;
  sessions_to_discover: number;
  originals_other_account: number;
  rooms_other_account: number;
  rooms_beyond_window: number;
  rooms_attendance_unregistered: number;
  discovery_deadline: string | null;
  connection_status: string | null;
}

const count = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
};
const when = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;
const flag = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

/** Lê a disponibilidade da lixeira no status da edge; sem status, nada se sabe. */
export function readTrashAvailability(raw: unknown): TrashAvailability {
  if (!raw || typeof raw !== 'object') return UNKNOWN_TRASH_AVAILABILITY;
  const data = raw as Record<string, unknown>;
  return {
    enabled: flag(data.drive_delete_enabled),
    granted: flag(data.drive_delete_granted),
    attendanceEnabled: flag(data.attendance_report_enabled),
  };
}

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
    planner_basis: count(data.planner_basis),
    originals_pending: count(data.originals_pending),
    originals_other_account: count(data.originals_other_account),
    originals_done: count(data.originals_done),
    rooms_to_discover: count(data.rooms_to_discover),
    rooms_other_account: count(data.rooms_other_account),
    rooms_beyond_window: count(data.rooms_beyond_window),
    rooms_attendance_unregistered: count(data.rooms_attendance_unregistered),
    discovery_deadline: when(data.discovery_deadline),
    connection_status: when(data.connection_status),
    drive_delete_ready: data.drive_delete_ready === true,
    last_erasure_at: when(data.last_erasure_at),
  };
}

/** Lê o resultado da exclusão; resposta sem ok vira null. */
export function readErasureResult(raw: unknown): ErasureResult | null {
  if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
  const data = raw as Record<string, unknown>;
  return {
    sessions: count(data.sessions),
    raw_copies_deleted: count(data.raw_copies_deleted),
    attendance_reports_deleted: count(data.attendance_reports_deleted),
    summary_versions_deleted: count(data.summary_versions_deleted),
    memories_deleted: count(data.memories_deleted),
    card_deleted: data.card_deleted === true,
    planner_basis_cleared: count(data.planner_basis_cleared),
    originals_queued: count(data.originals_queued),
    sessions_to_discover: count(data.sessions_to_discover),
    originals_other_account: count(data.originals_other_account),
    rooms_other_account: count(data.rooms_other_account),
    rooms_beyond_window: count(data.rooms_beyond_window),
    rooms_attendance_unregistered: count(data.rooms_attendance_unregistered),
    discovery_deadline: when(data.discovery_deadline),
    connection_status: when(data.connection_status),
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
  // Só aparece com plano afetado: o plano (material do professor) fica, sem a
  // base copiada do resumo aprovado.
  if (preview.planner_basis > 0) {
    items.push({ key: 'planner', label: `a base das aulas aprovadas copiada em ${plural(preview.planner_basis, 'plano', 'planos')} do Planner (${preview.planner_basis === 1 ? 'o plano fica' : 'os planos ficam'})` });
  }
  return items;
}

/**
 * Estado da lixeira: ligada e autorizada (ACTIVE), ligada sem a conta central
 * autorizar o Drive, desligada nesta instalação, ou sem como saber. Só ACTIVE
 * permite dizer que os originais "vão para a lixeira".
 */
export type TrashState = 'ACTIVE' | 'NEEDS_AUTHORIZATION' | 'OFF' | 'UNKNOWN';
export function trashState(availability: TrashAvailability, driveReady: boolean): TrashState {
  if (availability.enabled === null) return 'UNKNOWN';
  if (!availability.enabled) return 'OFF';
  return driveReady || availability.granted === true ? 'ACTIVE' : 'NEEDS_AUTHORIZATION';
}

interface OriginalsSituation {
  pending: number;
  toDiscover: number;
  otherAccount: number;
  beyondWindow: number;
  discoveryDeadline: string | null;
  connectionStatus: string | null;
}

const dayBr = (value: string) =>
  new Date(value).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/**
 * O que acontece com os originais no Google Drive da escola — sem prometer a
 * lixeira quando ela não está ligada e autorizada, e mandando conferir à mão o
 * que a conta central atual não alcança (correção da revisão).
 */
function originalsText(s: OriginalsSituation, state: TrashState, tense: 'preview' | 'result'): string {
  const parts: string[] = [];
  const n = s.pending, many = n !== 1;
  if (n) {
    const originals = tense === 'result'
      ? `${many ? 'Os' : 'O'} ${n} ${many ? 'originais registrados' : 'original registrado'}`
      : `${n} ${many ? 'originais registrados' : 'original registrado'}`;
    if (state === 'ACTIVE') {
      parts.push(tense === 'result'
        ? `${originals} ${many ? 'entraram' : 'entrou'} na fila da lixeira do Google Drive da escola.`
        : `${originals} ${many ? 'vão' : 'vai'} para a lixeira do Google Drive da escola.`);
    } else if (state === 'NEEDS_AUTHORIZATION') {
      parts.push(`${originals} ${many ? 'esperam' : 'espera'} a lixeira do Google Drive da escola: a conta central ainda não autorizou mover arquivos (Conta central Google → Reconectar conta central).`);
    } else if (state === 'OFF') {
      parts.push(`${originals} ${many ? 'ficam marcados' : 'fica marcado'} para a lixeira, mas a lixeira automática não está ligada nesta instalação: só ${many ? 'vão' : 'vai'} para ela quando for ligada. Para apagar já, apague pelo Google Drive da conta central.`);
    } else {
      parts.push(`${originals} ${many ? 'ficam marcados' : 'fica marcado'} para a lixeira; não deu para confirmar se a lixeira automática está ligada (confira em Conta central Google).`);
    }
  }
  if (s.toDiscover) {
    const rooms = `${s.toDiscover} ${s.toDiscover === 1 ? 'sala recente ainda tem' : 'salas recentes ainda têm'} a lista de documentos conferida no Meet`;
    const until = s.discoveryDeadline ? ` até ${dayBr(s.discoveryDeadline)}` : '';
    const connected = s.connectionStatus === 'CONNECTED' ? '' : ' (a conta central precisa estar conectada até lá)';
    const found = state === 'ACTIVE' ? 'o que for achado vai para a lixeira' : 'o que for achado fica marcado para a lixeira';
    parts.push(`${rooms}${until}${connected}; ${found}.`);
  }
  if (s.otherAccount) {
    parts.push(`${s.otherAccount} ${s.otherAccount === 1 ? 'original ou sala é' : 'originais ou salas são'} da conta central anterior: só ela mexe nesses arquivos — apague à mão no Google Drive daquela conta.`);
  }
  if (s.beyondWindow) {
    parts.push(`${s.beyondWindow} ${s.beyondWindow === 1 ? 'aula antiga não teve' : 'aulas antigas não tiveram'} a lista de documentos conferida a tempo: confira na pasta "Meet Recordings" do Drive da escola.`);
  }
  if (!parts.length) parts.push('Não há original no Google Drive esperando a lixeira para este aluno.');
  return parts.join(' ');
}

/**
 * Planilhas de presença que o sistema não registrou (aceite revogado, aula
 * apagada antes da importação, planilha não identificada pelo código da sala):
 * se a instalação gera o relatório, elas estão no Drive e só se apagam à mão —
 * nunca se procura arquivo por nome para apagar.
 */
function attendanceText(unregistered: number, availability: TrashAvailability): string {
  if (!unregistered || availability.attendanceEnabled === false) return '';
  const lessons = `${unregistered} ${unregistered === 1 ? 'aula não tem' : 'aulas não têm'} planilha de presença registrada pelo sistema`;
  const prefix = availability.attendanceEnabled === null ? 'Se o relatório de presença estiver ligado: ' : '';
  return ` ${prefix}${lessons} — confira a planilha de presença ${unregistered === 1 ? 'dessa aula' : 'dessas aulas'} no Google Drive da conta central e apague à mão.`;
}

/** Prévia: o que acontece com os originais no Google Drive da escola. */
export function erasureOriginalsText(preview: ErasurePreview, availability: TrashAvailability = UNKNOWN_TRASH_AVAILABILITY): string {
  const state = trashState(availability, preview.drive_delete_ready);
  return originalsText({
    pending: preview.originals_pending,
    toDiscover: preview.rooms_to_discover,
    otherAccount: preview.originals_other_account + preview.rooms_other_account,
    beyondWindow: preview.rooms_beyond_window,
    discoveryDeadline: preview.discovery_deadline,
    connectionStatus: preview.connection_status,
  }, state, 'preview') + attendanceText(preview.rooms_attendance_unregistered, availability);
}

/** Resultado: o que aconteceu com os originais depois da exclusão. */
export function erasureResultOriginalsText(result: ErasureResult, availability: TrashAvailability, driveReady: boolean): string {
  const state = trashState(availability, driveReady);
  return originalsText({
    pending: result.originals_queued,
    toDiscover: result.sessions_to_discover,
    otherAccount: result.originals_other_account + result.rooms_other_account,
    beyondWindow: result.rooms_beyond_window,
    discoveryDeadline: result.discovery_deadline,
    connectionStatus: result.connection_status,
  }, state, 'result') + attendanceText(result.rooms_attendance_unregistered, availability);
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
    attendance_unidentified: count(data.attendance_unidentified),
  };
}
