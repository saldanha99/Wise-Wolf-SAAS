import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { supabase } from '../../lib/supabase';

// Aprovação comercial em lote do Hub (só SUPER_ADMIN). Lista o que o diretor já pediu
// (opt-in + direitos + prévia separada) e aprova, depois de confirmar, só esses itens.
// O banco grava quem clicou como verificador (hub_approve_commercial_publications).

export interface PendingHubApproval {
  material_id: string;
  title: string | null;
  level_tag: string | null;
  niche: string | null;
  tenant_id: string;
  tenant_name: string | null;
  requested_at: string | null;
  rights_basis: string | null;
}

export const SYNC_BATCH_SIZE = 5;
export const APPROVE_BATCH_SIZE = 200;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const RIGHTS_LABEL: Record<string, string> = {
  OWNED: 'Conteúdo próprio',
  LICENSED: 'Licença de distribuição',
  PUBLIC_DOMAIN: 'Domínio público',
};

interface Result {
  approved: number;
  skipped: number;
  syncFailedBatches: number;
}

export default function HubBulkApproval() {
  const [pending, setPending] = useState<PendingHubApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [runError, setRunError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    const { data, error } = await supabase.rpc('hub_pending_commercial_approvals');
    if (error) setLoadError('Não foi possível carregar a lista. Atualize a página e tente de novo.');
    else setPending((data || []) as PendingHubApproval[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const approveAll = async () => {
    const ids = pending.map(p => p.material_id);
    setRunning(true);
    setRunError('');
    setStep(`Aprovando ${ids.length}…`);
    // A RPC aceita até 200 ids por chamada.
    const approvedIds: string[] = [];
    let skipped = 0;
    for (const part of chunk(ids, APPROVE_BATCH_SIZE)) {
      const { data, error } = await supabase.rpc('hub_approve_commercial_publications', { p_material_ids: part });
      if (error || !data?.ok) {
        setRunning(false);
        setStep('');
        setRunError(approvedIds.length
          ? `${approvedIds.length} foram aprovados, mas o restante não foi salvo. Atualize a lista e aprove os que faltam.`
          : 'A aprovação não foi salva. Nada mudou; tente de novo.');
        await load();
        return;
      }
      if (Array.isArray(data.approved)) approvedIds.push(...data.approved);
      skipped += Number(data.skipped || 0);
    }
    let syncFailedBatches = 0;
    const batches = chunk(approvedIds, SYNC_BATCH_SIZE);
    for (let i = 0; i < batches.length; i += 1) {
      setStep(`Copiando para o Hub: ${Math.min((i + 1) * SYNC_BATCH_SIZE, approvedIds.length)} de ${approvedIds.length}…`);
      const { data: sync, error: syncError } = await supabase.functions.invoke('sync-hub-material', { body: { materialIds: batches[i] } });
      if (syncError || !sync?.ok) syncFailedBatches += 1;
    }
    setResult({ approved: approvedIds.length, skipped, syncFailedBatches });
    setRunning(false);
    setStep('');
    setConfirming(false);
    setReviewed(false);
    await load();
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="rounded-2xl border border-brand-border bg-brand-surface p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-brand-text">Publicações do Hub para aprovar</h2>
            <p className="mt-1 text-sm text-brand-muted">
              Só aparecem materiais que o diretor da escola pediu para publicar, com direitos declarados e prévia separada.
              A aprovação fica registrada em seu nome e o material é copiado para o catálogo do Hub.
            </p>
          </div>
          <button type="button" onClick={load} disabled={loading || running} className="rounded-lg p-2 text-brand-muted hover:text-brand-text disabled:opacity-50" aria-label="Atualizar lista">
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {result && (
          <div className="mt-4 space-y-2 rounded-xl bg-emerald-500/10 p-4 text-sm">
            <p className="flex items-center gap-2 font-black text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 size={18} /> {result.approved} {result.approved === 1 ? 'material aprovado' : 'materiais aprovados'}
            </p>
            {result.skipped > 0 && (
              <p className="text-xs font-bold text-brand-muted">
                {result.skipped} {result.skipped === 1 ? 'não estava mais pendente e ficou de fora' : 'não estavam mais pendentes e ficaram de fora'}.
              </p>
            )}
            {result.syncFailedBatches > 0 && (
              <p className="text-xs font-bold text-amber-700 dark:text-amber-300">
                A aprovação foi salva, mas a cópia para o Hub falhou em {result.syncFailedBatches} {result.syncFailedBatches === 1 ? 'grupo' : 'grupos'}. A equipe técnica conclui a cópia; não precisa aprovar de novo.
              </p>
            )}
          </div>
        )}

        {loadError && <p className="mt-4 text-sm font-bold text-red-600">{loadError}</p>}
        {runError && <p className="mt-4 text-sm font-bold text-red-600">{runError}</p>}

        {!loading && !loadError && pending.length === 0 && (
          <p className="mt-4 text-sm font-bold text-brand-muted">Nenhuma publicação esperando aprovação.</p>
        )}

        {pending.length > 0 && (
          <>
            <p className="mt-4 text-sm font-bold text-brand-text">
              {pending.length} {pending.length === 1 ? 'material pendente' : 'materiais pendentes'}
            </p>
            <ol className="mt-2 max-h-[50vh] list-decimal space-y-1 overflow-y-auto rounded-xl bg-brand-surface-2 p-3 pl-8 text-xs text-brand-text">
              {pending.map(p => (
                <li key={p.material_id}>
                  <span className="font-bold">{p.title || p.material_id}</span>
                  <span className="text-brand-muted">
                    {p.level_tag ? ` · ${p.level_tag}` : ''}
                    {p.tenant_name ? ` · ${p.tenant_name}` : ''}
                    {p.rights_basis ? ` · ${RIGHTS_LABEL[p.rights_basis] || p.rights_basis}` : ''}
                  </span>
                </li>
              ))}
            </ol>

            {!confirming ? (
              <button
                type="button"
                onClick={() => { setConfirming(true); setResult(null); }}
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-black text-white hover:bg-emerald-700"
              >
                <ShieldCheck size={16} /> Aprovar todos os pendentes ({pending.length})
              </button>
            ) : (
              <div className="mt-4 space-y-3 rounded-xl border border-emerald-300 p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" checked={reviewed} disabled={running} onChange={e => setReviewed(e.target.checked)} className="mt-1" />
                  <span className="text-sm font-bold text-brand-text">
                    Confirmo que revisei os direitos e as prévias destes {pending.length} materiais e aprovo a publicação no Hub.
                  </span>
                </label>
                {running ? (
                  <p className="flex items-center gap-2 text-sm font-bold text-brand-text">
                    <Loader2 size={16} className="animate-spin" /> {step} Não feche esta tela.
                  </p>
                ) : (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { setConfirming(false); setReviewed(false); }} className="flex-1 rounded-xl bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text">Cancelar</button>
                    <button
                      type="button"
                      disabled={!reviewed}
                      onClick={approveAll}
                      className="flex-1 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Aprovar {pending.length}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
