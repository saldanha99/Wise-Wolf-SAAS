import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Zap, MessageSquareMore, CalendarDays, Gift, BarChart2, Receipt, CheckCircle2, XCircle, Loader2, RefreshCw } from 'lucide-react';

interface Props { user: any; tenantId?: string; }

interface AutomationDef {
  id: string;
  icon: React.ReactNode;
  title: string;
  desc: string;
  edgeFn: string;
  body?: Record<string, unknown>;
  color: string;
  schedule: string;
}

const AUTOMATIONS: AutomationDef[] = [
  {
    id: 'daily',
    icon: <CalendarDays size={20} />,
    title: 'Automações Diárias',
    desc: 'Aniversários (aluno + professor), agenda do dia para cada professor, e follow-up de aulas experimentais (2 dias sem matrícula).',
    edgeFn: 'daily-automations',
    color: 'text-violet-400',
    schedule: 'Cron: todo dia 08:00',
  },
  {
    id: 'weekly',
    icon: <BarChart2 size={20} />,
    title: 'Resumo Semanal do Diretor',
    desc: 'Envia WhatsApp ao diretor com: alunos ativos, aulas dos últimos 7 dias, recebido na semana, inadimplência.',
    edgeFn: 'weekly-director-digest',
    color: 'text-blue-400',
    schedule: 'Cron: toda segunda 08:00',
  },
  {
    id: 'monthly',
    icon: <Receipt size={20} />,
    title: 'Fechamento Mensal do Professor',
    desc: 'Gera os fechamentos do mês anterior para todos os professores e avisa cada um pelo WhatsApp com o total + link para o PDF.',
    edgeFn: 'monthly-teacher-closing',
    color: 'text-emerald-400',
    schedule: 'Cron: dia 1 de cada mês, 03:30',
  },
];

type RunState = { status: 'idle' } | { status: 'running' } | { status: 'ok'; data: Record<string, unknown> } | { status: 'err'; msg: string };

