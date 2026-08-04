import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { APP_BASE_URL } from '../constants';
import { ArrowUpRight, Check, Copy, Loader2, TrendingUp, X, AlertTriangle } from 'lucide-react';

interface PricingPlan {
    id: string;
    classes_per_week: number;
    fidelity_months: number;
    monthly_price: number;
    name: string;
}

interface StudentPlanChangeModalProps {
    tenantId?: string;
    student: {
        id: string;
        full_name: string;
        class_frequency?: string | null;
        monthly_fee?: number | null;
        phone?: string | null;
    };
    onClose: () => void;
    onDone?: () => void;
}

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const freqNumber = (f?: string | null) => {
    const m = String(f || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
};

const StudentPlanChangeModal: React.FC<StudentPlanChangeModalProps> = ({ tenantId, student, onClose, onDone }) => {
    const [plans, setPlans] = useState<PricingPlan[]>([]);
    const [slotsAtuais, setSlotsAtuais] = useState<number | null>(null);
    const [fidelity, setFidelity] = useState<number | null>(null);
    const [freq, setFreq] = useState<number | null>(null);
    const [fee, setFee] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState('');
    const [link, setLink] = useState('');
    const [copied, setCopied] = useState(false);

    const freqAtual = freqNumber(student.class_frequency);
    const feeAtual = Number(student.monthly_fee || 0);

    useEffect(() => {
        (async () => {
            const [plansRes, bookingsRes] = await Promise.all([
                supabase
                    .from('student_pricing_plans')
                    .select('id, classes_per_week, fidelity_months, monthly_price, name')
                    .eq('tenant_id', tenantId)
                    .eq('active', true)
                    .order('fidelity_months')
                    .order('classes_per_week'),
                // Quantos horários o aluno realmente tem hoje. É a checagem que evita
                // vender 6x e deixar a agenda em 4x (ou o contrário) — foi assim que o
                // Victor ficou com 6 aulas na agenda e cobrança de 4.
                supabase
                    .from('bookings')
                    .select('id', { count: 'exact', head: true })
                    .eq('student_id', student.id)
                    .eq('status', 'SCHEDULED'),
            ]);
            setPlans((plansRes.data as PricingPlan[]) || []);
            setSlotsAtuais(bookingsRes.count ?? null);
            setLoading(false);
        })();
    }, [tenantId, student.id]);

    // Fidelidades disponíveis no catálogo da escola.
    const fidelidades = useMemo(
        () => plans
            .map(p => Number(p.fidelity_months))
            .filter((n, i, arr) => arr.indexOf(n) === i)
            .sort((a, b) => a - b),
        [plans],
    );

    useEffect(() => {
        if (fidelity === null && fidelidades.length > 0) {
            // O plano de maior compromisso costuma ser o praticado; o diretor troca se quiser.
            setFidelity(fidelidades[fidelidades.length - 1]);
        }
    }, [fidelidades, fidelity]);

    const planosDaFidelidade = useMemo(
        () => plans.filter(p => p.fidelity_months === fidelity).sort((a, b) => a.classes_per_week - b.classes_per_week),
        [plans, fidelity],
    );

    // Escolher a frequência sugere o preço do catálogo — mas o campo continua
    // editável: negociação pontual existe, e mentir o valor no contrato é pior.
    const escolherFreq = (n: number) => {
        setFreq(n);
        const plano = planosDaFidelidade.find(p => p.classes_per_week === n);
        if (plano) setFee(String(plano.monthly_price));
    };

    const feeNum = Number(String(fee).replace(',', '.'));
    const delta = feeNum && feeAtual ? feeNum - feeAtual : 0;
    const semPlanoNoCatalogo = freq !== null && !planosDaFidelidade.some(p => p.classes_per_week === freq);
    const agendaDivergente = freq !== null && slotsAtuais !== null && slotsAtuais !== freq;

    const gerar = async () => {
        setError('');
        if (!freq) return setError('Escolha a nova frequência.');
        if (!feeNum || feeNum <= 0) return setError('Informe o novo valor da mensalidade.');

        setGenerating(true);
        const { data, error: rpcError } = await supabase.rpc('create_student_plan_change', {
            p_student_id: student.id,
            p_to_frequency: `${freq}x`,
            p_to_fee: feeNum,
        });
        setGenerating(false);

        if (rpcError || !data?.ok) {
            setError(data?.error || rpcError?.message || 'Não foi possível gerar a proposta.');
            return;
        }
        setLink(`${APP_BASE_URL}/mudar-plano?token=${data.token}`);
        onDone?.();
    };

    const waLink = `https://wa.me/${String(student.phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(
        `Olá ${student.full_name.trim().split(' ')[0]}! Preparamos a alteração do seu plano para ${freq}x por semana (${brl(feeNum || 0)}/mês). ` +
        `Para confirmar, é só assinar por aqui: ${link}`,
    )}`;

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-brand-surface rounded-3xl w-full max-w-lg border border-brand-border shadow-2xl max-h-[90dvh] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="px-6 py-5 border-b border-brand-border flex justify-between items-center bg-brand-surface-2/50">
                    <div className="flex items-center gap-2">
                        <TrendingUp size={18} className="text-emerald-600" />
                        <h3 className="font-black text-brand-text text-base">Mudar plano</h3>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-brand-surface-2 rounded-full text-brand-muted"><X size={18} /></button>
                </div>

                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar">
                    <p className="text-xs text-brand-muted">
                        Aluno: <b className="text-brand-text">{student.full_name.trim()}</b>
                        {freqAtual ? <> · hoje <b>{freqAtual}x/semana</b> por <b>{brl(feeAtual)}</b></> : null}.
                        <br />
                        <span className="text-brand-text font-bold">A mensalidade só muda quando o aluno assinar.</span> A carência atual não é alterada.
                    </p>

                    {loading ? (
                        <div className="flex justify-center py-8"><Loader2 className="animate-spin text-brand-accent" size={24} /></div>
                    ) : link ? (
                        <div className="space-y-4">
                            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                                <p className="text-xs font-black uppercase tracking-widest text-emerald-600 mb-1">Proposta criada</p>
                                <p className="text-xs text-brand-muted">
                                    Envie o link. Enquanto o aluno não assinar, ele continua pagando {brl(feeAtual)}.
                                </p>
                            </div>
                            <div className="flex gap-2">
                                <input readOnly value={link} className="flex-1 px-3 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-[11px] text-brand-text" />
                                <button
                                    onClick={() => { navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                                    className="px-3 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-brand-muted hover:text-brand-text"
                                >
                                    {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                                </button>
                            </div>
                            <a href={waLink} target="_blank" rel="noopener noreferrer"
                                className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-500 text-white rounded-xl font-black text-[11px] uppercase tracking-widest hover:bg-emerald-600">
                                <ArrowUpRight size={14} /> Enviar no WhatsApp
                            </a>
                        </div>
                    ) : (
                        <>
                            <div>
                                <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted mb-2 block">Carência (mantida)</label>
                                <div className="flex gap-2 flex-wrap">
                                    {fidelidades.map(f => (
                                        <button key={f} onClick={() => { setFidelity(f); setFreq(null); setFee(''); }}
                                            className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all ${fidelity === f ? 'bg-brand-accent text-white border-transparent' : 'bg-brand-surface-2 border-brand-border text-brand-muted hover:text-brand-text'}`}>
                                            {f === 1 ? 'Mensal' : `${f} meses`}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted mb-2 block">Nova frequência</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {planosDaFidelidade.map(p => (
                                        <button key={p.id} onClick={() => escolherFreq(p.classes_per_week)}
                                            className={`px-2 py-3 rounded-xl border text-center transition-all ${freq === p.classes_per_week ? 'bg-emerald-500/10 border-emerald-500 ring-2 ring-emerald-500/30' : 'bg-brand-surface-2 border-brand-border hover:border-brand-accent'}`}>
                                            <p className="text-sm font-black text-brand-text">{p.classes_per_week}x</p>
                                            <p className="text-[10px] font-bold text-brand-muted">{brl(Number(p.monthly_price))}</p>
                                        </button>
                                    ))}
                                </div>
                                {planosDaFidelidade.length === 0 && (
                                    <p className="text-[11px] text-amber-500 font-medium mt-2">
                                        Nenhum plano cadastrado nesta carência. Cadastre em Configurações antes de propor.
                                    </p>
                                )}
                            </div>

                            <div>
                                <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted mb-2 block">Nova mensalidade (R$)</label>
                                <input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0,00"
                                    className="w-full px-4 py-3 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-emerald-500" />
                                {feeNum > 0 && feeAtual > 0 && (
                                    <p className={`text-[11px] font-bold mt-1.5 ${delta >= 0 ? 'text-emerald-600' : 'text-amber-500'}`}>
                                        {delta >= 0 ? '+' : ''}{brl(delta)} por mês em relação ao plano atual.
                                    </p>
                                )}
                                {semPlanoNoCatalogo && (
                                    <p className="text-[11px] text-amber-500 font-medium mt-1.5">
                                        Esta frequência não está no catálogo desta carência — o valor foi digitado à mão.
                                    </p>
                                )}
                            </div>

                            {agendaDivergente && (
                                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 flex gap-3">
                                    <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                                    <p className="text-[11px] text-brand-text font-medium">
                                        A agenda dele tem <b>{slotsAtuais} horário(s)</b> e o plano novo é de <b>{freq}</b>.
                                        Ajuste no <b>Mapa de Aulas</b> — senão a cobrança e as aulas ficam em pé diferente.
                                    </p>
                                </div>
                            )}

                            {error && <p className="text-xs text-red-500 font-bold">{error}</p>}

                            <button onClick={gerar} disabled={generating}
                                className="w-full py-4 bg-brand-accent text-white rounded-2xl font-black text-[11px] uppercase tracking-widest hover:bg-brand-accent-hover disabled:opacity-50 flex items-center justify-center gap-2">
                                {generating ? <Loader2 size={14} className="animate-spin" /> : <TrendingUp size={14} />}
                                Gerar link de assinatura
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default StudentPlanChangeModal;
