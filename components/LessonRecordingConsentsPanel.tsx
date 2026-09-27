import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, MessageCircle, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import StudentBirthDateField from './StudentBirthDateField';
import {
  asAuthorizationSummary,
  asDecision,
  asGuardianReason,
  asLinkBlockedReason,
  asTermSchoolIdentity,
  consentErrorMessage,
  consentLink,
  consentWhatsAppMessage,
  DECISION_LABEL,
  formatDecisionDate,
  GUARDIAN_PHONE_SAME_AS_STUDENT_TEXT,
  GUARDIAN_PHONE_UNCONFIRMED_TEXT,
  formatSendTime,
  manualLinkHoldUntil,
  missingContactLabel,
  notSentReasonLabel,
  queuedSendAt,
  RECIPIENT_LABEL,
  GUARDIAN_REASON_LABEL,
  LINK_BLOCKED_LABEL,
  RELATION_LABEL,
  REQUEST_STATE_LABEL,
  SCHOOL_IDENTITY_GAP_LABEL,
  resendAllowed,
  sendWindowText,
  whatsappUrl,
  AUTHORIZATION_MODE_LABEL,
  AUTHORIZATION_MODE_TEXT,
  AUTHORIZATION_SWITCH_EFFECT,
  formatDecidedOn,
  isObjection,
  OBJECTION_LABEL,
  SCHOOL_DEFAULT_LABEL,
  type AuthorizationMode,
  type AuthorizationSummary,
  type ConsentRecipient,
  type RecordingDecision,
  type RequestState,
  type SignerRelation,
} from '../lib/lessonRecordingConsent';

type StudentRow = {
  student_id: string;
  name: string;
  requires_guardian: boolean;
  guardian_reason?: string | null;
  school_birth_date?: string | null;
  guardian_name: string | null;
  contact_phone: string | null;
  decision: string;
  effective?: boolean;
  decided_at: string | null;
  signer_name: string | null;
  signer_relation: string | null;
  verification?: string | null;
  verified_phone?: string | null;
  link_expires_at: string | null;
  link_code_phone_masked?: string | null;
  /** Telefone/vínculo de responsável no cadastro sem confirmação da escola. */
  guardian_phone_unconfirmed?: boolean;
  guardian_phone_same_as_student?: boolean;
  link_blocked_reason?: string | null;
  /** Aceitou versão anterior à vigente (20260927100000): não vale até aceitar de novo. */
  term_updated?: boolean;
  decided_term_version?: string | null;
};
type GeneratedLink = { url: string; codePhone: string | null; guardianUnconfirmed: boolean };
type TeacherRow = {
  teacher_id: string;
  name: string;
  decision: string;
  decided_at: string | null;
  /** Só o aceite da versão vigente vale. Ausente = servidor antigo, vale a decisão. */
  effective?: boolean;
  term_updated?: boolean;
  decided_term_version?: string | null;
  /** Conta Google confirmada por login (20260929100000): sem ela, a sala não nasce. */
  google_identity_confirmed?: boolean;
};
type Overview = {
  google_connected: boolean;
  students: StudentRow[];
  teachers: TeacherRow[];
  /** Como a escola aparece no termo (marcadores preenchidos) e o que falta. */
  term_identity?: unknown;
  term_versions?: { STUDENT?: string | null; TEACHER?: string | null };
  /** Como a escola autoriza o registro, com a trilha (20260929100000). */
  authorization?: unknown;
};

// Envio em lote (list_lesson_recording_consent_requests).
type RequestInfo = {
  attempt: number;
  requested_at: string;
  scheduled_for: string;
  next_attempt_at?: string | null;
  recipient: ConsentRecipient;
  contact_last4: string | null;
  state: RequestState;
  sent_at: string | null;
  read_at: string | null;
  not_sent_reason: string | null;
  opened_at: string | null;
  answered_after: boolean;
};
type SendRow = {
  student_id: string;
  name: string;
  decision: string;
  decided_at: string | null;
  eligible: boolean;
  reconfirm?: boolean;
  recipient: ConsentRecipient | null;
  contact_last4: string | null;
  missing_reason: string | null;
  manual_link_at?: string | null;
  request: RequestInfo | null;
  resend_available_at: string | null;
};
type SendOverview = { can_send: boolean; portal_ok?: boolean; term_version: string; students: SendRow[] };
type BatchPreview = {
  to_send: number;
  to_guardians: number;
  term_updated: number;
  reconfirm?: number;
  no_contact: number;
  manual_link_recent?: number;
  left_for_next_batch: number;
  portal_ok?: boolean;
  first_at: string | null;
  last_at: string | null;
  student_notifications_enabled: boolean;
};
type SendFilter = 'pending' | 'no_contact' | 'answered' | 'all';

const SEND_FILTERS: { id: SendFilter; label: string }[] = [
  { id: 'pending', label: 'Aguardando resposta' },
  { id: 'no_contact', label: 'Sem contato' },
  { id: 'answered', label: 'Responderam' },
  { id: 'all', label: 'Todos' },
];

function sendFilterMatches(row: SendRow, filter: SendFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'answered') return !row.eligible;
  const hasContact = !!row.contact_last4;
  return row.eligible && (filter === 'pending' ? hasContact : !hasContact);
}

