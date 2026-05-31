import React, { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { Users, DollarSign, Wallet, BadgeCheck, RefreshCw, Eye, UserPlus, Check, Power, AlertTriangle } from 'lucide-react';
import { User as UserType } from '../types';
import VendorProfileView from './VendorProfileView';
import VendorInviteGenerator from './VendorInviteGenerator';

interface Props { user: UserType; tenantId?: string; }

const VendorManagement: React.FC<Props> = ({ tenantId }) => {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewId, setViewId] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.rpc('list_vendors_overview');
    setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const money = (v: any) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
  const stats = useMemo(() => ({
    total: rows.length,
    active: rows.filter(r => r.status === 'Ativo').length,
    toPay: rows.reduce((s, r) => s + Number(r.confirmed_unpaid || 0), 0),
    revenue: rows.reduce((s, r) => s + Number(r.revenue_brought || 0), 0),
  }), [rows]);

  const saveCommission = async (id: string) => {
    const cents = Math.round(parseFloat(editVal || '0') * 100);
    if (!cents || cents <= 0) { setEditId(null); return; }
    await supabase.from('profiles').update({ commission_rate: cents }).eq('id', id);
    setEditId(null); load();
  };
  const toggleStatus = async (id: string, cur: string) => {
    await supabase.from('profiles').update({ status: cur === 'Ativo' ? 'Inativo' : 'Ativo' }).eq('id', id);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600"><Users size={24} /></div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">Vendedores</h2>
          <p className="text-sm text-brand-muted">Equipe de vendas, desempenho e comissões</p>
        </div>
        <button onClick={() => setShowInvite(s => !s)} className="ml-auto flex items-center gap-2 px-4 py-2 rounded-xl bg-tenant-primary text-white text-xs font-bold">
          <UserPlus size={15} /> Convidar vendedor
        </button>
        <button onClick={load} className="p-2 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
      </div>

      {showInvite && <div className="animate-in fade-in"><VendorInviteGenerator tenantId={tenantId || ''} /></div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={<Users size={16} />} label="Vendedores" value={`${stats.active}/${stats.total}`} />
        <Kpi icon={<Wallet size={16} className="text-indigo-500" />} label="A pagar" value={money(stats.toPay)} accent="text-indigo-600" />
        <Kpi icon={<DollarSign size={16} className="text-emerald-500" />} label="Receita trazida" value={money(stats.revenue)} />
        <Kpi icon={<BadgeCheck size={16} />} label="Matrículas (total)" value={`${rows.reduce((s, r) => s + (r.matriculas || 0), 0)}`} />
      </div>

      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <h3 className="text-sm font-bold text-brand-text mb-4">Equipe</h3>
        {loading ? <div className="py-10 text-center text-brand-muted"><RefreshCw size={20} className="animate-spin mx-auto" /></div>
        : rows.length === 0 ? (
          <div className="py-10 text-center text-brand-muted">
            <p className="text-sm font-bold mb-1">Nenhum vendedor ainda.</p>
            <p className="text-xs">Clique em "Convidar vendedor" para gerar o link de cadastro com a comissão definida.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map(v => (
              <div key={v.vendor_id} className="border border-brand-border rounded-xl p-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <img src={v.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(v.full_name || 'V')}`} className="w-8 h-8 rounded-lg object-cover" alt="" />
                    <span className="text-sm font-bold text-brand-text truncate">{v.full_name}</span>
                    <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${v.status === 'Ativo' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-700'}`}>{v.status || '—'}</span>
                    {v.alert_level !== 'LOW' && <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${v.alert_level === 'HIGH' ? 'bg-red-500 text-white' : 'bg-amber-400 text-amber-900'}`}><AlertTriangle size={9} className="inline" /></span>}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-brand-muted shrink-0">
                    <span title="Matrículas"><BadgeCheck size={12} className="inline" /> {v.matriculas}</span>
                    <span className="text-emerald-600 font-bold" title="Receita trazida">{money(v.revenue_brought)}</span>
                    {Number(v.confirmed_unpaid) > 0 && <span className="text-indigo-600 font-bold" title="A pagar">a pagar {money(v.confirmed_unpaid)}</span>}
                    {/* Comissão editável */}
                    {editId === v.vendor_id ? (
                      <span className="flex items-center gap-1">
                        <input value={editVal} onChange={e => setEditVal(e.target.value)} className="w-16 px-2 py-1 rounded border border-brand-border bg-brand-surface text-brand-text" placeholder="R$" />
                        <button onClick={() => saveCommission(v.vendor_id)} className="p-1 bg-emerald-500 text-white rounded"><Check size={14} /></button>
                      </span>
                    ) : (
                      <button onClick={() => { setEditId(v.vendor_id); setEditVal(((v.commission_rate || 0) / 100).toFixed(2)); }} className="underline hover:text-brand-text" title="Editar comissão">
                        {money((v.commission_rate || 0) / 100)}/matríc.
                      </button>
                    )}
                    <button onClick={() => toggleStatus(v.vendor_id, v.status)} className="p-1.5 rounded-lg border border-brand-border hover:bg-brand-surface-2" title={v.status === 'Ativo' ? 'Desativar' : 'Ativar'}><Power size={13} /></button>
                    <button onClick={() => setViewId(v.vendor_id)} className="p-1.5 rounded-lg text-brand-accent hover:bg-brand-accent/10" title="Ver ficha"><Eye size={14} /></button>
                  </div>
                </div>
                {(v.alert_reasons || []).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(v.alert_reasons || []).map((r: string, i: number) => <span key={i} className="text-[10px] bg-red-50 dark:bg-red-900/20 text-red-600 px-2 py-0.5 rounded">{r}</span>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {viewId && <VendorProfileView vendorId={viewId} onClose={() => setViewId(null)} onChanged={load} />}
    </div>
  );
};

const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; accent?: string }> = ({ icon, label, value, accent }) => (
  <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
    <div className="flex items-center gap-2 text-brand-muted text-[10px] font-bold uppercase mb-1">{icon}{label}</div>
    <p className={`text-xl font-black ${accent || 'text-brand-text'}`}>{value}</p>
  </div>
);

export default VendorManagement;
