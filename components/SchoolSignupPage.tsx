import React, { useState } from 'react';
import { Building2, User, Mail, Phone, FileText, CheckCircle, Loader2, ArrowRight, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';

const SchoolSignupPage: React.FC = () => {
    const [form, setForm] = useState({
        school_name: '',
        owner_name: '',
        owner_email: '',
        owner_phone: '',
        owner_cpf_cnpj: '',
        estimated_students: '',
        estimated_teachers: '',
        notes: '',
    });
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.school_name || !form.owner_name || !form.owner_email) {
            setError('Preencha nome da escola, seu nome e email.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const { error: insertErr } = await supabase.from('saas_leads').insert({
                school_name: form.school_name,
                owner_name: form.owner_name,
                owner_email: form.owner_email,
                owner_phone: form.owner_phone.replace(/\D/g, ''),
                owner_cpf_cnpj: form.owner_cpf_cnpj.replace(/\D/g, ''),
                estimated_students: parseInt(form.estimated_students) || null,
                estimated_teachers: parseInt(form.estimated_teachers) || null,
                notes: form.notes,
                source: 'public_signup',
            });
            if (insertErr) throw insertErr;
            setSuccess(true);
        } catch (err: any) {
            setError(err.message || 'Erro ao enviar.');
        } finally {
            setLoading(false);
        }
    };

    if (success) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-pink-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl max-w-lg w-full p-10 text-center">
                    <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
                        <CheckCircle size={32} className="text-emerald-500" />
                    </div>
                    <h2 className="text-2xl font-black text-slate-800 dark:text-white mb-3">Inscrição recebida!</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                        Recebemos sua solicitação para criar a conta da <b>{form.school_name}</b>. Vamos entrar em contato em até 24 horas no e-mail <b>{form.owner_email}</b> com os próximos passos do seu trial de 14 dias.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-pink-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 flex items-center justify-center p-4">
            <form onSubmit={submit} className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl max-w-2xl w-full overflow-hidden">
                <div className="bg-gradient-to-br from-violet-600 to-indigo-700 p-8 text-white">
                    <Building2 size={32} className="mb-3" />
                    <h1 className="text-3xl font-black">Comece o trial gratuito</h1>
                    <p className="text-sm opacity-90 mt-2">14 dias grátis. Sem cartão. Para escolas de inglês transformarem sua operação.</p>
                </div>

                <div className="p-8 space-y-4">
                    {error && (
                        <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-200 rounded-xl p-3 flex items-start gap-2">
                            <AlertCircle size={16} className="text-rose-500 shrink-0 mt-0.5" />
                            <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>
                        </div>
                    )}

                    <Field icon={Building2} label="Nome da escola" value={form.school_name} onChange={v => setForm({ ...form, school_name: v })} required />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <Field icon={User} label="Seu nome" value={form.owner_name} onChange={v => setForm({ ...form, owner_name: v })} required />
                        <Field icon={Mail} label="E-mail corporativo" type="email" value={form.owner_email} onChange={v => setForm({ ...form, owner_email: v })} required />
                        <Field icon={Phone} label="WhatsApp" value={form.owner_phone} onChange={v => setForm({ ...form, owner_phone: v })} />
                        <Field icon={FileText} label="CNPJ (opcional)" value={form.owner_cpf_cnpj} onChange={v => setForm({ ...form, owner_cpf_cnpj: v })} />
                        <Field label="Alunos estimados" type="number" value={form.estimated_students} onChange={v => setForm({ ...form, estimated_students: v })} />
                        <Field label="Professores estimados" type="number" value={form.estimated_teachers} onChange={v => setForm({ ...form, estimated_teachers: v })} />
                    </div>

                    <div>
                        <label className="text-[10px] uppercase tracking-widest text-slate-400 font-bold block mb-1">Observações (opcional)</label>
                        <textarea
                            value={form.notes}
                            onChange={e => setForm({ ...form, notes: e.target.value })}
                            rows={3}
                            placeholder="O que você espera do sistema? Há algo específico que precisamos saber?"
                            className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-3 bg-violet-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {loading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                        Solicitar trial gratuito
                    </button>
                    <p className="text-[10px] text-center text-slate-400">
                        Ao enviar, você concorda com a análise de dados para fins de provisionamento.
                    </p>
                </div>
            </form>
        </div>
    );
};

const Field: React.FC<{ icon?: any; label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean }> = ({ icon: Icon, label, value, onChange, type = 'text', required }) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-400 font-bold block mb-1">{label}{required && ' *'}</label>
        <div className="relative">
            {Icon && <Icon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />}
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                required={required}
                className={`w-full ${Icon ? 'pl-9' : 'pl-3'} pr-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500`}
            />
        </div>
    </div>
);

export default SchoolSignupPage;
