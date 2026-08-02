import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { MessageCircle, Send, RefreshCw, Check, AlertCircle } from 'lucide-react';

/**
 * Agendamento do relatório gerencial no WhatsApp.
 *
 * Nasce desligado. Enquanto o diretor não salvar destino e cadência, o cron roda
 * todo dia e não encontra alvo nenhum — automação que começa ligada manda
 * mensagem para o grupo errado no primeiro deploy.
 */

interface Settings {
  configurado: boolean;
  destino: string;
  cadencia: string;
  dia_semana: number;
  is_active: boolean;
  ultimo_envio_at?: string | null;
  error?: string;
}

const DIAS = [
  { v: 1, label: 'Segunda' }, { v: 2, label: 'Terça' }, { v: 3, label: 'Quarta' },
  { v: 4, label: 'Quinta' }, { v: 5, label: 'Sexta' }, { v: 6, label: 'Sábado' },
  { v: 7, label: 'Domingo' },
];

const DreReportSettings: React.FC = () => {
  const [s, setS] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.rpc('get_dre_report_settings');
    setS(data && !data.error ? (data as Settings) : null);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const salvar = async () => {
    if (!s) return;
    setSalvando(true); setAviso(null);
    const { data } = await supabase.rpc('save_dre_report_settings', {
      p_destino: s.destino,
      p_cadencia: s.cadencia,
      p_dia_semana: s.dia_semana,
      p_is_active: s.is_active,
    });
    setSalvando(false);
    if (data?.error) {
      const mapa: Record<string, string> = {
        destino_obrigatorio: 'Informe o grupo ou o telefone de destino.',
        destino_invalido: 'Use o ID do grupo (terminado em @g.us) ou um telefone com DDD.',
        cadencia_invalida: 'Cadência inválida.',
        dia_invalido: 'Dia da semana inválido.',
        sem_permissao: 'Só a direção pode configurar o relatório.',
      };
      setAviso({ tipo: 'erro', texto: mapa[data.error] || `Não foi possível salvar (${data.error}).` });
      return;
    }
    setAviso({ tipo: 'ok', texto: 'Agendamento salvo.' });
    await load();
  };

  const enviarAgora = async () => {
    if (!window.confirm('Enviar o relatório agora para o destino configurado?\n\nIsso manda uma mensagem real no WhatsApp.')) return;
    setEnviando(true); setAviso(null);
    const { data, error } = await supabase.functions.invoke('dre-report', { body: {} });
    setEnviando(false);
    if (error) {
      setAviso({ tipo: 'erro', texto: 'Não foi possível enviar agora.' });
      return;
    }
    if (data?.sent > 0) {
      setAviso({ tipo: 'ok', texto: 'Relatório enviado.' });
      await load();
    } else if (data?.failures?.length) {
      setAviso({ tipo: 'erro', texto: String(data.failures[0]) });
    } else {
      setAviso({ tipo: 'erro', texto: 'Nada enviado — já houve um envio manual hoje, ou o agendamento está desligado.' });
    }
  };

  if (loading) {
    return (
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <div className="py-6 text-center text-brand-muted"><RefreshCw size={18} className="animate-spin mx-auto" /></div>
      </div>
    );
  }
  if (!s) {
    return (
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <p className="text-sm text-brand-muted">Só a direção pode configurar o relatório automático.</p>
      </div>
    );
  }

  return (
    <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <MessageCircle size={16} className="text-emerald-500" />
        <h3 className="text-sm font-bold text-brand-text">Relatório automático no WhatsApp</h3>
        <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full border ${
          s.is_active
            ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
            : 'bg-brand-surface-2 text-brand-muted border-brand-border'
        }`}>
          {s.is_active ? 'ativo' : 'desligado'}
        </span>
      </div>
      <p className="text-[11px] text-brand-muted mb-4">
        Manda o resultado do mês no grupo da direção, com os alertas. Mensal fecha o mês anterior;
        diário e semanal mostram o mês corrente até aqui.
      </p>

      {aviso && (
        <div className={`mb-3 flex items-start gap-2 text-xs font-bold rounded-xl px-3 py-2 border ${
          aviso.tipo === 'ok'
            ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
            : 'text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-500/30'
        }`}>
          {aviso.tipo === 'ok' ? <Check size={14} className="shrink-0 mt-0.5" /> : <AlertCircle size={14} className="shrink-0 mt-0.5" />}
          <span>{aviso.texto}</span>
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Grupo ou telefone</label>
          <input
            value={s.destino}
            onChange={e => setS({ ...s, destino: e.target.value })}
            placeholder="1203630...@g.us  ou  12996...."
            className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
          />
          <span className="text-[10px] text-brand-muted">ID do grupo termina em @g.us</span>
        </div>
        <div>
          <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Cadência</label>
          <select
            value={s.cadencia}
            onChange={e => setS({ ...s, cadencia: e.target.value })}
            className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
          >
            <option value="diaria">Diária</option>
            <option value="semanal">Semanal</option>
            <option value="mensal">Mensal (dia 1º)</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Dia da semana</label>
          <select
            value={s.dia_semana}
            onChange={e => setS({ ...s, dia_semana: Number(e.target.value) })}
            disabled={s.cadencia !== 'semanal'}
            className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border disabled:opacity-40"
          >
            {DIAS.map(d => <option key={d.v} value={d.v}>{d.label}</option>)}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-4 flex-wrap">
        <button
          onClick={() => void salvar()}
          disabled={salvando}
          className="text-xs font-bold px-4 py-2 rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {salvando ? 'Salvando…' : 'Salvar agendamento'}
        </button>
        <label className="flex items-center gap-2 text-xs text-brand-muted">
          <input
            type="checkbox"
            checked={s.is_active}
            onChange={e => setS({ ...s, is_active: e.target.checked })}
          />
          Enviar automaticamente
        </label>
        {s.configurado && (
          <button
            onClick={() => void enviarAgora()}
            disabled={enviando}
            className="ml-auto flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl border border-brand-border text-brand-text hover:bg-brand-surface-2 disabled:opacity-50"
          >
            <Send size={14} className={enviando ? 'animate-pulse' : ''} />
            {enviando ? 'Enviando…' : 'Enviar agora'}
          </button>
        )}
      </div>

      {s.ultimo_envio_at && (
        <p className="text-[10px] text-brand-muted mt-3">
          Último envio: {new Date(s.ultimo_envio_at).toLocaleString('pt-BR')}
        </p>
      )}
    </div>
  );
};

export default DreReportSettings;
