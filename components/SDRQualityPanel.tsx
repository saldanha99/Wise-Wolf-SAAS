import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Clock, RefreshCw, UserCheck, MessageCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';

type Attention = {
  id: string; name: string; phone: string; reason: string; waiting_since: string;
  owner_id: string | null; owner_name: string | null;
};
type Report = {
  generated_at: string; viewer_id: string; days: number;
  metrics: { leads: number; trials: number; enrollments: number; unanswered: number; attention: number;
    sent: number; suspected_duplicates: number; acceptance_minutes: number | null; acceptance_samples: number; delivery_failures: number; };
  attention: Attention[];
};
const reasons: Record<string, { label: string; action: string }> = {
  delivery_review: { label: 'Envio precisa de revisão', action: 'Confira a conversa antes de responder: o último envio pode ter chegado.' },
  human_requested: { label: 'Aguardando a equipe', action: 'Assuma o atendimento e ajude o aluno a continuar.' },
  unanswered: { label: 'Resposta atrasada', action: 'Há uma mensagem há mais de 10 minutos sem conclusão do atendimento.' },
  teacher_timeout: { label: 'Professor não confirmou', action: 'Verifique o retorno ao aluno e ajude a encontrar outra opção.' },
  teacher_declined: { label: 'Remarcação precisa de ajuste', action: 'O professor recusou ou houve conflito. Confira outra opção de agenda.' },
  missing_class_result: { label: 'Resultado da aula pendente', action: 'Confira com o professor se a experimental aconteceu e registre o resultado.' },
};
export function waitingLabel(since: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60000));
  if (!Number.isFinite(minutes)) return 'Tempo não informado';
  return minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}min` : `${Math.floor(minutes / 1440)} dias`;
}
const percent = (count: number, total: number) => total ? `${(100 * count / total).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—';

const SDRQualityPanel: React.FC<{ tenantId: string; onLeadChange?: () => void }> = ({ tenantId, onLeadChange }) => {
  const [days, setDays] = useState(7);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [mine, setMine] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('sdr_operations_dashboard', { p_tenant_id: tenantId, p_days: days });
      if (error || !data?.metrics || !Array.isArray(data.attention)) throw new Error('report_unavailable');
      if (id === request.current) { setReport(data as Report); setError(''); }
    } catch {
      if (id === request.current) { setReport(null); setError('Não foi possível carregar a qualidade do atendimento. Verifique seu acesso à gestão da escola e tente novamente.'); }
    } finally { if (id === request.current) setLoading(false); }
  }, [tenantId, days]);
  useEffect(() => {
    setReport(null);
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60000);
    return () => { ++request.current; window.clearInterval(timer); };
  }, [load]);
  const manage = async (leadId: string, action: 'take' | 'release') => {
    setActing(leadId);
    setError('');
    try {
      const { data, error } = await supabase.rpc('manage_sdr_attention', { p_tenant_id: tenantId, p_lead_id: leadId, p_action: action });
      if (error || !data?.ok) {
        const message = data?.error === 'already_assigned' ? 'Outra pessoa já assumiu este atendimento.' : data?.error === 'send_in_progress' ? 'Há uma resposta em andamento. Aguarde a conclusão antes de liberar a IA.' : 'Não foi possível atualizar o atendimento. Tente novamente.';
        setError(message); return;
      }
      await load(); onLeadChange?.();
    } catch { setError('Não foi possível atualizar o atendimento. Tente novamente.'); }
    finally { setActing(null); }
  };
  const m = report?.metrics;
  const items = (report?.attention || []).filter((item) => (filter === 'all' || item.reason === filter) && (!mine || item.owner_id === report?.viewer_id));
  return <section className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-5" aria-label="Qualidade da IA">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-extrabold text-brand-text">Qualidade do atendimento</h2><p className="text-sm text-brand-muted">Acompanhe os resultados e os alunos que precisam da equipe.</p></div>
      <div className="flex gap-2 items-center">
        <select aria-label="Período dos indicadores" className="rounded-xl border border-brand-border bg-brand-surface p-2 text-brand-text" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Últimos 7 dias</option><option value={30}>Últimos 30 dias</option>
        </select>
        <button type="button" onClick={() => void load()} disabled={loading} aria-label="Atualizar qualidade" className="rounded-xl border border-brand-border p-2 text-brand-text disabled:opacity-40"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
      </div>
    </div>
    {error && <div role="alert" className="rounded-xl bg-red-500/10 border border-red-400/40 text-red-600 p-3 flex gap-2"><AlertCircle size={18} className="shrink-0" />{error}</div>}
    {loading && !report && <p role="status" className="text-brand-muted">Carregando atendimento…</p>}
    {report && m && <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          ['Precisam da equipe', m.attention, `${m.unanswered} com resposta atrasada agora`],
          ['Conversão em experimental', percent(m.trials, m.leads), `${m.trials} de ${m.leads} novos contatos atendidos pela IA`],
          ['Conversão em matrícula', percent(m.enrollments, m.leads), `${m.enrollments} de ${m.leads} novos contatos atendidos pela IA`],
          ['Tempo médio de aceite', m.acceptance_minutes === null ? '—' : `${m.acceptance_minutes.toLocaleString('pt-BR')} min`, `${m.acceptance_samples} aceites de experimental e remarcação`],
          ['Possíveis repetições', m.suspected_duplicates, 'Textos iguais em até 5 minutos; precisam de revisão'],
          ['Envios com problema', m.delivery_failures, 'Recusas ou envios sem confirmação de entrega'],
          ['Mensagens aceitas', m.sent, 'Aceitas pelo provedor; não significa que foram lidas'],
          ['Novos contatos com IA', m.leads, `Entraram no CRM nos últimos ${days} dias`],
        ].map(([title, value, description]) => <div key={String(title)} className="rounded-2xl border border-brand-border bg-brand-surface p-4">
          <p className="text-xs font-bold text-brand-muted">{title}</p><p className="text-2xl font-extrabold text-brand-text mt-1">{value}</p><p className="text-xs text-brand-muted mt-1">{description}</p>
        </div>)}
      </div>
      <p className="text-xs text-brand-muted">Conversões mostram a etapa atual dos contatos que entraram no período. A fila mostra pendências atuais, independentemente do período. Atualizado às {new Date(report.generated_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.</p>
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <h3 className="font-extrabold text-brand-text flex gap-2 items-center"><UserCheck size={19} />Fila de atenção</h3>
        <div className="flex flex-wrap gap-3 items-center text-sm text-brand-text">
          <label className="flex gap-2"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />Meus atendimentos</label>
          <select aria-label="Motivo da pendência" value={filter} onChange={(e) => setFilter(e.target.value)} className="bg-brand-surface border border-brand-border rounded-xl p-2">
            <option value="all">Todos os motivos</option>{Object.entries(reasons).map(([key, r]) => <option key={key} value={key}>{r.label}</option>)}
          </select>
        </div>
      </div>
      <p className="text-xs text-brand-muted">Ao assumir, você fica responsável pelo atendimento e a IA pausa. Depois de conferir e atender o aluno, conclua a revisão para liberar a IA; mensagens antigas não serão reenviadas.</p>
      {report.metrics.attention > report.attention.length && <p className="text-sm text-amber-600">Mostrando as 100 pendências prioritárias de {report.metrics.attention}. As demais entram conforme os casos forem tratados.</p>}
      {!items.length ? <div className="rounded-2xl border border-brand-border p-8 text-center text-brand-muted">Nenhuma pendência para este filtro.</div> :
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{items.map((item) => <article key={item.id} className="rounded-2xl border border-brand-border bg-brand-surface p-4 space-y-3">
          <div className="flex items-start justify-between gap-2"><div><h4 className="font-bold text-brand-text">{item.name || 'Contato sem nome'}</h4><p className="text-xs text-brand-muted">{reasons[item.reason]?.label || 'Precisa de atenção'}</p></div><span className="flex items-center gap-1 text-xs text-amber-600 whitespace-nowrap"><Clock size={13} />{waitingLabel(item.waiting_since)}</span></div>
          <p className="text-sm text-brand-muted">{reasons[item.reason]?.action}</p>
          <p className="text-xs text-brand-muted">Responsável: {item.owner_name || 'Ainda não assumido'}</p>
          <div className="flex flex-wrap gap-2">
            {!item.owner_id && <button type="button" disabled={acting !== null} onClick={() => void manage(item.id, 'take')} className="bg-brand-accent text-white font-bold text-xs rounded-xl px-3 py-2 disabled:opacity-40">Assumir atendimento</button>}
            {item.owner_id === report.viewer_id && <button type="button" disabled={acting !== null} onClick={() => void manage(item.id, 'release')} className="border border-brand-border text-brand-text text-xs rounded-xl px-3 py-2 disabled:opacity-40">Concluir revisão e liberar IA</button>}
            {item.phone && <a href={`https://wa.me/${item.phone.replace(/\D/g, '').replace(/^(\d{10,11})$/, '55$1')}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 border border-brand-border text-brand-text text-xs rounded-xl px-3 py-2"><MessageCircle size={13} />Abrir conversa</a>}
          </div>
        </article>)}</div>}
    </>}
  </section>;
};

export default SDRQualityPanel;
