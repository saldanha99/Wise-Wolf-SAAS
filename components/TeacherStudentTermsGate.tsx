import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileSignature, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { teacherTermsNeedingAction, termAgenda, type IndividualTerm, type IndividualTermsData } from '../lib/teacherStudentTerms';
import TeacherStudentTerms from './TeacherStudentTerms';

/**
 * Termo individual pendente do PRÓPRIO professor (dados de prestador ou a
 * assinatura dele depois da escola) abre um pop-up obrigatório: sem ele a aula
 * do aluno novo não entra na agenda e a matrícula não é liberada. Decisão da
 * direção (29/10/2026). Fecha sozinho quando não sobra nada para ele fazer;
 * "aguardando a escola" não prende o professor.
 */
export default function TeacherStudentTermsGate({ blocked, onActiveChange, onLogout }: {
  blocked: boolean;
  onActiveChange: (active: boolean) => void;
  onLogout: () => void;
}) {
  const [pending, setPending] = useState<IndividualTerm[] | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const apply = useCallback((data: IndividualTermsData) => {
    setPending(teacherTermsNeedingAction(data));
  }, []);

  const check = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('teacher_student_terms', { p_action: 'list' });
      if (error || data?.ok !== true) return; // falha de leitura não prende ninguém
      apply(data as IndividualTermsData);
    } catch { /* idem */ }
  }, [apply]);

  useEffect(() => {
    void check();
    // A assinatura da escola pode chegar com o portal aberto.
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void check(); }, 60000);
    return () => window.clearInterval(timer);
  }, [check]);

  const active = !blocked && (pending?.length ?? 0) > 0;
  useEffect(() => { onActiveChange(active); }, [active, onActiveChange]);
  useEffect(() => () => onActiveChange(false), [onActiveChange]);
  useEffect(() => {
    if (!active) return;
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { if (node?.open) node.close(); };
  }, [active]);

  if (!active || !pending) return null;
  const needsIdentity = pending.some(t => t.phase === 'IDENTITY_PENDING');
  return <dialog ref={dialog} onCancel={event => event.preventDefault()} aria-labelledby="teacher-terms-gate-title"
    className="m-auto w-[calc(100%-2rem)] max-w-3xl max-h-[92dvh] overflow-y-auto rounded-3xl border-0 bg-white p-6 text-slate-900 shadow-2xl backdrop:bg-slate-950/70 dark:bg-slate-900 dark:text-white sm:p-8">
    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-700"><FileSignature size={26} /></div>
    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">Pendência obrigatória · Termo por aluno</p>
    <h2 id="teacher-terms-gate-title" className="text-2xl font-bold">
      {pending.length === 1 ? `Você tem um aluno novo: ${pending[0].student_name}` : `Você tem ${pending.length} alunos novos esperando você`}
    </h2>
    <ul className="mt-3 space-y-1 text-sm text-slate-600 dark:text-slate-300">
      {pending.map(t => <li key={t.id}><strong>{t.student_name}</strong> · {termAgenda(t.slots)}</li>)}
    </ul>
    <ol className="my-4 list-decimal space-y-1 pl-5 text-sm leading-6">
      {needsIdentity
        ? <>
          <li>Abaixo, em <strong>“Conferir meus dados de prestador”</strong>, escolha <strong>“Tenho CNPJ”</strong> (empresa ou MEI) ou <strong>“Sou autônomo”</strong>, preencha os dados e salve. Só precisa fazer uma vez.</li>
          <li>A direção assina o termo e você recebe um aviso no WhatsApp.</li>
          <li>Volte aqui, abra o termo do aluno e toque em <strong>“Assinar esta versão”</strong>.</li>
        </>
        : <li>A escola já assinou. Abra o termo do aluno abaixo, confira, digite seu nome completo e toque em <strong>“Assinar esta versão”</strong>. Se não puder assumir, use <strong>Recusar</strong>.</li>}
    </ol>
    <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">Enquanto isso não for feito, as aulas desse aluno não entram na sua agenda.</p>
    {pending === null ? <p role="status" className="flex items-center gap-2"><Loader2 className="animate-spin" size={18} /> Carregando…</p>
      : <TeacherStudentTerms openIdentity={needsIdentity} onLoaded={apply} />}
    <button type="button" onClick={onLogout} className="mt-5 w-full py-2 text-sm text-slate-500 dark:text-slate-400">Sair da conta do portal</button>
  </dialog>;
}
