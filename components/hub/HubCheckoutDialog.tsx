import React, { useState } from 'react';
import { ArrowLeft, Barcode, Check, CheckCircle2, Copy, Loader2, LockKeyhole, ShieldCheck, Smartphone, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { HubPlan } from './types';

interface HubCheckoutDialogProps {
  plan: HubPlan;
  accountName: string;
  email: string;
  onClose: () => void;
}

type CheckoutResult = {
  planName?: string;
  amount: number;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  pix?: { copyPaste?: string | null; qrCode?: string | null } | null;
};

const onlyDigits = (value: string) => value.replace(/\D/g, '');

const HubCheckoutDialog: React.FC<HubCheckoutDialogProps> = ({ plan, accountName, email, onClose }) => {
  const [name, setName] = useState(accountName);
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [phone, setPhone] = useState('');
  const [billingCycle, setBillingCycle] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [billingType, setBillingType] = useState<'PIX' | 'BOLETO'>('PIX');
  const [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const amount = Number(billingCycle === 'YEARLY' ? plan.price_yearly : plan.price_monthly) || 0;

  const review = (event: React.FormEvent) => {
    event.preventDefault();
    const documentDigits = onlyDigits(cpfCnpj);
    const phoneDigits = onlyDigits(phone);
    if (![11, 14].includes(documentDigits.length)) return setError('Confira o CPF ou CNPJ informado.');
    if (phoneDigits.length < 10 || phoneDigits.length > 13) return setError('Informe um telefone com DDD.');
    setError('');
    setReviewing(true);
  };

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('create-hub-checkout', {
        body: { planCode: plan.code, billingCycle, billingType, name, email, cpfCnpj, phone, requestKey },
      });
      if (invokeError) throw invokeError;
      if (data?.error) throw new Error(data.code || data.error);
      setResult(data as CheckoutResult);
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : '';
      if (code.includes('INVALID_CHECKOUT_DATA')) setError('Algum dado não passou pela validação segura. Revise documento e telefone.');
      else if (code.includes('CHECKOUT_IN_PROGRESS')) setError('Sua cobrança já está sendo preparada. Aguarde alguns segundos e tente novamente.');
      else setError('Não foi possível iniciar a cobrança. Nenhum valor foi debitado. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/80 backdrop-blur-md sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="hub-checkout-title">
      <div className="max-h-[96dvh] w-full max-w-xl overflow-y-auto rounded-t-[2rem] bg-white p-6 text-slate-950 shadow-2xl sm:rounded-[2rem] sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div><p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-violet-600"><LockKeyhole size={12} /> Checkout Wise Wolf · Asaas</p><h2 id="hub-checkout-title" className="mt-2 text-3xl font-black tracking-tight">{result ? 'Cobrança criada com segurança' : reviewing ? 'Revise antes de confirmar' : plan.name}</h2></div>
          <button onClick={onClose} className="grid size-10 place-items-center rounded-full bg-slate-100 text-slate-500" aria-label="Fechar"><X size={18} /></button>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-2">{['Dados', 'Revisão', 'Pagamento'].map((label, index) => { const active = result ? 2 : reviewing ? 1 : 0; return <div key={label}><div className={`h-1.5 rounded-full ${index <= active ? 'bg-violet-600' : 'bg-slate-100'}`} /><p className={`mt-2 text-[9px] font-black uppercase ${index <= active ? 'text-violet-700' : 'text-slate-400'}`}>{label}</p></div>; })}</div>

        {result ? (
          <div className="py-7 text-center">
            <div className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-100 text-emerald-700"><CheckCircle2 size={30} /></div>
            <h3 className="mt-5 text-2xl font-black">Falta apenas confirmar o pagamento</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">O plano será ativado automaticamente somente depois da confirmação do Asaas.</p>
            {result.pix?.qrCode && <img src={`data:image/png;base64,${result.pix.qrCode}`} alt="QR Code PIX" className="mx-auto mt-6 size-52 rounded-2xl border border-slate-200 p-2" />}
            {result.pix?.copyPaste && <button onClick={() => navigator.clipboard.writeText(result.pix?.copyPaste || '')} className="mt-4 inline-flex items-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white"><Copy size={16} /> Copiar PIX</button>}
            {(result.bankSlipUrl || result.invoiceUrl) && <a href={result.bankSlipUrl || result.invoiceUrl || '#'} target="_blank" rel="noreferrer" className="mt-4 inline-flex rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white">Abrir cobrança no Asaas</a>}
            <button onClick={onClose} className="mt-7 block w-full text-sm font-black text-violet-700">Voltar ao Hub</button>
          </div>
        ) : reviewing ? (
          <div className="mt-7">
            <div className="rounded-3xl border border-violet-200 bg-violet-50 p-5"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-black text-violet-700">{plan.name} · {billingCycle === 'MONTHLY' ? 'mensal' : 'anual'}</p><p className="mt-2 text-3xl font-black text-violet-950">R$ {amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p></div><div className="grid size-10 place-items-center rounded-full bg-white text-emerald-600"><Check size={19} /></div></div></div>
            <dl className="mt-5 divide-y divide-slate-100 rounded-3xl border border-slate-200 px-5"><div className="py-4"><dt className="text-[10px] font-black uppercase text-slate-400">Responsável</dt><dd className="mt-1 text-sm font-bold">{name}</dd></div><div className="py-4"><dt className="text-[10px] font-black uppercase text-slate-400">Conta</dt><dd className="mt-1 text-sm font-bold">{email}</dd></div><div className="py-4"><dt className="text-[10px] font-black uppercase text-slate-400">Pagamento</dt><dd className="mt-1 text-sm font-bold">{billingType === 'PIX' ? 'PIX' : 'Boleto bancário'} · recorrência {billingCycle === 'MONTHLY' ? 'mensal' : 'anual'}</dd></div></dl>
            {error && <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-700">{error}</p>}
            <button onClick={() => void submit()} disabled={loading} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 px-5 py-4 text-sm font-black text-white disabled:opacity-60">{loading ? <Loader2 className="animate-spin" size={18} /> : <ShieldCheck size={18} />}{loading ? 'Criando no Asaas...' : `Confirmar e gerar ${billingType === 'PIX' ? 'PIX' : 'boleto'}`}</button>
            <button onClick={() => { setReviewing(false); setError(''); }} disabled={loading} className="mt-3 flex w-full items-center justify-center gap-2 py-2 text-sm font-black text-slate-500"><ArrowLeft size={16} />Corrigir dados</button>
            <p className="mt-4 text-center text-[10px] leading-5 text-slate-400">Esta ação cria uma cobrança, mas não confirma pagamento nem debita automaticamente.</p>
          </div>
        ) : (
          <form onSubmit={review} className="mt-7 space-y-4">
            <div className="grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1.5">{(['MONTHLY', 'YEARLY'] as const).map((cycle) => <button key={cycle} type="button" onClick={() => setBillingCycle(cycle)} className={`rounded-xl px-3 py-3 text-xs font-black ${billingCycle === cycle ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}>{cycle === 'MONTHLY' ? 'Mensal' : 'Anual · 2 meses grátis'}</button>)}</div>
            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4"><p className="text-xs font-black text-violet-700">TOTAL DO CICLO</p><p className="mt-1 text-3xl font-black text-violet-950">R$ {amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p></div>
            <label className="block"><span className="mb-2 block text-xs font-black">Nome completo ou razão social</span><input value={name} onChange={(event) => setName(event.target.value)} required minLength={3} autoComplete="name" className="w-full rounded-2xl bg-slate-100 px-4 py-3.5 outline-none focus:ring-2 focus:ring-violet-500" /></label>
            <div className="grid gap-4 sm:grid-cols-2"><label><span className="mb-2 block text-xs font-black">CPF ou CNPJ</span><input value={cpfCnpj} onChange={(event) => setCpfCnpj(event.target.value)} required inputMode="numeric" autoComplete="off" className="w-full rounded-2xl bg-slate-100 px-4 py-3.5 outline-none focus:ring-2 focus:ring-violet-500" placeholder="Somente números" /></label><label><span className="mb-2 block text-xs font-black">Telefone com DDD</span><input value={phone} onChange={(event) => setPhone(event.target.value)} required inputMode="tel" autoComplete="tel" className="w-full rounded-2xl bg-slate-100 px-4 py-3.5 outline-none focus:ring-2 focus:ring-violet-500" placeholder="(11) 99999-9999" /></label></div>
            <div className="grid grid-cols-2 gap-3"><button type="button" onClick={() => setBillingType('PIX')} className={`rounded-2xl border p-4 text-left ${billingType === 'PIX' ? 'border-violet-500 bg-violet-50' : 'border-slate-200'}`}><Smartphone size={20} /><p className="mt-2 text-sm font-black">PIX</p><p className="mt-1 text-[10px] text-slate-500">Liberação após confirmação</p></button><button type="button" onClick={() => setBillingType('BOLETO')} className={`rounded-2xl border p-4 text-left ${billingType === 'BOLETO' ? 'border-violet-500 bg-violet-50' : 'border-slate-200'}`}><Barcode size={20} /><p className="mt-2 text-sm font-black">Boleto</p><p className="mt-1 text-[10px] text-slate-500">Compensação bancária</p></button></div>
            {error && <p className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-700">{error}</p>}
            <button className="flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 px-5 py-4 text-sm font-black text-white"><ShieldCheck size={18} />Revisar assinatura</button>
            <p className="text-center text-[10px] leading-5 text-slate-400">A Wise Wolf não armazena dados bancários. Cobrança e recorrência são processadas pelo Asaas.</p>
          </form>
        )}
      </div>
    </div>
  );
};

export default HubCheckoutDialog;
