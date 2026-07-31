import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Loader2, Play, Save, Bot, Sparkles, MessageCircle } from 'lucide-react';

// Painel da EQUIPE DE IA da escola (4 agentes — migrado do padrão MotoFix).
// Vê os relatórios (botão "Rodar agora"), edita o "centro de treinamento" de cada
// agente e define telefone do diretor + cadência. Config salva via RPC set_ai_team_config;
// relatórios e envio rodam na edge function school-ai-team.

type Role = 'atendente' | 'estagiario' | 'financeiro' | 'rh' | 'secretaria';
interface AgentCfg { name: string; enabled: boolean; training: string }
interface TeamConfig { ownerWhatsapp: string; schedule: 'daily' | 'weekly' | 'off'; agents: Record<Role, AgentCfg>; }
interface Report { role: Role; name: string; emoji: string; markdown: string; highlights: string[] }

const ROLE_LABEL: Record<Role, string> = {
  secretaria: 'Secretária (gestora)',
  atendente: 'Atendente (comercial + SDR)',
  estagiario: 'Coordenação Pedagógica',
  financeiro: 'Financeiro',
  rh: 'RH / Recrutamento (Michelle)',
};
const ROLE_ORDER: Role[] = ['secretaria', 'atendente', 'estagiario', 'financeiro', 'rh'];

