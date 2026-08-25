import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { FileCheck, RefreshCw, Check, X, ExternalLink, Clock, BookOpen } from 'lucide-react';
import { User as UserType } from '../types';
import { openMaterialAccess } from '../services/materialAccessService';

interface Props { user: UserType; tenantId?: string; }

const MaterialApprovals: React.FC<Props> = () => {
  const [data, setData] = useState<any>({ items: [], pending_count: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const openMaterial = async (material: any) => {
    if (!material.file_url) return;
    setOpening(material.id);
    try {
      await openMaterialAccess(material.file_url);
    } catch {
      alert('Não foi possível abrir este material. Confirme seu acesso e tente novamente.');
    } finally {
      setOpening(null);
    }
  };

  const load = async () => {
    setLoading(true);
    const { data: d } = await supabase.rpc('list_material_approvals');
    setData(d?.error ? { items: [], pending_count: 0 } : d);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const review = async (id: string, approve: boolean) => {
    let reason: string | null = null;
    if (!approve) {
      reason = prompt('Motivo da reprovação (opcional):') || null;
    }
    setBusy(id);
    const { data: res, error } = await supabase.rpc('review_material', { p_id: id, p_approve: approve, p_reason: reason });
    if (error || res?.ok === false) {
      setBusy(null);
      alert('Erro ao revisar material.');
      return;
    }
    if (approve) alert('✅ Material aprovado para uso interno da escola.');
    setBusy(null);
    await load();
  };

  const fmt = (x?: string) => x ? new Date(x).toLocaleDateString('pt-BR') : '';
  const items = data.items || [];
  const pending = items.filter((m: any) => m.status === 'PENDING');
  const rejected = items.filter((m: any) => m.status === 'REJECTED');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-2xl bg-amber-50 dark:bg-amber-900/20 text-amber-600"><FileCheck size={24} /></div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">Aprovação de Materiais</h2>
          <p className="text-sm text-brand-muted">Materiais enviados pelos professores aguardando sua aprovação</p>
        </div>
        <button onClick={load} className="ml-auto p-2 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
      </div>

      {/* Pendentes */}
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <h3 className="text-sm font-bold text-brand-text mb-4 flex items-center gap-2">
          <Clock size={16} className="text-amber-600" /> Aguardando aprovação
          {pending.length > 0 && <span className="text-[10px] bg-amber-500 text-white px-2 py-0.5 rounded-full">{pending.length}</span>}
        </h3>
        {loading ? <div className="py-8 text-center text-brand-muted"><RefreshCw size={20} className="animate-spin mx-auto" /></div>
        : pending.length === 0 ? (
          <div className="py-10 flex flex-col items-center text-brand-muted opacity-70">
            <Check size={36} className="mb-2 text-emerald-500" />
            <p className="text-sm font-bold">Nada pendente 🎉</p>
          </div>
        ) : (
          <div className="space-y-2">
            {pending.map((m: any) => (
              <div key={m.id} className="border border-amber-200 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-900/10 rounded-xl p-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-brand-surface-2 flex items-center justify-center text-brand-muted shrink-0"><BookOpen size={16} /></div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-brand-text truncate">{m.title}</p>
                    <p className="text-[11px] text-brand-muted">
                      {m.type} {m.level_tag ? `· ${m.level_tag}` : ''} {m.niche && m.niche !== 'GENERAL' ? `· ${m.niche}` : ''} · por <b>{m.author || '—'}</b> · {fmt(m.created_at)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {m.file_url && <button type="button" onClick={() => void openMaterial(m)} disabled={opening === m.id} className="p-2 rounded-lg border border-brand-border text-brand-muted hover:text-brand-text disabled:opacity-50" title="Ver material"><ExternalLink size={14} /></button>}
                  <button onClick={() => review(m.id, false)} disabled={busy === m.id} className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 border border-red-200 text-xs font-bold flex items-center gap-1 disabled:opacity-50"><X size={13} /> Reprovar</button>
                  <button onClick={() => review(m.id, true)} disabled={busy === m.id} className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-xs font-bold flex items-center gap-1 disabled:opacity-50"><Check size={13} /> Aprovar</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reprovados recentes */}
      {rejected.length > 0 && (
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
          <h3 className="text-sm font-bold text-brand-text mb-3">Reprovados recentemente</h3>
          <div className="space-y-2">
            {rejected.map((m: any) => (
              <div key={m.id} className="border border-brand-border rounded-xl p-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-brand-text truncate">{m.title}</p>
                  <p className="text-[11px] text-brand-muted">por {m.author || '—'} · {fmt(m.created_at)}</p>
                </div>
                <button onClick={() => review(m.id, true)} disabled={busy === m.id} className="px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-200 text-xs font-bold disabled:opacity-50">Aprovar mesmo assim</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default MaterialApprovals;
