import React, { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  CONSENT_STATUS_LABEL,
  consentStatusText,
  exclusionRequestUrl,
  formatClassDate,
  formatClassTime,
  lessonRecordsErrorMessage,
  parseStudentLessonRecords,
  pendingReviewText,
  rawCopyText,
  revokeHowToText,
  type StudentLessonRecord,
  type StudentLessonRecordsView,
} from '../lib/studentLessonRecords';

/**
 * "Minhas aulas registradas" — o aluno vê o próprio registro das aulas
 * (decisão da direção): só os resumos que o professor APROVOU, sem a
 * transcrição e sem o cartão/observações do professor. O servidor decide o
 * que sai (`get_my_lesson_records`, migration 20260927140000); a tela só
 * mostra e explica o que é guardado, como revogar e como pedir exclusão.
 */
export default function StudentLessonRecords() {
  const [view, setView] = useState<StudentLessonRecordsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: rpcError } = await supabase.rpc('get_my_lesson_records');
    const parsed = rpcError ? null : parseStudentLessonRecords(data);
    if (!parsed) setError(lessonRecordsErrorMessage(rpcError));
    setView(parsed);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const exclusionUrl = view ? exclusionRequestUrl(view) : null;

  return <div data-tour="student-lesson-records" className="space-y-6">
    <header className="flex items-start justify-between gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-[family-name:var(--font-display)] font-extrabold text-brand-text">
          <FileText size={24} className="text-brand-accent" /> Minhas aulas registradas
        </h1>
        <p className="mt-2 text-sm text-brand-muted">
          Aqui aparece, de cada aula registrada na sala da escola no Google Meet, o que o seu professor revisou e aprovou:
          o objetivo, o que foi praticado, o próximo passo e a lição combinada.
        </p>
      </div>
      <button type="button" onClick={() => void load()} disabled={loading} aria-label="Atualizar"
        className="rounded-xl border border-brand-border p-2 text-brand-text disabled:opacity-40">
        {loading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
      </button>
    </header>

    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    {loading && !view && <p className="text-sm text-brand-muted">Carregando…</p>}

    {view && <>
      <section aria-labelledby="lesson-records-list" className="space-y-3">
        <h2 id="lesson-records-list" className="text-lg font-bold text-brand-text">Resumos aprovados</h2>
        {view.pendingReview > 0 && <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300">
          {pendingReviewText(view.pendingReview)}
        </p>}
        {view.records.length === 0
          ? <p className="rounded-2xl border border-brand-border bg-brand-surface p-5 text-sm text-brand-muted">
              Ainda não há resumo aprovado das suas aulas. Ele aparece aqui depois que o professor revisa a aula registrada.
            </p>
          : <ul className="space-y-3">{view.records.map(record => <RecordCard key={record.sessionId} record={record} />)}</ul>}
      </section>

      <section aria-labelledby="lesson-records-storage" className="space-y-3 rounded-2xl border border-brand-border bg-brand-surface p-5">
        <h2 id="lesson-records-storage" className="text-lg font-bold text-brand-text">O que é guardado e por quanto tempo</h2>
        {/* Cada frase aqui tem de ser verdade no sistema: o resumo aprovado
            guarda mais do que a tela mostra (dificuldades e, até 90 dias
            depois da aula, o texto das anotações revisado e trechos da aula —
            private.purge_lesson_memory_retention apaga) e é lido por outros
            professores do aluno e pelo suporte técnico; só a transcrição e a
            presença brutas são exclusivas de quem deu a aula. */}
        <ul className="list-disc space-y-2 pl-5 text-sm text-brand-text">
          <li><b>Resumo aprovado</b>: nesta tela aparecem o objetivo, o que foi praticado, o próximo passo e a lição. O resumo completo que o professor aprovou também guarda as dificuldades e evoluções que ele observou e, até 90 dias depois da aula, pode trazer o texto das anotações da aula revisado por ele e trechos da aula que sustentam o resumo — esses trechos são apagados depois disso. Ele é visto pelos seus professores, pela coordenação e pela direção (e, só para resolver problema técnico, pelo suporte do fornecedor do sistema) — é o que dá continuidade às aulas, inclusive se você trocar de professor. Fica enquanto você estudar na escola e é apagado 90 dias depois que você deixar a escola.</li>
          <li><b>Rascunhos do resumo</b> (antes da aprovação ou recusados pelo professor): são vistos só pelo professor da aula, pela coordenação e pela direção, e não aparecem aqui. Os trechos da aula que eles trazem também são apagados 90 dias depois da aula.</li>
          <li><b>Cópias da transcrição, das anotações do Google e do relatório de presença</b>: ficam no sistema da escola até a data mostrada em cada aula e depois são apagadas. A transcrição completa e a presença são vistas só pelo professor da aula, pela coordenação e pela direção. As anotações podem virar o texto do resumo aprovado depois da revisão do professor — aí seguem a regra do resumo.</li>
          <li><b>Arquivos originais no Google</b>: ficam na conta Google da escola, que só a direção acessa. O termo (logo abaixo) diz em quanto tempo a escola os apaga; se você pedir a exclusão, eles são apagados antes.</li>
          <li>A aula não é gravada em vídeo.</li>
        </ul>
        {view.term && <details className="rounded-xl border border-brand-border p-3">
          <summary className="cursor-pointer text-sm font-bold text-brand-text">Ler o termo completo (versão {view.term.version})</summary>
          <p className="mt-3 max-h-80 overflow-y-auto whitespace-pre-line text-sm text-brand-muted">{view.term.body}</p>
        </details>}
      </section>

      <section aria-labelledby="lesson-records-consent" className="space-y-3 rounded-2xl border border-brand-border bg-brand-surface p-5">
        <h2 id="lesson-records-consent" className="flex items-center gap-2 text-lg font-bold text-brand-text">
          <ShieldCheck size={20} className="text-brand-accent" /> Sua autorização: {CONSENT_STATUS_LABEL[view.consent.status]}
        </h2>
        <p className="text-sm text-brand-text">{consentStatusText(view.consent)}</p>
        <p className="text-sm text-brand-muted">{revokeHowToText(view.consent)}</p>
        <p className="text-sm text-brand-muted">Revogar vale para as aulas seguintes; o que já foi aprovado continua aqui. Para pedir que seja apagado, veja abaixo.</p>
      </section>

      <section aria-labelledby="lesson-records-exclusion" className="space-y-3 rounded-2xl border border-brand-border bg-brand-surface p-5">
        <h2 id="lesson-records-exclusion" className="text-lg font-bold text-brand-text">Pedir a exclusão</h2>
        {/* O fluxo real: o aluno pede pelo WhatsApp, a direção apaga pelo
            botão da ficha (erase_student_lesson_records, 20260927120000). A
            lista abaixo é a do que aquela RPC apaga — mudou lá, muda aqui. */}
        <p className="text-sm text-brand-text">
          Você pode pedir a exclusão do registro das suas aulas a qualquer momento, pelo WhatsApp da escola{view.schoolName ? ` (${view.schoolName})` : ''}. A direção confere o pedido e apaga, de uma vez, o que o sistema da escola guardou das suas aulas já realizadas: os resumos (aprovados e rascunhos), as cópias da transcrição, das anotações e da presença, a memória das aulas usada para planejar e o seu cartão de aluno, com as sugestões da IA para ele que o professor ainda não tinha decidido. Os arquivos originais na conta Google da escola também são apagados (vão para a lixeira do Google, que os elimina de vez em até 30 dias). Continuam a presença e os pagamentos lançados e o registro das suas respostas ao termo. Para que as próximas aulas também não sejam transcritas, revogue a autorização (acima).
        </p>
        {exclusionUrl
          ? <a href={exclusionUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700">
              <MessageCircle size={16} /> Pedir pelo WhatsApp da escola
            </a>
          : <p className="text-sm font-semibold text-brand-text">Para pedir a exclusão, fale com a escola{view.schoolName ? ` (${view.schoolName})` : ''} pelo WhatsApp.</p>}
      </section>
    </>}
  </div>;
}

const RecordCard: React.FC<{ record: StudentLessonRecord }> = ({ record }) => {
  const time = formatClassTime(record.startsAt);
  return <li className="space-y-2 rounded-2xl border border-brand-border bg-brand-surface p-5">
    <p className="text-xs font-bold uppercase tracking-widest text-brand-muted">
      {formatClassDate(record)}{time ? ` · ${time}` : ''}{record.teacherName ? ` · ${record.teacherName}` : ''}
    </p>
    {record.objective && <p className="text-sm text-brand-text"><span className="font-semibold">Objetivo:</span> {record.objective}</p>}
    {record.practiced.length > 0 && <div className="text-sm text-brand-text">
      <span className="font-semibold">Praticado:</span>
      <ul className="mt-1 list-disc pl-5">{record.practiced.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div>}
    {record.nextStep && <p className="text-sm text-brand-text"><span className="font-semibold">Próximo passo:</span> {record.nextStep}</p>}
    {record.homework && <p className="text-sm text-brand-text"><span className="font-semibold">Lição:</span> {record.homework}</p>}
    <p className="text-xs text-brand-muted">{rawCopyText(record)}</p>
  </li>;
};