// Mini-render de markdown (negrito, títulos ###, bullets) — sem dependência extra.
const Markdown: React.FC<{ md: string }> = ({ md }) => {
  const html = (md || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^###\s?(.*)$/gm, '<p class="font-black text-sm mt-3 mb-1">$1</p>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^[-•]\s?(.*)$/gm, '<div class="flex gap-2"><span>•</span><span>$1</span></div>')
    .replace(/\n{2,}/g, '<br/>');
  return <div className="text-sm text-brand-text leading-relaxed space-y-0.5" dangerouslySetInnerHTML={{ __html: html }} />;
};

interface Props { tenantId?: string }

const AiTeamPanel: React.FC<Props> = ({ tenantId }) => {
  const [cfg, setCfg] = useState<TeamConfig | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const run = async (useAi = true) => {
    setRunning(true); setErr('');
    try {
      const { data, error } = await supabase.functions.invoke('school-ai-team', { body: { mode: 'preview', useAi } });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      if (data?.config) setCfg(data.config);
      setReports(data?.reports || []);
      setGeneratedAt(data?.generatedAt || new Date().toISOString());
    } catch (e: any) { setErr(e.message || 'Falha ao rodar a equipe.'); }
    finally { setRunning(false); setLoading(false); }
  };

  useEffect(() => { run(true); /* primeira carga */ }, []);

  const save = async () => {
    if (!cfg) return;
    setSaving(true); setErr('');
    try {
      const { data, error } = await supabase.rpc('set_ai_team_config', { p_config: cfg });
      if (error) throw new Error(error.message);
      if (data && data.ok === false) throw new Error(data.error || 'Sem permissão para salvar.');
    } catch (e: any) { setErr(e.message || 'Falha ao salvar.'); }
    finally { setSaving(false); }
  };

  const setAgent = (role: Role, patch: Partial<AgentCfg>) => {
    if (!cfg) return;
    setCfg({ ...cfg, agents: { ...cfg.agents, [role]: { ...cfg.agents[role], ...patch } } });
  };

  if (loading) return <div className="p-12 flex items-center justify-center"><Loader2 className="animate-spin text-tenant-primary" size={24} /></div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-tenant-primary/10 rounded-xl flex items-center justify-center"><Bot size={20} className="text-tenant-primary" /></div>
          <div>
            <h2 className="text-2xl font-black text-brand-text">Equipe de IA</h2>
            <p className="text-brand-muted text-sm">5 funcionários virtuais que monitoram a escola e te avisam todo dia no WhatsApp — a atendente e a Michelle também conversam com leads e candidatos 24/7.</p>
          </div>
        </div>
        <button onClick={() => run(true)} disabled={running}
          className="flex items-center gap-2 px-4 py-2.5 bg-tenant-primary text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110 disabled:opacity-50">
          {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Rodar agora
        </button>
      </div>

      {err && <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm font-bold border border-red-200">{err}</div>}

      {/* Config geral */}
      {cfg && (
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-5 space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted block mb-1">Cadência do briefing</label>
              <select value={cfg.schedule} onChange={e => setCfg({ ...cfg, schedule: e.target.value as any })}
                className="w-full p-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none">
                <option value="daily">Diário (manhã)</option>
                <option value="weekly">Semanal</option>
                <option value="off">Só sob demanda</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted block mb-1 flex items-center gap-1"><MessageCircle size={11} /> WhatsApp do diretor (opcional)</label>
              <input value={cfg.ownerWhatsapp} onChange={e => setCfg({ ...cfg, ownerWhatsapp: e.target.value })}
                placeholder="Vazio = usa o WhatsApp do admin da escola"
                className="w-full p-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none" />
            </div>
          </div>
        </div>
      )}

      {/* Centro de treinamento dos agentes */}
      {cfg && (
        <div className="space-y-3">
          <div className="flex items-center gap-2"><Sparkles size={15} className="text-tenant-primary" /><h3 className="text-sm font-black uppercase tracking-widest text-brand-text">Centro de treinamento</h3></div>
          <div className="grid md:grid-cols-2 gap-3">
            {ROLE_ORDER.map(role => (
              <div key={role} className="bg-brand-surface border border-brand-border rounded-2xl p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <input value={cfg.agents[role].name} onChange={e => setAgent(role, { name: e.target.value })}
                    className="font-black text-brand-text bg-transparent outline-none border-b border-transparent focus:border-brand-border w-32" />
                  <label className="flex items-center gap-1.5 text-[10px] font-bold text-brand-muted">
                    <input type="checkbox" checked={cfg.agents[role].enabled} onChange={e => setAgent(role, { enabled: e.target.checked })} className="accent-tenant-primary w-4 h-4" />
                    Ativo
                  </label>
                </div>
                <p className="text-[10px] uppercase tracking-widest text-brand-muted font-bold">{ROLE_LABEL[role]}</p>
                <textarea value={cfg.agents[role].training} onChange={e => setAgent(role, { training: e.target.value })} rows={4}
                  className="w-full p-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-xs text-brand-text outline-none resize-none"
                  placeholder="O que este funcionário deve vigiar / como deve escrever..." />
              </div>
            ))}
          </div>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-4 py-2.5 bg-brand-text text-brand-surface rounded-xl text-xs font-black uppercase tracking-widest hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Salvar treinamento
          </button>
        </div>
      )}

      {/* Relatórios */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-black uppercase tracking-widest text-brand-text">Relatórios de hoje</h3>
          {generatedAt && <span className="text-[10px] text-brand-muted">gerado {new Date(generatedAt).toLocaleString('pt-BR')}</span>}
        </div>
        {running && <div className="p-6 flex items-center gap-2 text-brand-muted text-sm"><Loader2 className="animate-spin" size={16} /> Os funcionários estão analisando a escola…</div>}
        {!running && reports.map(r => (
          <div key={r.role} className="bg-brand-surface border border-brand-border rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">{r.emoji}</span>
              <h4 className="font-black text-brand-text">{r.name}</h4>
              <span className="text-[10px] uppercase tracking-widest text-brand-muted font-bold">{ROLE_LABEL[r.role]}</span>
              <div className="flex flex-wrap gap-1 ml-auto">
                {(r.highlights || []).slice(0, 4).map((h, i) => (
                  <span key={i} className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">{h}</span>
                ))}
              </div>
            </div>
            <Markdown md={r.markdown} />
          </div>
        ))}
      </div>
    </div>
  );
};

export default AiTeamPanel;
