import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { X, Loader2, DollarSign, CheckCircle, Clock, Wallet, Phone, Mail, History, BadgeCheck, XCircle } from 'lucide-react';

interface Props { vendorId: string; onClose: () => void; onChanged?: () => void; }

const C_LABEL: Record<string, { txt: string; cls: string }> = {
  PENDING: { txt: 'Pendente', cls: 'text-amber-600' },
  CONFIRMED: { txt: 'Confirmada', cls: 'text-indigo-600' },
  PAID: { txt: 'Paga', cls: 'text-emerald-600' },
  CANCELLED: { txt: 'Cancelada', cls: 'text-slate-400' },
};

const VendorProfileView: React.FC<Props> = ({ vendorId, onClose, onChanged }) => {
  const [loading, setLoading] = useState(true);
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_vendor_overview', { p_vendor_id: vendorId });
    setD(error ? { error: error.message } : data);
    setLoading(false);
  };
  useEffect(() => { load(); }, [vendorId]);

  const money = (v: any) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
  const fmt = (x?: string) => x ? new Date(x).toLocaleDateString('pt-BR') : '—';

  const setStatus = async (id: string, status: string) => {
    setBusy(id);
    const { error } = await supabase.rpc('set_vendor_commission_status', { p_commission_id: id, p_status: status });
    setBusy(null);
    if (error) { alert('Erro ao atualizar comissão.'); return; }
    load(); onChanged?.();
  };

  const p = d?.profile;
  const comms = d?.commissions || [];
  const totalConfirmed = comms.filter((c: any) => c.status === 'CONFIRMED').reduce((s: number, c: any) => s + Number(c.amount || 0), 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-brand-surface w-full max-w-2xl rounded-3xl border border-brand-border shadow-2xl my-6" onClick={e => e.stopPropagation()}>
        {loading ? <div className="p-16 flex justify-center"><Loader2 className="animate-spin text-brand-accent" size={32} /></div>
        : d?.error ? <div className="p-12 text-center text-brand-text font-bold">{d.error === 'sem_permissao' ? 'Sem acesso.' : 'Erro ao carregar.'}</div>
        : (
          <>
            <div className="p-6 border-b border-brand-border flex items-center gap-4">
              <img src={p.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(p.full_name || 'V')}`} className="w-14 h-14 rounded-2xl object-cover" alt="" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-bold text-brand-text truncate">{p.full_name}</h2>
                  <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${p.status === 'Ativo' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-700'}`}>{p.status || '—'}</span>
                </div>
                <p className="text-xs text-brand-muted mt-1 flex items-center gap-3 flex-wrap">
                  {p.email && <span className="flex items-center gap-1"><Mail size={11} />{p.email}</span>}
                  {p.phone && <span className="flex items-center gap-1"><Phone size={11} />{p.phone}</span>}
                  <span className="flex items-center gap-1"><DollarSign size={11} />{money((p.commission_rate || 0) / 100)}/matrícula</span>
                </p>
              </div>
              <button onClick={onClose} className="p-2 rounded-xl hover:bg-brand-surface-2 text-brand-muted"><X size={20} /></button>
            </div>

            <div className="p-6 space-y-5 max-h-[65vh] overflow-y-auto">
              <div className="grid grid-cols-3 gap-3">
                <Metric icon={<BadgeCheck size={16} className="text-emerald-500" />} label="Matrículas" value={`${comms.filter((c: any) => c.status !== 'CANCELLED').length}`} />
                <Metric icon={<Wallet size={16} className="text-indigo-500" />} label="A pagar" value={money(totalConfirmed)} />
                <Metric icon={<CheckCircle size={16} className="text-emerald-500" />} label="Pago" value={money(comms.filter((c: any) => c.status === 'PAID').reduce((s: number, c: any) => s + Number(c.amount || 0), 0))} />
              </div>

              {!p.pix_ok && <div className="flex items-center gap-2 text-xs text-red-500"><XCircle size={14} /> PIX não cadastrado — necessário para repasse.</div>}

              <div>
                <p className="text-xs font-bold text-brand-text mb-2">Comissões</p>
                {comms.length === 0 ? <div className="py-8 text-center text-brand-muted text-sm opacity-70">Nenhuma comissão ainda.</div> : (
                  <div className="space-y-2">
                    {comms.map((c: any) => {
                      const cl = C_LABEL[c.status] || { txt: c.status, cls: 'text-brand-muted' };
                      return (
                        <div key={c.id} className="border border-brand-border rounded-xl p-3 flex items-center justify-between gap-2 flex-wrap">
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-brand-text">{money(c.amount)} <span className="text-xs text-brand-muted font-normal">· {c.student || 'aluno'}</span></p>
                            <p className="text-[11px] text-brand-muted">{fmt(c.created_at)} · <span className={`font-bold ${cl.cls}`}>{cl.txt}</span></p>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            {c.status === 'PENDING' && <button onClick={() => setStatus(c.id, 'CONFIRMED')} disabled={busy === c.id} className="px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-bold disabled:opacity-50">Confirmar</button>}
                            {c.status === 'CONFIRMED' && <button onClick={() => setStatus(c.id, 'PAID')} disabled={busy === c.id} className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-xs font-bold disabled:opacity-50">Marcar paga</button>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {(d.audit || []).length > 0 && (
                <div>
                  <p className="text-xs font-bold text-brand-text mb-2 flex items-center gap-1"><History size={13} /> Histórico</p>
                  <div className="space-y-2">
                    {(d.audit || []).map((a: any, i: number) => (
                      <div key={i} className="border border-brand-border rounded-xl p-2.5 text-xs">
                        <p className="text-brand-text"><b>{a.field}</b>: <span className="text-red-500 line-through">{a.old_value || '∅'}</span> → <span className="text-emerald-600">{a.new_value || '∅'}</span></p>
                        <p className="text-brand-muted mt-0.5">{a.changed_by || 'sistema'} · {fmt(a.changed_at)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const Metric: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="bg-brand-surface-2/50 border border-brand-border rounded-2xl p-3">
    <div className="flex items-center gap-1 text-brand-muted text-[10px] font-bold uppercase mb-1">{icon}{label}</div>
    <p className="text-lg font-black text-brand-text">{value}</p>
  </div>
);

export default VendorProfileView;
