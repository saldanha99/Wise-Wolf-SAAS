import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { User, CreditCard, Save, Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { User as UserType } from '../types';

interface TeacherPixSettingsProps {
    user: UserType;
}

const PIX_TYPES = [
    { value: 'CPF', label: 'CPF' },
    { value: 'CNPJ', label: 'CNPJ' },
    { value: 'EMAIL', label: 'E-mail' },
    { value: 'PHONE', label: 'Telefone (Celular)' },
    { value: 'EVP', label: 'Chave Aleatória (EVP)' },
];

const TeacherPixSettings: React.FC<TeacherPixSettingsProps> = ({ user }) => {
    const [pixKey, setPixKey] = useState('');
    const [pixKeyType, setPixKeyType] = useState('CPF');
    const [cnpj, setCnpj] = useState('');
    const [companyName, setCompanyName] = useState('');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    useEffect(() => {
        fetchPixData();
    }, [user.id]);

    const fetchPixData = async () => {
        setLoading(true);
        try {
            // pix via RPC (coluna não é mais legível direto em profiles)
            const { data } = await supabase.rpc('get_my_pay');

            if (data) {
                setPixKey((data as any).pix_key || '');
                setPixKeyType((data as any).pix_key_type || 'CPF');
            }
            // dados fiscais (CNPJ) ficam fora do trio de pagamento — leitura direta
            const { data: fiscal } = await supabase
                .from('profiles')
                .select('cnpj, cnpj_company_name')
                .eq('id', user.id)
                .maybeSingle();
            if (fiscal) {
                setCnpj(fiscal.cnpj || '');
                setCompanyName(fiscal.cnpj_company_name || '');
            }
        } catch (err) {
            console.error('Error fetching Pix data:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setMessage(null);

        try {
            const { error } = await supabase
                .from('profiles')
                .update({
                    pix_key: pixKey,
                    pix_key_type: pixKeyType,
                    cnpj: cnpj || null,
                    cnpj_company_name: companyName || null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', user.id);

            if (error) throw error;
            setMessage({ type: 'success', text: 'Chave Pix salva com sucesso!' });
        } catch (err) {
            console.error('Error saving Pix data:', err);
            setMessage({ type: 'error', text: 'Erro ao salvar. Tente novamente.' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="bg-brand-surface rounded-[2rem] border border-brand-border shadow-sm p-8">
            <div className="flex items-center gap-3 mb-6">
                <div className="p-3 bg-teal-50 dark:bg-teal-900/20 rounded-xl">
                    <CreditCard className="text-teal-600 dark:text-teal-400" size={24} />
                </div>
                <div>
                    <h2 className="text-xl font-black text-brand-text tracking-tight">Dados de Recebimento (Pix)</h2>
                    <p className="text-sm text-brand-muted font-medium">Cadastre sua chave Pix para receber automaticamente.</p>
                </div>
            </div>

            {loading ? (
                <div className="flex justify-center py-8">
                    <Loader2 className="animate-spin text-slate-300" />
                </div>
            ) : (
                <form onSubmit={handleSave} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div>
                            <label className="block text-xs font-black uppercase tracking-widest text-brand-muted mb-2">Tipo de Chave</label>
                            <select
                                value={pixKeyType}
                                onChange={(e) => setPixKeyType(e.target.value)}
                                className="w-full px-4 py-3 bg-brand-surface-2 rounded-xl border border-brand-border text-sm font-bold text-brand-text dark:text-slate-200 outline-none focus:ring-2 focus:ring-teal-500/20"
                            >
                                {PIX_TYPES.map(t => (
                                    <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-xs font-black uppercase tracking-widest text-brand-muted mb-2">Chave Pix</label>
                            <input
                                type="text"
                                value={pixKey}
                                onChange={(e) => setPixKey(e.target.value)}
                                placeholder="Digite sua chave pix..."
                                className="w-full px-4 py-3 bg-brand-surface-2 rounded-xl border border-brand-border text-sm font-bold text-brand-text dark:text-slate-200 outline-none focus:ring-2 focus:ring-teal-500/20 placeholder:font-normal"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-black uppercase tracking-widest text-brand-muted mb-2">CNPJ (MEI)</label>
                            <input
                                type="text"
                                value={cnpj}
                                onChange={(e) => setCnpj(e.target.value)}
                                placeholder="00.000.000/0001-00"
                                className="w-full px-4 py-3 bg-brand-surface-2 rounded-xl border border-brand-border text-sm font-bold text-brand-text dark:text-slate-200 outline-none focus:ring-2 focus:ring-teal-500/20 placeholder:font-normal"
                            />
                            <p className="text-[10px] text-brand-muted mt-1">Usado para conferir suas notas fiscais (NFS-e) dos fechamentos.</p>
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-xs font-black uppercase tracking-widest text-brand-muted mb-2">Razão Social / Nome Empresarial</label>
                            <input
                                type="text"
                                value={companyName}
                                onChange={(e) => setCompanyName(e.target.value)}
                                placeholder="Como consta no seu CNPJ"
                                className="w-full px-4 py-3 bg-brand-surface-2 rounded-xl border border-brand-border text-sm font-bold text-brand-text dark:text-slate-200 outline-none focus:ring-2 focus:ring-teal-500/20 placeholder:font-normal"
                            />
                        </div>
                    </div>

                    {message && (
                        <div className={`p-4 rounded-xl flex items-center gap-3 text-sm font-bold ${message.type === 'success'
                                ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                                : 'bg-red-50 text-red-600 border border-red-100'
                            }`}>
                            {message.type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
                            {message.text}
                        </div>
                    )}

                    <div className="flex justify-end">
                        <button
                            type="submit"
                            disabled={saving}
                            className="flex items-center gap-2 px-8 py-3 bg-teal-500 hover:bg-teal-600 text-white rounded-xl text-xs font-black uppercase tracking-widest transition-all shadow-lg shadow-teal-500/20 disabled:opacity-50"
                        >
                            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                            {saving ? 'Salvando...' : 'Salvar Dados Pix'}
                        </button>
                    </div>
                </form>
            )}
        </div>
    );
};

export default TeacherPixSettings;
