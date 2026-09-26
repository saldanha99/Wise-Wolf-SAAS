import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, MessageCircle, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  asDecision,
  consentErrorMessage,
  consentLink,
  consentWhatsAppMessage,
  DECISION_LABEL,
  formatDecisionDate,
  formatSendTime,
  missingContactLabel,
  notSentReasonLabel,
  RECIPIENT_LABEL,
  RELATION_LABEL,
  REQUEST_STATE_LABEL,
  resendAllowed,
  sendWindowText,
  whatsappUrl,
  type ConsentRecipient,
  type RecordingDecision,
  type RequestState,
  type SignerRelation,
} from '../lib/lessonRecordingConsent';

type StudentRow = {
  student_id: string;
  name: string;
  requires_guardian: boolean;
  guardian_name: string | null;
  contact_phone: string | null;
  decision: string;
  decided_at: string | null;
  signer_name: string | null;
  signer_relation: string | null;
  link_expires_at: string | null;
};
type TeacherRow = { teacher_id: string; name: string; decision: string; decided_at: string | null };
type Overview = { google_connected: boolean; students: StudentRow[]; teachers: TeacherRow[] };

// Envio em lote (list_lesson_recording_consent_requests).
type RequestInfo = {
  attempt: number;
  requested_at: string;
  scheduled_for: string;
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
  recipient: ConsentRecipient | null;
  contact_last4: string | null;
  missing_reason: string | null;
  request: RequestInfo | null;
  resend_available_at: string | null;
};
type SendOverview = { can_send: boolean; term_version: string; students: SendRow[] };
type BatchPreview = {
  to_send: number;
  to_guardians: number;
  term_updated: number;
  no_contact: number;
  left_for_next_batch: number;
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
  if (request.state === 'QUEUED') return `Na fila · sai ${formatSendTime(request.scheduled_for)}`;
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

export default function LessonRecordingConsentsPanel({ schoolName }: { schoolName?: string | null }) {
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [links, setLinks] = useState<Record<string, string>>({});
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
    const ok = window.confirm(
      `Enviar o termo para ${row.name} (${who}, número terminado em ${row.contact_last4})?\n\n` +
      'A mensagem entra na fila da escola e sai no próximo horário livre (segunda a sábado, das 9h às 20h).',
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
    setLinks(current => ({ ...current, [student.student_id]: consentLink(window.location.origin, result.token) }));
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

  async function copy(studentId: string, link: string) {
    try { await navigator.clipboard.writeText(link); setCopied(studentId); }
    catch { window.prompt('Copie o link:', link); }
  }

  const students = data?.students || [];
  const teachers = data?.teachers || [];
  const acceptedStudents = students.filter(s => asDecision(s.decision) === 'ACCEPTED').length;
  const acceptedTeachers = teachers.filter(t => asDecision(t.decision) === 'ACCEPTED').length;
  const sendRows = sending?.students || [];
  const waitingCount = sendRows.filter(row => sendFilterMatches(row, 'pending')).length;
  const noContactCount = sendRows.filter(row => sendFilterMatches(row, 'no_contact')).length;
  const inQueueCount = sendRows.filter(row => row.request?.state === 'QUEUED').length;
  const visibleSendRows = sendRows.filter(row => sendFilterMatches(row, sendFilter));

  return <div data-tour="recording-consents" className="space-y-5 text-slate-800 dark:text-slate-100">
    <header className="flex items-start justify-between gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold"><ShieldCheck size={24} /> Autorizações de registro</h1>
        <p className="mt-2 text-sm text-slate-500">
          A transcrição da aula só acontece quando o aluno (ou o responsável, se for menor) <b>e</b> o professor autorizaram.
          Cada um responde uma vez; vale até revogar.
        </p>
      </div>
      <button type="button" onClick={() => void load()} disabled={!!busy} aria-label="Atualizar" className="rounded-xl border p-2">
        {busy === 'load' ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
      </button>
    </header>

    {data && !data.google_connected && <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
      A conta Google da escola ainda não está conectada. As autorizações ficam guardadas e passam a valer assim que ela for conectada.
    </p>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p>}

    {data && <div className="grid grid-cols-2 gap-3">
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-2xl font-bold">{acceptedStudents}<span className="text-base text-slate-400"> de {students.length}</span></p>
        <p className="mt-1 text-xs text-slate-500">alunos autorizaram</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-2xl font-bold">{acceptedTeachers}<span className="text-base text-slate-400"> de {teachers.length}</span></p>
        <p className="mt-1 text-xs text-slate-500">professores autorizaram</p>
      </div>
    </div>}

    {sending && <section data-tour="recording-consents-send" className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Envio do termo pelo WhatsApp da escola</h2>
          <p className="mt-1 text-sm text-slate-500">
            {waitingCount} aguardando resposta · {inQueueCount} na fila · {noContactCount} sem contato.
            Menor de idade ou idade não cadastrada: vai ao responsável.
          </p>
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
                {preview.no_contact > 0 && <li>
                  {preview.no_contact} {preview.no_contact === 1 ? 'fica' : 'ficam'} de fora por falta de contato.
                </li>}
                {preview.left_for_next_batch > 0 && <li>
                  {preview.left_for_next_batch} {preview.left_for_next_batch === 1 ? 'fica' : 'ficam'} para o próximo envio (até 60 por vez).
                </li>}
                <li>Quem responder, revogar ou mudar de contato antes do horário não recebe.</li>
              </ul>
              {!preview.student_notifications_enabled && <p className="font-semibold text-red-700">
                Os avisos a alunos estão desligados nas configurações da escola — o envio será recusado.
              </p>}
              <div className="flex flex-wrap gap-3 pt-1">
                <button type="button" disabled={!!busy} onClick={() => void confirmBatch()}
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
            </div>
            <div className="flex flex-col items-end gap-1 text-xs">
              <Badge decision={row.decision} />
              {decision !== 'NONE' && row.decided_at && <span className="text-slate-500">{formatDecisionDate(row.decided_at)}</span>}
              {row.eligible && decision === 'ACCEPTED' && <span className="text-slate-500">aceitou versão anterior</span>}
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
        const decision = asDecision(student.decision);
        const link = links[student.student_id];
        const message = link ? consentWhatsAppMessage({ studentName: student.name, schoolName, link, forGuardian: student.requires_guardian }) : '';
        const whatsapp = link ? whatsappUrl(student.contact_phone, message) : null;
        return <article key={student.student_id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold">{student.name}</h3>
              {student.requires_guardian && <p className="text-xs text-slate-500">Menor de idade · responde {student.guardian_name || 'o responsável'}</p>}
            </div>
            <Badge decision={student.decision} />
          </div>
          {decision !== 'NONE' && <p className="mt-2 text-xs text-slate-500">
            {student.signer_name} ({RELATION_LABEL[(student.signer_relation || 'SELF') as SignerRelation]}) · {formatDecisionDate(student.decided_at)}
          </p>}
          {decision === 'NONE' && student.link_expires_at && !link && <p className="mt-2 text-xs text-slate-500">
            Link enviado, válido até {formatDecisionDate(student.link_expires_at)}.
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
            <p className="text-xs">O link vale 30 dias. Gerar outro invalida este.</p>
          </div>}
        </article>;
      })}
    </section>

    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Professores</h2>
      <p className="text-sm text-slate-500">Cada professor autoriza pela própria conta, na tela “Salas e continuidade”.</p>
      {teachers.map(teacher => <article key={teacher.teacher_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <div>
          <h3 className="font-semibold">{teacher.name}</h3>
          {teacher.decided_at && <p className="text-xs text-slate-500">{formatDecisionDate(teacher.decided_at)}</p>}
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
