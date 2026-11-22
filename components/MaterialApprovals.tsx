import React, { useEffect, useRef, useState } from 'react';
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
  // Aviso curto no lugar do alert(): no iPhone o alert() trava a tela até ser fechado.
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  // Reprovação pede o motivo num modal (antes era prompt()).
  const [rejecting, setRejecting] = useState<{ id: string; title: string } | null>(null);
  const [reason, setReason] = useState('');

  const showToast = (kind: 'ok' | 'error', text: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  };
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  const openMaterial = async (material: any) => {
    if (!material.file_url) return;
    setOpening(material.id);
    try {
      await openMaterialAccess(material.file_url);
    } catch {
      showToast('error', 'Não foi possível abrir este material. Confirme seu acesso e tente novamente.');
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

  const review = async (id: string, approve: boolean, rejectReason: string | null = null) => {
    setBusy(id);
    const { data: res, error } = await supabase.rpc('review_material', { p_id: id, p_approve: approve, p_reason: rejectReason });
    setBusy(null);
    if (error || res?.ok === false) {
      showToast('error', 'Não foi possível revisar o material. Tente de novo.');
      return;
    }
    showToast('ok', approve ? 'Material aprovado para uso interno da escola.' : 'Material reprovado.');
    await load();
  };

  const confirmReject = async () => {
    if (!rejecting) return;
    const target = rejecting;
    setRejecting(null);
    await review(target.id, false, reason.trim() || null);
    setReason('');
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
        <button onClick={load} aria-label="Atualizar lista" className="ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-brand-border text-brand-muted hover:text-brand-text sm:h-auto sm:w-auto sm:p-2"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
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
                <div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0">
                  {m.file_url && <button type="button" onClick={() => void openMaterial(m)} disabled={opening === m.id} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-brand-border text-brand-muted hover:text-brand-text disabled:opacity-50 sm:h-auto sm:w-auto sm:p-2" title="Ver material" aria-label={`Ver ${m.title}`}><ExternalLink size={14} /></button>}
                  <button type="button" onClick={() => { setReason(''); setRejecting({ id: m.id, title: m.title }); }} disabled={busy === m.id} className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 disabled:opacity-50 sm:min-h-0 sm:flex-none"><X size={13} /> Reprovar</button>
                  <button type="button" onClick={() => review(m.id, true)} disabled={busy === m.id} className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 sm:min-h-0 sm:flex-none"><Check size={13} /> Aprovar</button>
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
                <button type="button" onClick={() => review(m.id, true)} disabled={busy === m.id} className="min-h-11 shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-600 disabled:opacity-50 sm:min-h-0">Aprovar mesmo assim</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {rejecting && (
        <div className="fixed inset-0 z-[95] flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={() => setRejecting(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reject-material-title"
            className="flex h-full w-full flex-col bg-brand-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:h-auto sm:max-w-md sm:rounded-2xl sm:border sm:border-brand-border"
            onClick={e => e.stopPropagation()}
          >
            <h3 id="reject-material-title" className="text-lg font-bold text-brand-text">Reprovar material</h3>
            <p className="mt-1 break-words text-sm text-brand-muted">{rejecting.title}</p>
            <label htmlFor="reject-material-reason" className="mt-4 text-sm font-bold text-brand-text">Motivo (opcional)</label>
            <textarea
              id="reject-material-reason"
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={4}
              maxLength={500}
              autoFocus
              className="mt-2 w-full rounded-xl border border-brand-border bg-brand-surface-2/70 p-3 text-base text-brand-text outline-hidden focus:ring-2 focus:ring-tenant-primary sm:text-sm"
              placeholder="Ex.: arquivo incompleto, conteúdo fora do nível…"
            />
            <div className="mt-auto flex gap-2 pt-4 sm:mt-4">
              <button type="button" onClick={() => setRejecting(null)} className="min-h-11 flex-1 rounded-xl border border-brand-border px-4 text-sm font-bold text-brand-text">Cancelar</button>
              <button type="button" onClick={() => void confirmReject()} className="min-h-11 flex-1 rounded-xl bg-red-600 px-4 text-sm font-bold text-white">Reprovar</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className={`fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[96] rounded-xl px-4 py-3 text-sm font-bold text-white shadow-lg sm:inset-x-auto sm:right-6 sm:bottom-6 sm:max-w-sm ${toast.kind === 'error' ? 'bg-red-600' : 'bg-emerald-600'}`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
};

export default MaterialApprovals;
