import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  asDecision,
  consentErrorMessage,
  consentLink,
  consentWhatsAppMessage,
  DECISION_LABEL,
  formatDecisionDate,
  RELATION_LABEL,
  whatsappUrl,
  type RecordingDecision,
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

  const load = useCallback(async () => {
    setBusy('load'); setError('');
    const { data: result, error: rpcError } = await supabase.rpc('list_lesson_recording_consents');
    if (rpcError || result?.ok !== true) setError(consentErrorMessage(rpcError?.message));
    else setData(result as Overview);
    setBusy('');
  }, []);
  useEffect(() => { void load(); }, [load]);

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