function requestStatusText(request: RequestInfo): string {
  if (request.state === 'SENT') return `Enviado ${formatSendTime(request.sent_at)}`;
  if (request.state === 'QUEUED') return `Na fila · sai ${formatSendTime(queuedSendAt(request.scheduled_for, request.next_attempt_at))}`;
  if (request.state === 'UNCERTAIN') return `${REQUEST_STATE_LABEL.UNCERTAIN} (pode ter chegado)`;
  return `${REQUEST_STATE_LABEL.NOT_SENT}: ${notSentReasonLabel(request.not_sent_reason)}`;
}

const BADGE: Record<RecordingDecision, string> = {
  NONE: 'bg-slate-100 text-slate-600',
  ACCEPTED: 'bg-emerald-100 text-emerald-800',
  REFUSED: 'bg-amber-100 text-amber-800',
  REVOKED: 'bg-red-100 text-red-700',
};

function Badge({ decision }: { decision: string }) {
  const value = asDecision(decision);
  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${BADGE[value]}`}>{DECISION_LABEL[value]}</span>;
}

/**
 * Situação no modo da escola (20260929100000): autorizado pela escola, pediu
 * para não registrar, ou sem registro (inativo). Nada de "sem resposta": não há
 * resposta a esperar.
 */
function SchoolDefaultBadge({ decision, effective }: { decision: string; effective?: boolean }) {
  if (isObjection(decision)) {
    return <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800">{OBJECTION_LABEL}</span>;
  }
  if (effective === false) {
    return <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">Sem registro (inativo)</span>;
  }
  return <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-800">{SCHOOL_DEFAULT_LABEL}</span>;
}

/**
 * Como a escola autoriza o registro, com a trilha, e a troca pela direção — com
 * a confirmação na própria tela (o que muda, o motivo) antes de gravar.
 */
function AuthorizationModeSection({ summary, busy, onSwitch }: {
  summary: AuthorizationSummary;
  busy: boolean;
  onSwitch: (mode: AuthorizationMode, reason: string) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const target: AuthorizationMode = summary.mode === 'SCHOOL_DEFAULT' ? 'INDIVIDUAL_CONSENT' : 'SCHOOL_DEFAULT';
  const current = summary.current;
  const reasonOk = reason.trim().length >= 10;

  async function confirm() {
    if (!reasonOk) return;
    if (await onSwitch(target, reason.trim())) { setConfirming(false); setReason(''); }
  }

  return <section data-tour="recording-authorization-mode" aria-label="Como a escola autoriza o registro"
    className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm dark:border-slate-700 dark:bg-slate-900">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Como a escola autoriza o registro</p>
        <p className="mt-1 font-semibold">{AUTHORIZATION_MODE_LABEL[summary.mode]}</p>
      </div>
      {summary.canChange && !confirming && <button type="button" disabled={busy} onClick={() => setConfirming(true)}
        className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 disabled:opacity-40 dark:text-slate-200">
        {target === 'SCHOOL_DEFAULT' ? 'Passar a autorizar pela escola' : 'Voltar ao aceite individual'}
      </button>}
    </div>
    <p className="text-slate-600 dark:text-slate-300">{AUTHORIZATION_MODE_TEXT[summary.mode]}</p>
    {current && <p className="text-xs text-slate-500">
      Decidido por {current.decidedByName || 'direção da escola'}
      {formatDecidedOn(current.decidedOn) ? ` em ${formatDecidedOn(current.decidedOn)}` : ''}
      {current.source === 'MIGRATION' ? ' (registrado na atualização do sistema)' : ''}
      {current.reason ? `: ${current.reason}` : ''}
    </p>}
    {summary.history.length > 1 && <details className="text-xs text-slate-500">
      <summary className="cursor-pointer font-semibold">Histórico ({summary.history.length})</summary>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {summary.history.map((item, index) => <li key={index}>
          {AUTHORIZATION_MODE_LABEL[item.mode]} · {item.decidedByName || 'direção'}
          {formatDecidedOn(item.decidedOn) ? ` · ${formatDecidedOn(item.decidedOn)}` : ''}
          {item.reason ? ` · ${item.reason}` : ''}
        </li>)}
      </ul>
    </details>}
    {confirming && <div role="alertdialog" aria-labelledby="recording-mode-title"
      className="space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-blue-950 dark:border-slate-600 dark:bg-slate-800 dark:text-blue-100">
      <p id="recording-mode-title" className="font-semibold">Mudar para “{AUTHORIZATION_MODE_LABEL[target]}”?</p>
      <ul className="list-disc space-y-1 pl-5">
        {AUTHORIZATION_SWITCH_EFFECT[target].map(line => <li key={line}>{line}</li>)}
      </ul>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold">Motivo (fica registrado)</span>
        <textarea value={reason} onChange={event => setReason(event.target.value)} rows={2}
          placeholder={target === 'SCHOOL_DEFAULT' ? 'Ex.: contratos com a cláusula do registro das aulas; decisão da direção.' : 'Ex.: o jurídico pediu o aceite individual.'}
          className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm text-slate-800 dark:bg-slate-900 dark:text-slate-100" />
      </label>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy || !reasonOk} onClick={() => void confirm()}
          className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
          {busy ? 'Gravando…' : 'Confirmar a mudança'}
        </button>
        <button type="button" disabled={busy} onClick={() => { setConfirming(false); setReason(''); }} className="font-semibold">Cancelar</button>
      </div>
    </div>}
  </section>;
}

export default function LessonRecordingConsentsPanel({ schoolName }: { schoolName?: string | null }) {
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [links, setLinks] = useState<Record<string, GeneratedLink>>({});
  const [ageEditor, setAgeEditor] = useState('');
  const [copied, setCopied] = useState('');
  const [sending, setSending] = useState<SendOverview | null>(null);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [sendFilter, setSendFilter] = useState<SendFilter>('pending');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setBusy('load'); setError('');
    const [consents, requests] = await Promise.all([
      supabase.rpc('list_lesson_recording_consents'),
      supabase.rpc('list_lesson_recording_consent_requests'),
    ]);
    if (consents.error || consents.data?.ok !== true) setError(consentErrorMessage(consents.error?.message));
    else setData(consents.data as Overview);
    // O envio em lote é uma seção à parte: se falhar, o resto do painel segue.
    setSending(!requests.error && requests.data?.ok === true ? requests.data as SendOverview : null);
    setBusy('');
  }, []);
  useEffect(() => { void load(); }, [load]);

  // keepMessage: refazer a conferência depois de "contagem_mudou" sem apagar o aviso.
  async function openBatchPreview(keepMessage = false) {
    setBusy('preview'); setNotice('');
    if (!keepMessage) setError('');
    const { data: result, error: rpcError } = await supabase.rpc('preview_lesson_recording_consent_batch');
    setBusy('');
    if (rpcError || result?.ok !== true) { setError(consentErrorMessage(rpcError?.message)); return; }
    setPreview(result as BatchPreview);
  }

  async function confirmBatch() {
    if (!preview) return;
    setBusy('batch'); setError('');
    const { data: result, error: rpcError } = await supabase.rpc('enqueue_lesson_recording_consent_batch', {
      p_expected_count: preview.to_send,
    });
    setBusy('');
    if (rpcError || result?.ok !== true) {
      setError(consentErrorMessage(rpcError?.message));
      // A lista mudou entre a conferência e o clique: mostra a conta nova.
      if (rpcError?.message?.includes('contagem_mudou')) void openBatchPreview(true);
      else setPreview(null);
      return;
    }
    setPreview(null);
    const queued = Number(result.queued || 0);
    setNotice(queued > 0
      ? `${queued} ${queued === 1 ? 'mensagem entrou' : 'mensagens entraram'} na fila da escola: ${sendWindowText(result.first_at, result.last_at)}.`
      : 'Nenhuma mensagem nova: todos os pendentes com contato já estão na fila ou receberam.');
    void load();
  }

  async function resend(row: SendRow) {
    const who = row.recipient ? RECIPIENT_LABEL[row.recipient] : 'aluno';
    const replaces = row.request || row.manual_link_at
      ? '\n\nO link enviado antes deixa de valer: só o desta mensagem responde ao termo.'
      : '';
    const ok = window.confirm(
      `Enviar o termo para ${row.name} (${who}, número terminado em ${row.contact_last4})?\n\n` +
      'A mensagem entra na fila da escola e sai no próximo horário livre (segunda a sábado, das 9h às 20h).' +
      replaces,
    );
    if (!ok) return;
    setBusy(`resend:${row.student_id}`); setError(''); setNotice('');
    const { data: result, error: rpcError } = await supabase.rpc('resend_lesson_recording_consent_request', {
      p_student_id: row.student_id,
    });
    setBusy('');
    if (rpcError || result?.ok !== true) { setError(consentErrorMessage(rpcError?.message)); return; }
    setNotice(`Termo de ${row.name} na fila: sai ${formatSendTime(result.scheduled_for)}.`);
    void load();
  }

  async function createLink(student: StudentRow) {
    setBusy(student.student_id); setError('');
    const { data: result, error: rpcError } = await supabase.rpc('create_lesson_recording_consent_link', { p_student_id: student.student_id });
    setBusy('');
    if (rpcError || result?.ok !== true) { setError(consentErrorMessage(rpcError?.message)); return; }
    const codePhone = result.guardian_reason ? result.guardian_phone_masked : result.student_phone_masked;
    setLinks(current => ({
      ...current,
      [student.student_id]: {
        url: consentLink(window.location.origin, result.token),
        codePhone: codePhone || null,
        guardianUnconfirmed: !!result.guardian_reason && result.guardian_phone_unconfirmed === true,
      },
    }));
    void load();
  }

  async function revoke(subjectId: string, name: string) {
    const reason = window.prompt(`Registrar a revogação de ${name}? Informe como o pedido chegou (ex.: "a mãe pediu pelo WhatsApp em 26/09").`);
    if (!reason) return;
    setBusy(subjectId); setError('');
    const { data: result, error: rpcError } = await supabase.rpc('revoke_lesson_recording_consent', { p_subject_id: subjectId, p_reason: reason });
    setBusy('');
    if (rpcError || result?.ok !== true) { setError(consentErrorMessage(rpcError?.message)); return; }
    void load();
  }

  // Modo da escola (20260929100000): a direção registra o pedido para não
  // registrar que chegou pelo WhatsApp (a revogação de sempre, com motivo) e
  // pode desfazê-lo com motivo.
  async function registerObjection(subjectId: string, name: string) {
    const reason = window.prompt(`Registrar o pedido de ${name} para não ter as aulas registradas? Informe como o pedido chegou (ex.: "a mãe pediu pelo WhatsApp em 27/09").`);
    if (!reason) return;
    setBusy(subjectId); setError(''); setNotice('');
    const { data: result, error: rpcError } = await supabase.rpc('revoke_lesson_recording_consent', { p_subject_id: subjectId, p_reason: reason });
    setBusy('');
    if (rpcError || result?.ok !== true) { setError(consentErrorMessage(rpcError?.message)); return; }
    setNotice(`Pedido de ${name} registrado: as aulas seguintes não são registradas (vale na hora).`);
    void load();
  }

  async function withdrawObjection(subjectId: string, name: string) {
    const reason = window.prompt(`Desfazer o pedido de ${name}? As aulas voltam a ser registradas pela escola. Informe o motivo (ex.: "pediu pelo WhatsApp em 28/09 para voltar a registrar").`);
    if (!reason) return;
    setBusy(subjectId); setError(''); setNotice('');
    const { data: result, error: rpcError } = await supabase.rpc('withdraw_lesson_recording_objection', { p_subject_id: subjectId, p_reason: reason });
    setBusy('');
    if (rpcError || result?.ok !== true) { setError(consentErrorMessage(rpcError?.message)); return; }
    setNotice(`Pedido de ${name} desfeito: as aulas voltam a ser registradas pela escola.`);
    void load();
  }

  async function switchMode(mode: AuthorizationMode, reason: string): Promise<boolean> {
    setBusy('mode'); setError(''); setNotice('');
    const { data: result, error: rpcError } = await supabase.rpc('set_lesson_recording_authorization_mode', { p_mode: mode, p_reason: reason });
    setBusy('');
    if (rpcError || result?.ok !== true) { setError(consentErrorMessage(rpcError?.message)); return false; }
    void load();
    return true;
  }

  async function copy(studentId: string, link: string) {
    try { await navigator.clipboard.writeText(link); setCopied(studentId); }
    catch { window.prompt('Copie o link:', link); }
  }

  const students = data?.students || [];
  const teachers = data?.teachers || [];
  const authorization = asAuthorizationSummary(data?.authorization);
  const schoolDefault = authorization.mode === 'SCHOOL_DEFAULT';
  // No modo da escola conta quem está autorizado (ativo, sem pedido) e quem pediu.
  const authorizedStudents = students.filter(s => !isObjection(s.decision) && s.effective !== false).length;
  const objectedStudents = students.filter(s => isObjection(s.decision)).length;
  const authorizedTeachers = teachers.filter(t => !isObjection(t.decision) && t.effective !== false).length;
  const objectedTeachers = teachers.filter(t => isObjection(t.decision)).length;
  const teachersWithoutGoogle = teachers.filter(t => t.google_identity_confirmed === false && !isObjection(t.decision)).length;
  // Conta só o aceite que vale: com código e, se o cadastro exige, do responsável.
  const acceptedStudents = students.filter(s => asDecision(s.decision) === 'ACCEPTED' && s.effective !== false).length;
  // Professor também: aceite de versão anterior do termo não vale.
  const acceptedTeachers = teachers.filter(t => asDecision(t.decision) === 'ACCEPTED' && t.effective !== false).length;
  // Servidor anterior à v3 não manda a identidade: o bloco não aparece.
  const termIdentity = data?.term_identity ? asTermSchoolIdentity(data.term_identity, schoolName) : null;
  const sendRows = sending?.students || [];
  const waitingCount = sendRows.filter(row => sendFilterMatches(row, 'pending')).length;
  const noContactCount = sendRows.filter(row => sendFilterMatches(row, 'no_contact')).length;
  const inQueueCount = sendRows.filter(row => row.request?.state === 'QUEUED').length;
  const visibleSendRows = sendRows.filter(row => sendFilterMatches(row, sendFilter));

  return <div data-tour="recording-consents" className="space-y-5 text-slate-800 dark:text-slate-100">
    <header className="flex items-start justify-between gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold"><ShieldCheck size={24} /> Autorizações de registro</h1>
        {schoolDefault
          ? <p className="mt-2 text-sm text-slate-500">
              A escola autoriza o registro das aulas: ninguém precisa de link nem de código. Quando alguém pedir pelo
              WhatsApp para não ser registrado, registre o pedido aqui — ele vale na hora (sala desligada, nada importado).
            </p>
          : <>
              <p className="mt-2 text-sm text-slate-500">
                A transcrição da aula só acontece quando o aluno (ou o responsável, se for menor) <b>e</b> o professor autorizaram.
                Cada um responde uma vez; vale até revogar.
              </p>
              <p className="mt-2 text-sm text-slate-500">
                A família confirma com um código que a página manda pelo WhatsApp do cadastro. Sem data de nascimento
                confirmada pela escola, quem responde é o responsável — cadastre a data aqui ou na ficha do aluno.
              </p>
            </>}
      </div>
      <button type="button" onClick={() => void load()} disabled={!!busy} aria-label="Atualizar" className="rounded-xl border p-2">
        {busy === 'load' ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
      </button>
    </header>

    {data && !data.google_connected && <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
      A conta Google da escola ainda não está conectada. As autorizações ficam guardadas e passam a valer assim que ela for conectada.
    </p>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p>}

    {data && <AuthorizationModeSection summary={authorization} busy={!!busy} onSwitch={switchMode} />}
    {schoolDefault && notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-slate-800 dark:text-emerald-200">{notice}</p>}

    {data && termIdentity && <section data-tour="recording-term-identity" aria-label="A escola no termo"
      className={`rounded-xl border p-4 text-sm ${termIdentity.missing.length
        ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-slate-900 dark:text-amber-200'
        : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'}`}>
      <p>
        No {schoolDefault ? 'aviso' : 'termo'}, quem responde pelos dados é a escola: <b>{termIdentity.escola_nome}</b>, {termIdentity.escola_documento}.
        {' '}Contato para assuntos de privacidade: {termIdentity.escola_contato_privacidade}.
      </p>
      {termIdentity.missing.length > 0 && <p className="mt-2 font-semibold">
        Falta {termIdentity.missing.map(gap => SCHOOL_IDENTITY_GAP_LABEL[gap]).join(', ')}: complete em Configurações → Escola e legal para o termo identificar a escola.
      </p>}
      {schoolDefault
        ? <p className="mt-2 text-xs">
            Aviso vigente: aluno {authorization.noticeVersions.STUDENT || '—'} · professor {authorization.noticeVersions.TEACHER || '—'}. É aviso, não termo de aceite: quem não quiser ser registrado pede.
          </p>
        : (data.term_versions?.STUDENT || data.term_versions?.TEACHER) && <p className="mt-2 text-xs">
            Termo vigente: aluno {data.term_versions?.STUDENT || '—'} · professor {data.term_versions?.TEACHER || '—'}. Aceite de versão anterior não vale até a pessoa aceitar o texto novo.
          </p>}
    </section>}

    {data && schoolDefault && <div className="grid grid-cols-2 gap-3">
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-2xl font-bold">{authorizedStudents}<span className="text-base text-slate-400"> de {students.length}</span></p>
        <p className="mt-1 text-xs text-slate-500">alunos com registro autorizado pela escola</p>
        {objectedStudents > 0 && <p className="mt-1 text-xs font-semibold text-amber-800">{objectedStudents} {objectedStudents === 1 ? 'pediu' : 'pediram'} para não registrar</p>}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-2xl font-bold">{authorizedTeachers}<span className="text-base text-slate-400"> de {teachers.length}</span></p>
        <p className="mt-1 text-xs text-slate-500">professores com registro autorizado pela escola</p>
        {objectedTeachers > 0 && <p className="mt-1 text-xs font-semibold text-amber-800">{objectedTeachers} {objectedTeachers === 1 ? 'pediu' : 'pediram'} para não registrar</p>}
        {teachersWithoutGoogle > 0 && <p className="mt-1 text-xs font-semibold text-amber-800">
          {teachersWithoutGoogle} sem conta Google confirmada — a sala da escola só nasce depois
        </p>}
      </div>
    </div>}

    {data && !schoolDefault && <div className="grid grid-cols-2 gap-3">
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-2xl font-bold">{acceptedStudents}<span className="text-base text-slate-400"> de {students.length}</span></p>
        <p className="mt-1 text-xs text-slate-500">alunos autorizaram</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-2xl font-bold">{acceptedTeachers}<span className="text-base text-slate-400"> de {teachers.length}</span></p>
        <p className="mt-1 text-xs text-slate-500">professores autorizaram</p>
      </div>
    </div>}

    {sending && !schoolDefault && <section data-tour="recording-consents-send" className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Envio do termo pelo WhatsApp da escola</h2>
          <p className="mt-1 text-sm text-slate-500">
            {waitingCount} aguardando resposta · {inQueueCount} na fila · {noContactCount} sem contato.
            Menor de idade ou idade não cadastrada: vai ao responsável.
          </p>
          {sending.can_send && sending.portal_ok === false && <p className="mt-1 text-sm font-semibold text-red-700">
            {consentErrorMessage('portal_da_escola_indefinido')}
          </p>}
        </div>
        {sending.can_send && <button type="button" disabled={!!busy} onClick={() => void openBatchPreview()}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
          {busy === 'preview' ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
          Enviar termo aos alunos pendentes
        </button>}
      </div>

      {preview && <div role="alertdialog" aria-labelledby="consent-batch-title" className="space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950 dark:border-slate-600 dark:bg-slate-800 dark:text-blue-100">
        {preview.to_send === 0
          ? <>
              <p id="consent-batch-title" className="font-semibold">Nenhuma mensagem para enviar agora.</p>
              <p>
                Todos os alunos pendentes com contato já receberam ou estão na fila.
                {preview.no_contact > 0 && ` ${preview.no_contact} ${preview.no_contact === 1 ? 'aluno está' : 'alunos estão'} sem contato — veja a lista abaixo.`}
              </p>
              <button type="button" onClick={() => setPreview(null)} className="font-semibold">Fechar</button>
            </>
          : <>
              <p id="consent-batch-title" className="font-semibold">
                Enviar {preview.to_send} {preview.to_send === 1 ? 'mensagem' : 'mensagens'} pelo WhatsApp da escola?
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {preview.to_guardians > 0 && <li>
                  {preview.to_guardians} {preview.to_guardians === 1 ? 'vai' : 'vão'} para o responsável (menor de idade ou idade não cadastrada).
                </li>}
                <li>Uma a cada 3 minutos, {sendWindowText(preview.first_at, preview.last_at)} — só de segunda a sábado, das 9h às 20h.</li>
                {preview.term_updated > 0 && <li>
                  {preview.term_updated} já {preview.term_updated === 1 ? 'tinha' : 'tinham'} aceitado uma versão anterior e {preview.term_updated === 1 ? 'recebe' : 'recebem'} o texto novo.
                </li>}
                {(preview.reconfirm || 0) > 0 && <li>
                  {preview.reconfirm} {preview.reconfirm === 1 ? 'aceite não vale' : 'aceites não valem'} para transcrever (sem o código ou sem o responsável) e {preview.reconfirm === 1 ? 'precisa' : 'precisam'} ser confirmado{preview.reconfirm === 1 ? '' : 's'}.
                </li>}
                {preview.no_contact > 0 && <li>
                  {preview.no_contact} {preview.no_contact === 1 ? 'fica' : 'ficam'} de fora por falta de contato.
                </li>}
                {(preview.manual_link_recent || 0) > 0 && <li>
                  {preview.manual_link_recent} {preview.manual_link_recent === 1 ? 'recebeu' : 'receberam'} link gerado à mão há menos de 3 dias e {preview.manual_link_recent === 1 ? 'fica' : 'ficam'} de fora (use "Enviar" na lista, se quiser).
                </li>}
                {preview.left_for_next_batch > 0 && <li>
                  {preview.left_for_next_batch} {preview.left_for_next_batch === 1 ? 'fica' : 'ficam'} para o próximo envio (até 60 por vez).
                </li>}
                <li>Quem responder, revogar ou mudar de contato antes do horário não recebe.</li>
              </ul>
              {!preview.student_notifications_enabled && <p className="font-semibold text-red-700">
                Os avisos a alunos estão desligados nas configurações da escola — o envio será recusado.
              </p>}
              {preview.portal_ok === false && <p className="font-semibold text-red-700">
                {consentErrorMessage('portal_da_escola_indefinido')}
              </p>}
              <div className="flex flex-wrap gap-3 pt-1">
                <button type="button" disabled={!!busy || preview.portal_ok === false} onClick={() => void confirmBatch()}
                  className="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-40">
                  {busy === 'batch' ? 'Enfileirando…' : `Confirmar envio de ${preview.to_send}`}
                </button>
                <button type="button" disabled={busy === 'batch'} onClick={() => setPreview(null)} className="font-semibold">Cancelar</button>
              </div>
            </>}
      </div>}
      {notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-slate-800 dark:text-emerald-200">{notice}</p>}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar envios">
        {SEND_FILTERS.map(option => <button key={option.id} type="button" aria-pressed={sendFilter === option.id}
          onClick={() => setSendFilter(option.id)}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${sendFilter === option.id
            ? 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900'
            : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
          {option.label}
        </button>)}
      </div>
      {!visibleSendRows.length && <p className="text-sm text-slate-500">Ninguém nesta lista.</p>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {visibleSendRows.map(row => {
          const request = row.request;
          const decision = asDecision(row.decision);
          const hasContact = !!row.contact_last4;
          const canResend = sending.can_send && row.eligible && hasContact && resendAllowed(row.resend_available_at);
          const manualHold = manualLinkHoldUntil(row.manual_link_at);
          return <li key={row.student_id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0 space-y-1 text-sm">
              <p className="font-semibold">{row.name}</p>
              {hasContact
                ? <p className="text-xs text-slate-500">Para o {row.recipient ? RECIPIENT_LABEL[row.recipient] : 'aluno'} · final {row.contact_last4}</p>
                : row.eligible && <p className="text-xs text-amber-700">{missingContactLabel(row.missing_reason)}</p>}
              {request && <p className="text-xs">
                {requestStatusText(request)}
                {request.attempt > 1 && ` · ${request.attempt}º envio`}
                {request.read_at && ' · lida'}
              </p>}
              {request && request.state !== 'NOT_SENT' && <p className="text-xs text-slate-500">
                {request.opened_at ? `Abriu o link em ${formatDecisionDate(request.opened_at)}` : 'Ainda não abriu o link'}
              </p>}
              {!request && row.eligible && manualHold && <p className="text-xs text-slate-500">
                Link gerado à mão em {formatDecisionDate(row.manual_link_at)} — o envio em lote pula este aluno até {formatSendTime(manualHold)}.
              </p>}
            </div>
            <div className="flex flex-col items-end gap-1 text-xs">
              <Badge decision={row.decision} />
              {decision !== 'NONE' && row.decided_at && <span className="text-slate-500">{formatDecisionDate(row.decided_at)}</span>}
              {row.eligible && decision === 'ACCEPTED' && <span className="text-slate-500">
                {row.reconfirm ? 'aceite precisa ser confirmado' : 'aceitou versão anterior'}
              </span>}
              {sending.can_send && row.eligible && hasContact && (canResend
                ? <button type="button" disabled={!!busy} onClick={() => void resend(row)} className="font-semibold text-blue-600 disabled:opacity-40">
                    {busy === `resend:${row.student_id}` ? 'Enviando…' : request ? 'Reenviar' : 'Enviar'}
                  </button>
                : request && request.state !== 'QUEUED' && row.resend_available_at && <span className="text-slate-500">
                    Reenvio liberado {formatSendTime(row.resend_available_at)}
                  </span>)}
            </div>
          </li>;
        })}
      </ul>
    </section>}

    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Alunos com aula nos últimos ou próximos 30 dias</h2>
      {data && !students.length && <p className="rounded-xl border p-4 text-sm text-slate-500">Nenhum aluno com aula no período.</p>}
      {students.map(student => {
        if (schoolDefault) {
          // Modo da escola: sem link, sem termo, sem "sem resposta". Destaca quem
          // pediu para não registrar; a direção registra ou desfaz o pedido.
          const minorReason = asGuardianReason(student.guardian_reason, student.requires_guardian);
          const objected = isObjection(student.decision);
          return <article key={student.student_id} className={`rounded-xl border p-4 ${objected
            ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-slate-900'
            : 'border-slate-200 dark:border-slate-700'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold">{student.name}</h3>
                {minorReason && <p className="text-xs text-slate-500">
                  {minorReason === 'KIDS' ? 'Turma infantil' : minorReason === 'MINOR' ? 'Menor de idade' : 'Idade não cadastrada pela escola'}
                  {' '}· autorizado pela escola; o pedido para não registrar pode vir do responsável{student.guardian_name ? ` (${student.guardian_name})` : ''}
                </p>}
              </div>
              <SchoolDefaultBadge decision={student.decision} effective={student.effective} />
            </div>
            {objected && <p className="mt-2 text-xs text-amber-900 dark:text-amber-200">
              Pedido {student.signer_relation === 'SCHOOL' ? 'registrado pela escola' : student.signer_relation === 'GUARDIAN' ? 'do responsável' : 'do próprio aluno'}
              {student.decided_at ? ` em ${formatDecisionDate(student.decided_at)}` : ''}: as aulas não são transcritas.
            </p>}
            {minorReason === 'AGE_UNKNOWN' && (ageEditor === student.student_id
              ? <div className="mt-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800">
                  <StudentBirthDateField studentId={student.student_id} compact onSaved={() => { setAgeEditor(''); void load(); }} />
                </div>
              : <button type="button" onClick={() => setAgeEditor(student.student_id)} className="mt-2 text-xs font-semibold text-blue-600">
                  Cadastrar data de nascimento
                </button>)}
            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              {objected
                ? <button type="button" disabled={!!busy} onClick={() => void withdrawObjection(student.student_id, student.name)} className="font-semibold text-blue-600 disabled:opacity-40">
                    Desfazer pedido
                  </button>
                : <button type="button" data-tour="recording-objection" disabled={!!busy} onClick={() => void registerObjection(student.student_id, student.name)} className="text-amber-700 disabled:opacity-40">
                    Registrar pedido para não registrar
                  </button>}
            </div>
          </article>;
        }
        const decision = asDecision(student.decision);
        const reason = asGuardianReason(student.guardian_reason, student.requires_guardian);
        const generated = links[student.student_id];
        const link = generated?.url;
        const message = link ? consentWhatsAppMessage({ studentName: student.name, schoolName, link, forGuardian: !!reason, guardianReason: reason }) : '';
        const whatsapp = link ? whatsappUrl(student.contact_phone, message) : null;
        const ineffective = decision === 'ACCEPTED' && student.effective === false;
        const oldTerm = ineffective && student.term_updated === true;
        const blockedReason = asLinkBlockedReason(student.link_blocked_reason);
        return <article key={student.student_id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold">{student.name}</h3>
              {reason
                ? <p className="text-xs text-slate-500">{GUARDIAN_REASON_LABEL[reason]}{student.guardian_name ? ` (${student.guardian_name})` : ''}</p>
                : <p className="text-xs text-slate-500">Maior de idade pela data da escola · o próprio aluno responde</p>}
            </div>
            <Badge decision={student.decision} />
          </div>
          {decision !== 'NONE' && <p className="mt-2 text-xs text-slate-500">
            {student.signer_name} ({RELATION_LABEL[(student.signer_relation || 'SELF') as SignerRelation]}) · {formatDecisionDate(student.decided_at)}
            {student.verified_phone ? ` · confirmado pelo WhatsApp ${student.verified_phone}` : ''}
          </p>}
          {ineffective && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
            {oldTerm
              ? `Este aceite é da versão ${student.decided_term_version || 'anterior'} do termo e o texto mudou: não vale para transcrever até ${reason ? 'o responsável' : 'o aluno'} aceitar a versão vigente. O envio em lote manda o texto novo (ou gere um link novo).`
              : student.verification
              ? 'Este aceite foi dado pelo próprio aluno e hoje o cadastro exige o responsável: não vale para transcrever. Gere um link novo para o responsável.'
              : 'Este aceite foi dado sem o código de confirmação e não vale para transcrever. Gere um link novo.'}
          </p>}
          {reason && student.guardian_phone_unconfirmed && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
            {GUARDIAN_PHONE_UNCONFIRMED_TEXT}
          </p>}
          {reason && student.guardian_phone_same_as_student && <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {GUARDIAN_PHONE_SAME_AS_STUDENT_TEXT}
          </p>}
          {blockedReason && !link && <p className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-800">
            {LINK_BLOCKED_LABEL[blockedReason]}
          </p>}
          {reason === 'AGE_UNKNOWN' && (ageEditor === student.student_id
            ? <div className="mt-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800">
                <StudentBirthDateField studentId={student.student_id} compact onSaved={() => { setAgeEditor(''); void load(); }} />
              </div>
            : <button type="button" data-tour="recording-age-check" onClick={() => setAgeEditor(student.student_id)} className="mt-2 text-xs font-semibold text-blue-600">
                Cadastrar data de nascimento
              </button>)}
          {decision === 'NONE' && student.link_expires_at && !link && <p className="mt-2 text-xs text-slate-500">
            Link enviado, válido até {formatDecisionDate(student.link_expires_at)}.
            {student.link_code_phone_masked ? ` O código vai para ${student.link_code_phone_masked}.` : ' Sem telefone para o código: gere um link novo depois de cadastrar.'}
          </p>}
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <button type="button" disabled={!!busy} onClick={() => void createLink(student)} className="font-semibold text-blue-600 disabled:opacity-40">
              {busy === student.student_id ? 'Gerando…' : decision === 'NONE' ? 'Gerar link' : 'Gerar link novo'}
            </button>
            {decision === 'ACCEPTED' && <button type="button" disabled={!!busy} onClick={() => void revoke(student.student_id, student.name)} className="text-red-600 disabled:opacity-40">
              Registrar revogação
            </button>}
          </div>
          {link && <div className="mt-3 space-y-2 rounded-xl bg-blue-50 p-3 text-sm text-blue-900 dark:bg-slate-800 dark:text-blue-100">
            <p className="break-all text-xs">{link}</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => void copy(student.student_id, link)} className="inline-flex items-center gap-1 font-semibold">
                <Copy size={14} /> {copied === student.student_id ? 'Copiado' : 'Copiar link'}
              </button>
              {whatsapp
                ? <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold">
                    <MessageCircle size={14} /> Abrir no WhatsApp
                  </a>
                : <span className="text-xs">Sem telefone no cadastro: copie o link e envie por onde conversa com a família.</span>}
            </div>
            <p className="text-xs">
              {generated?.codePhone
                ? `O código de confirmação vai para ${generated.codePhone} (o cadastro de agora). Corrigiu o telefone depois? Gere um link novo.`
                : generated?.guardianUnconfirmed
                  ? GUARDIAN_PHONE_UNCONFIRMED_TEXT
                  : `Sem WhatsApp ${reason ? 'do responsável' : 'do aluno'} no cadastro: a página não consegue mandar o código. Cadastre o telefone${reason === 'AGE_UNKNOWN' ? ' (ou a data de nascimento, se o aluno for maior)' : ''} e gere um link novo.`}
            </p>
            <p className="text-xs">O link vale 30 dias. Gerar outro invalida este.</p>
          </div>}
        </article>;
      })}
    </section>

    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Professores</h2>
      {schoolDefault
        ? <p className="text-sm text-slate-500">
            Autorizados pela escola. Cada professor confirma a conta Google em “Salas e continuidade” (a sala da escola
            só nasce depois) e pode pedir, ali mesmo, para não ter as aulas registradas.
          </p>
        : <p className="text-sm text-slate-500">Cada professor autoriza pela própria conta, na tela “Salas e continuidade”.</p>}
      {schoolDefault && teachers.map(teacher => {
        const objected = isObjection(teacher.decision);
        return <article key={teacher.teacher_id} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border p-4 ${objected
          ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-slate-900'
          : 'border-slate-200 dark:border-slate-700'}`}>
          <div>
            <h3 className="font-semibold">{teacher.name}</h3>
            {objected && <p className="text-xs text-amber-900 dark:text-amber-200">
              Pediu para não registrar{teacher.decided_at ? ` em ${formatDecisionDate(teacher.decided_at)}` : ''}: as aulas dele não são transcritas.
            </p>}
            {!objected && teacher.google_identity_confirmed === false && <p className="text-xs text-amber-800">
              Sem conta Google confirmada: a sala da escola não nasce para as aulas dele (seguem pelo link de sempre).
            </p>}
            {!objected && teacher.google_identity_confirmed === true && <p className="text-xs text-slate-500">Conta Google confirmada.</p>}
          </div>
          <div className="flex items-center gap-3">
            <SchoolDefaultBadge decision={teacher.decision} effective={teacher.effective} />
            {objected
              ? <button type="button" disabled={!!busy} onClick={() => void withdrawObjection(teacher.teacher_id, teacher.name)} className="text-sm font-semibold text-blue-600 disabled:opacity-40">
                  Desfazer pedido
                </button>
              : <button type="button" disabled={!!busy} onClick={() => void registerObjection(teacher.teacher_id, teacher.name)} className="text-sm text-amber-700 disabled:opacity-40">
                  Registrar pedido para não registrar
                </button>}
          </div>
        </article>;
      })}
      {!schoolDefault && teachers.map(teacher => <article key={teacher.teacher_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <div>
          <h3 className="font-semibold">{teacher.name}</h3>
          {teacher.decided_at && <p className="text-xs text-slate-500">{formatDecisionDate(teacher.decided_at)}</p>}
          {asDecision(teacher.decision) === 'ACCEPTED' && teacher.effective === false && <p className="mt-1 text-xs text-amber-800">
            Aceitou a versão {teacher.decided_term_version || 'anterior'} do termo; precisa aceitar a versão vigente em “Salas e continuidade”. Até lá, as aulas não são transcritas.
          </p>}
        </div>
        <div className="flex items-center gap-3">
          <Badge decision={teacher.decision} />
          {asDecision(teacher.decision) === 'ACCEPTED' && <button type="button" disabled={!!busy} onClick={() => void revoke(teacher.teacher_id, teacher.name)} className="text-sm text-red-600 disabled:opacity-40">
            Registrar revogação
          </button>}
        </div>
      </article>)}
    </section>
  </div>;
}
