import React, { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { googleMeetErrorMessage } from '../lib/googleMeet';
import { erasureItems, erasureOriginalsText, readErasurePreview, type ErasurePreview, type ErasureResult } from '../lib/meetOriginals';

// "Apagar registros das aulas deste aluno" — só a direção (SCHOOL_ADMIN), a
// pedido do aluno ou do responsável (decisão da direção, 26/09/2026). A tela
// mostra ANTES o que será apagado (prévia do servidor) e só apaga na confirmação.
// O servidor confere o papel de novo e deixa a trilha sem conteúdo.
export default function StudentLessonRecordsErasure({ studentId, onErased }: { studentId: string; onErased?: () => void }) {
  const [preview, setPreview] = useState<ErasurePreview | null>(null);
  const [result, setResult] = useState<ErasureResult | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'erase'>('');
  const [error, setError] = useState('');

  const openPreview = async () => {
    setBusy('preview'); setError(''); setResult(null);
    const { data, error: rpcError } = await supabase.rpc('get_student_lesson_records_erasure_preview', { p_student_id: studentId });
    const parsed = rpcError ? null : readErasurePreview(data);
    if (!parsed) setError(googleMeetErrorMessage(rpcError?.message, 'Não foi possível montar a prévia da exclusão.'));
    setPreview(parsed);
    setBusy('');
  };
  const erase = async () => {
    setBusy('erase'); setError('');
    const { data, error: rpcError } = await supabase.rpc('erase_student_lesson_records', { p_student_id: studentId });
    if (rpcError || data?.ok !== true) {
      setError(googleMeetErrorMessage(rpcError?.message, 'Não foi possível apagar os registros.'));
    } else {
      setResult(data as ErasureResult); setPreview(null); onErased?.();
    }
    setBusy('');
  };

  return <section data-tour="student-records-erasure" className="space-y-3 rounded-xl border border-red-200 p-4 dark:border-red-900/50">
    <h4 className="flex items-center gap-2 font-semibold text-red-800 dark:text-red-300"><Trash2 size={16}/>Registros das aulas no Meet</h4>
    <p className="text-sm text-slate-600 dark:text-slate-300">A pedido do aluno (ou do responsável), a direção apaga o que o sistema guardou das aulas dele no Google Meet e manda os originais para a lixeira do Drive da escola. Presença lançada, pagamento e o registro do aceite do termo não mudam, e as próximas aulas seguem o aceite que estiver valendo.</p>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {result && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">Registros apagados: {result.raw_copies_deleted} cópia(s) de transcrição e anotações, {result.attendance_reports_deleted} relatório(s) de presença, {result.summary_versions_deleted} rascunho(s)/resumo(s), {result.memories_deleted} registro(s) de memória{result.card_deleted ? ' e o cartão do aluno' : ''}. {result.originals_queued + result.sessions_to_discover > 0 ? 'Os originais entraram na fila da lixeira do Drive.' : ''} Essas aulas não voltam a ser importadas.</p>}
    {!preview && <button type="button" disabled={!!busy} onClick={() => void openPreview()} className="inline-flex items-center gap-2 rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-300">
      {busy === 'preview' && <Loader2 size={14} className="animate-spin"/>}Apagar registros das aulas deste aluno
    </button>}
    {preview && <div className="space-y-3 rounded-lg bg-red-50 p-4 text-sm text-red-900 dark:bg-red-950/30 dark:text-red-200" data-testid="erasure-preview">
      <p className="font-semibold">Isto será apagado agora, de {preview.sessions} aula(s) já realizada(s):</p>
      <ul className="list-disc space-y-1 pl-5">{erasureItems(preview).map(item => <li key={item.key}>{item.label}</li>)}</ul>
      <p>{erasureOriginalsText(preview)}</p>
      <p>Não dá para desfazer no sistema. No Drive, os originais ainda ficam 30 dias na lixeira.{preview.last_erasure_at ? ` Já houve um pedido para este aluno em ${new Date(preview.last_erasure_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.` : ''}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!!busy} onClick={() => void erase()} className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 font-semibold text-white disabled:opacity-50">
          {busy === 'erase' && <Loader2 size={14} className="animate-spin"/>}Confirmar e apagar
        </button>
        <button type="button" disabled={!!busy} onClick={() => setPreview(null)} className="rounded-lg border border-red-300 px-4 py-2 font-semibold">Cancelar</button>
      </div>
    </div>}
  </section>;
}