const AutomationPanel: React.FC<Props> = ({ user }) => {
  const [states, setStates] = useState<Record<string, RunState>>(
    Object.fromEntries(AUTOMATIONS.map(a => [a.id, { status: 'idle' }]))
  );

  const run = async (a: AutomationDef) => {
    setStates(s => ({ ...s, [a.id]: { status: 'running' } }));
    try {
      const { data, error } = await supabase.functions.invoke(a.edgeFn, { body: a.body ?? {} });
      if (error) throw new Error(error.message);
      setStates(s => ({ ...s, [a.id]: { status: 'ok', data: data as Record<string, unknown> } }));
    } catch (e: any) {
      setStates(s => ({ ...s, [a.id]: { status: 'err', msg: e.message } }));
    }
  };

  const reset = (id: string) => setStates(s => ({ ...s, [id]: { status: 'idle' } }));

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-2xl bg-brand-accent/10">
          <Zap size={22} className="text-brand-accent" />
        </div>
        <div>
          <h1 className="text-xl font-black text-brand-text">Automações de WhatsApp</h1>
          <p className="text-xs text-brand-muted">Rodam automaticamente por cron. Disparo manual aqui envia mensagens reais.</p>
        </div>
      </div>

      {/* Aviso de impacto real */}
      <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-400/30 rounded-2xl px-4 py-3">
        <MessageSquareMore size={16} className="text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-200 leading-relaxed">
          <b>Atenção:</b> disparar manualmente envia mensagens reais pelo WhatsApp agora. Use para testes pontuais ou reenvio justificado. A idempotência evita duplicatas no mesmo dia, mas cada execução em dias diferentes conta como novo envio.
        </p>
      </div>

      {/* Cards */}
      <div className="space-y-3">
        {AUTOMATIONS.map(a => {
          const st = states[a.id];
          const running = st.status === 'running';
          const done = st.status === 'ok';
          const err = st.status === 'err';
          return (
            <div key={a.id} className="bg-brand-surface border border-brand-border rounded-2xl overflow-hidden">
              <div className="p-5 flex items-start gap-4">
                <div className={`p-2.5 rounded-xl bg-brand-surface-2 shrink-0 ${a.color}`}>{a.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-brand-text">{a.title}</h3>
                    <span className="text-[10px] font-black bg-brand-surface-2 text-brand-muted px-2 py-0.5 rounded-full">{a.schedule}</span>
                  </div>
                  <p className="text-xs text-brand-muted mt-1 leading-relaxed">{a.desc}</p>
                </div>
                <div className="shrink-0">
                  {st.status === 'idle' && (
                    <button onClick={() => run(a)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-brand-accent/10 text-brand-accent text-xs font-black hover:bg-brand-accent/20 transition-colors">
                      <Zap size={13} /> Disparar
                    </button>
                  )}
                  {running && (
                    <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-brand-surface-2 text-brand-muted text-xs font-bold">
                      <Loader2 size={13} className="animate-spin" /> Enviando…
                    </div>
                  )}
                  {(done || err) && (
                    <button onClick={() => reset(a.id)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-brand-surface-2 text-brand-muted text-xs font-bold hover:bg-brand-surface-2/80">
                      <RefreshCw size={13} /> Resetar
                    </button>
                  )}
                </div>
              </div>

              {/* Resultado */}
              {done && (
                <div className="border-t border-brand-border bg-emerald-500/5 px-5 py-3 flex items-start gap-2">
                  <CheckCircle2 size={15} className="text-emerald-400 shrink-0 mt-0.5" />
                  <div className="text-xs text-emerald-300 font-mono break-all">
                    <ResultSummary data={(st as any).data} id={a.id} />
                  </div>
                </div>
              )}
              {err && (
                <div className="border-t border-brand-border bg-red-500/5 px-5 py-3 flex items-start gap-2">
                  <XCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-300 break-all">{(st as any).msg}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Legenda de idempotência */}
      <div className="text-[11px] text-brand-muted space-y-0.5 border-t border-brand-border pt-4">
        <p className="font-bold text-brand-text">Como funciona a idempotência</p>
        <p>Cada envio é registrado em <code className="bg-brand-surface-2 px-1 py-0.5 rounded text-brand-text">automation_sent</code> com (tipo, destinatário, data). Se você disparar duas vezes no mesmo dia, o segundo retorna <b>skipped</b> — nenhuma mensagem duplicada.</p>
        <p className="mt-1">Exceção: o Fechamento Mensal usa (tipo, professor:mês) — 1 aviso por mês por professor, independente da data.</p>
      </div>
    </div>
  );
};

// Converte o JSON de retorno em um resumo legível para cada automação
const ResultSummary: React.FC<{ data: Record<string, unknown>; id: string }> = ({ data, id }) => {
  if (id === 'daily') {
    const { birthdays = 0, agendas = 0, trials = 0, skipped = 0, failures } = data as any;
    const fl = Array.isArray(failures) ? failures : [];
    return (
      <div className="space-y-0.5">
        <p>🎂 Aniversários: <b>{birthdays}</b> &nbsp;·&nbsp; 📅 Agendas: <b>{agendas}</b> &nbsp;·&nbsp; 🔁 Follow-ups: <b>{trials}</b> &nbsp;·&nbsp; ⏭ Pulados: <b>{skipped}</b></p>
        {fl.length > 0 && <p className="text-amber-300">⚠️ {fl.length} falha(s): {fl.slice(0,3).join(' | ')}{fl.length>3 ? ` +${fl.length-3}` : ''}</p>}
      </div>
    );
  }
  if (id === 'weekly') {
    const { sent = 0, skipped = 0, failures } = data as any;
    const fl = Array.isArray(failures) ? failures : [];
    return (
      <div className="space-y-0.5">
        <p>📊 Enviados: <b>{sent}</b> &nbsp;·&nbsp; ⏭ Pulados: <b>{skipped}</b></p>
        {fl.length > 0 && <p className="text-amber-300">⚠️ {fl.length} falha(s): {fl.slice(0,3).join(' | ')}</p>}
      </div>
    );
  }
  if (id === 'monthly') {
    const { month = '', generated = 0, notified = 0, skipped = 0, failures } = data as any;
    const fl = Array.isArray(failures) ? failures : [];
    return (
      <div className="space-y-0.5">
        <p>📆 Mês: <b>{month}</b> &nbsp;·&nbsp; 📄 Fechamentos gerados: <b>{generated}</b> &nbsp;·&nbsp; 💬 Notificados: <b>{notified}</b> &nbsp;·&nbsp; ⏭ Pulados: <b>{skipped}</b></p>
        {fl.length > 0 && <p className="text-amber-300">⚠️ {fl.length} falha(s): {fl.slice(0,3).join(' | ')}</p>}
      </div>
    );
  }
  return <pre className="whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>;
};

export default AutomationPanel;
