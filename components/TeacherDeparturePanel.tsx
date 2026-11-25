import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Loader2, Send, UserMinus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  buildPenaltyMessage, dayMonth, money, slotsText, studentStatusLabel,
  type DepartureInfo, type DeparturePenalty, type DepartureStudent,
} from '../lib/teacherDeparture';

// Saída do professor (direção): prévia dos alunos com quem tem os horários
// livres, abertura para os professores (o primeiro que aceitar fica com o
// aluno) e a conta da multa de aviso, calculada no servidor.

interface Props { teacherId: string; teacherName: string; }

interface DepartureState {
  departure: DepartureInfo | null;
  students: DepartureStudent[];
  penalty: DeparturePenalty | null;
}

const todayLocal = (): string => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : (e as { message?: string })?.message) || 'Erro inesperado.';

const TeacherDeparturePanel: React.FC<Props> = ({ teacherId, teacherName }) => {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<DepartureState>({ departure: null, students: [], penalty: null });
  const [preview, setPreview] = useState<DepartureState | null>(null);
  const [noticeAt, setNoticeAt] = useState(todayLocal());
  const [lastDay, setLastDay] = useState('');
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState(false);
  const [assignTo, setAssignTo] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('get_teacher_departure', { p_teacher: teacherId });
    if (rpcError) setError(rpcError.message);
    else setState({
      departure: (data?.departure as DepartureInfo | null) ?? null,
      students: (data?.students as DepartureStudent[] | null) ?? [],
      penalty: (data?.penalty as DeparturePenalty | null) ?? null,
    });
    setLoading(false);
  }, [teacherId]);

  useEffect(() => { void load(); }, [load]);

  const open = state.departure?.status === 'OPEN' ? state.departure : null;

  const runPreview = async () => {
    if (!lastDay) { setError('Informe o último dia de aula.'); return; }
    setBusy(true); setError(null);
    const { data, error: rpcError } = await supabase.rpc('teacher_departure_preview', {
      p_teacher: teacherId, p_notice_at: new Date(noticeAt).toISOString(), p_last_day: lastDay,
    });
    if (rpcError) setError(rpcError.message);
    else setPreview({ departure: null, students: (data?.students as DepartureStudent[]) ?? [], penalty: (data?.penalty as DeparturePenalty) ?? null });
    setBusy(false);
  };

  const openDeparture = async () => {
    if (reason.trim().length < 8) { setError('Escreva o motivo da saída (mínimo de 8 caracteres).'); return; }
    if (!window.confirm('Abrir os alunos para os professores? Quem tem todos os horários livres recebe um WhatsApp, e o primeiro que aceitar fica com o aluno.')) return;
    setBusy(true); setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('open_teacher_departure', {
        p_teacher: teacherId, p_notice_at: new Date(noticeAt).toISOString(), p_last_day: lastDay, p_reason: reason.trim(),
      });
      if (rpcError) throw rpcError;
      window.alert(`Pronto: ${data?.offers ?? 0} aluno(s) abertos e ${data?.teachers_notified ?? 0} professor(es) avisados.${(data?.without_candidate ?? 0) > 0 ? ` ${data.without_candidate} aluno(s) sem professor livre em todos os horários: atribua abaixo ou pela transferência.` : ''}`);
      setPreview(null);
      await load();
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };

  const assign = async (offerId: string) => {
    const teacher = assignTo[offerId];
    if (!teacher) return;
    setBusy(true); setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('assign_departure_offer', { p_offer: offerId, p_teacher: teacher });
      if (rpcError) throw rpcError;
      if (data?.ok === false) throw new Error(data.error === 'horario_indisponivel' ? 'Esse professor não tem mais todos os horários livres.' : String(data.error));
      await load();
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };

  const close = async () => {
    if (!open) return;
    const why = window.prompt('Motivo para encerrar a saída (os alunos ainda abertos saem do painel dos professores):');
    if (!why || why.trim().length < 8) return;
    setBusy(true); setError(null);
    const { error: rpcError } = await supabase.rpc('close_teacher_departure', { p_departure: open.id, p_reason: why.trim() });
    if (rpcError) setError(rpcError.message);
    await load();
    setBusy(false);
  };

  const copyMessage = async (p: DeparturePenalty) => {
    await navigator.clipboard.writeText(buildPenaltyMessage(teacherName, p));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };

  if (loading) return <div className="p-10 flex justify-center"><Loader2 className="animate-spin text-brand-accent" size={24} /></div>;

  const view = open ? state : preview;

  return (
    <div className="space-y-4" data-tour="teacher-departure">
      {error && <p className="text-sm font-bold text-red-600 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex gap-2"><AlertTriangle size={16} className="shrink-0 mt-0.5" />{error}</p>}

      {!open && (
        <div className="bg-brand-surface-2/50 border border-brand-border rounded-2xl p-4 space-y-3">
          <p className="text-sm text-brand-text font-bold flex items-center gap-2"><UserMinus size={16} />Registrar a saída e repassar os alunos</p>
          <p className="text-xs text-brand-muted">Os alunos vão para os professores que já têm todos os horários livres, sem aula experimental: a primeira aula é a de conhecimento. A troca só vale depois do último dia.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold text-brand-muted">Aviso recebido em
              <input type="datetime-local" value={noticeAt} onChange={e => setNoticeAt(e.target.value)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
            </label>
            <label className="text-xs font-bold text-brand-muted">Último dia de aula
              <input type="date" value={lastDay} onChange={e => setLastDay(e.target.value)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
            </label>
          </div>
          <label className="block text-xs font-bold text-brand-muted">Motivo
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Ex.: proposta de emprego, avisou em 25/11" className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button onClick={runPreview} disabled={busy} className="px-4 py-2 rounded-xl bg-brand-surface border border-brand-border text-sm font-bold text-brand-text disabled:opacity-50">Ver alunos e multa</button>
            {preview && <button onClick={openDeparture} disabled={busy} className="px-4 py-2 rounded-xl bg-brand-accent text-white text-sm font-bold flex items-center gap-2 disabled:opacity-50"><Send size={14} />Abrir para os professores</button>}
          </div>
        </div>
      )}

      {open && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/40 rounded-2xl p-4">
          <p className="text-sm text-brand-text">Saída aberta · último dia <b>{dayMonth(open.last_day)}</b> · troca a partir de <b>{dayMonth(open.cutover_date)}</b></p>
          <button onClick={close} disabled={busy} className="text-xs font-bold text-brand-muted underline">Encerrar saída</button>
        </div>
      )}

      {view && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-brand-muted font-bold">{view.students.length} aluno(s)</p>
          {view.students.length === 0 && <p className="text-sm text-brand-muted">Nenhum aluno com aula fixa com este professor.</p>}
          {view.students.map(s => (
            <div key={s.student_id} className="rounded-xl border border-brand-border p-3 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-brand-text">{s.student_name}</p>
                <span className={`text-[11px] font-bold ${s.status === 'CLAIMED' || s.status === 'ASSIGNED' ? 'text-emerald-600' : s.blocked || s.candidates.length === 0 ? 'text-amber-600' : 'text-brand-muted'}`}>{studentStatusLabel(s)}</span>
              </div>
              <p className="text-xs text-brand-muted">{slotsText(s.slots)}</p>
              {(s.status === 'OPEN' || s.status === 'PREVIEW') && s.candidates.length > 0 && (
                <p className="text-xs text-brand-muted">Com todos os horários livres: {s.candidates.map(c => c.name.split(' ')[0]).join(', ')}</p>
              )}
              {s.status === 'OPEN' && s.offer_id && s.candidates.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <select value={assignTo[s.offer_id] ?? ''} onChange={e => setAssignTo(m => ({ ...m, [s.offer_id as string]: e.target.value }))} className="rounded-lg border border-brand-border bg-brand-surface p-1.5 text-xs text-brand-text">
                    <option value="">Atribuir direto a…</option>
                    {s.candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button onClick={() => assign(s.offer_id as string)} disabled={busy || !assignTo[s.offer_id]} className="px-3 py-1.5 rounded-lg bg-brand-accent text-white text-xs font-bold disabled:opacity-50">Atribuir</button>
                </div>
              )}
            </div>
          ))}
          {view.students.some(s => s.status !== 'CLAIMED' && s.status !== 'ASSIGNED' && (s.blocked || s.candidates.length === 0)) && (
            <p className="text-xs text-brand-muted">Aluno sem professor livre em todos os horários: troque horário e professor pela transferência na agenda do aluno, ou divida com cobertura.</p>
          )}
        </div>
      )}

      {view?.penalty && (
        <div className="rounded-2xl border border-brand-border p-4 space-y-2">
          <p className="text-sm font-bold text-brand-text">Multa por aviso não cumprido</p>
          <p className="text-xs text-brand-muted">Aviso de 30 dias: {dayMonth(view.penalty.notice_date)} a {dayMonth(view.penalty.notice_end)}. Cumpridos {view.penalty.days_served}, sem cumprir {view.penalty.days_missing}.</p>
          <ul className="text-xs text-brand-text space-y-1">
            <li>Contrato geral, cláusula {view.penalty.contract_clause} (versão {view.penalty.contract_version}): base {money(view.penalty.monthly_base)}/mês × {view.penalty.days_missing}/30 = <b>{money(view.penalty.general_penalty)}</b></li>
            {view.penalty.term_penalties.map(t => (
              <li key={t.student_id}>Termo de {t.student_name} (cláusula 5.2): {t.method === 'MEDIA_DOS_MESES_COMPLETOS' ? `2 × média de ${t.complete_months} mês(es)` : `${money(t.unit_rate)} × ${t.units_per_week} aulas × 8,6 semanas`} = <b>{money(t.amount)}</b></li>
            ))}
          </ul>
          <p className="text-sm font-black text-brand-text">Total: {money(view.penalty.total)}</p>
          <p className={`text-xs font-bold flex items-center gap-1 ${view.penalty.credit.total >= view.penalty.total ? 'text-emerald-600' : 'text-amber-600'}`}>
            <CheckCircle2 size={14} />A receber da escola: {money(view.penalty.credit.total)} ({view.penalty.credit.total >= view.penalty.total ? 'cobre a multa por compensação' : 'não cobre tudo; o restante vai por Pix'})
          </p>
          <p className="text-[11px] text-brand-muted">Nada é descontado sozinho: a compensação precisa do "concordo" do professor por escrito, e ele pode se manifestar antes. O bônus de transição de 10% só vale para quem cumpre o aviso.</p>
          {view.penalty.total > 0 && (
            <button onClick={() => copyMessage(view.penalty as DeparturePenalty)} className="px-3 py-1.5 rounded-lg bg-brand-surface border border-brand-border text-xs font-bold text-brand-text flex items-center gap-1">
              <Copy size={12} />{copied ? 'Mensagem copiada' : 'Copiar mensagem para o professor'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default TeacherDeparturePanel;
