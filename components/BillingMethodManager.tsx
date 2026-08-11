import React, { useEffect, useState } from 'react';
import { Barcode, CheckCircle2, CreditCard, Loader2, QrCode, ShieldCheck } from 'lucide-react';
import { asaasService } from '../services/asaasService';

type BillingType = 'PIX' | 'BOLETO' | 'CREDIT_CARD';

interface BillingMethodManagerProps {
  studentId: string;
  selfService?: boolean;
  onChanged?: (billingType: BillingType) => void;
}

const label: Record<BillingType, string> = {
  PIX: 'Pix',
  BOLETO: 'Boleto',
  CREDIT_CARD: 'Cartão de crédito',
};

const BillingMethodManager: React.FC<BillingMethodManagerProps> = ({
  studentId,
  selfService = false,
  onChanged,
}) => {
  const [current, setCurrent] = useState<BillingType | null>(null);
  const [selected, setSelected] = useState<BillingType>('PIX');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [card, setCard] = useState({
    holderName: '',
    number: '',
    expiryMonth: '',
    expiryYear: '',
    ccv: '',
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFeedback(null);
    void asaasService.getStudentBillingMethod(studentId)
      .then((result) => {
        if (!active) return;
        setCurrent(result.billingType);
        setSelected(result.billingType);
      })
      .catch((error: Error) => {
        if (active) setFeedback({ tone: 'error', text: error.message });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [studentId]);

  const changeCard = (field: keyof typeof card, value: string) => {
    const sanitized = field === 'holderName'
      ? value
      : value.replace(/\D/g, '').slice(0, field === 'number' ? 19 : field === 'expiryYear' ? 4 : field === 'ccv' ? 4 : 2);
    setCard((previous) => ({ ...previous, [field]: sanitized }));
  };

  const submit = async () => {
    if (selected === current && selected !== 'CREDIT_CARD') return;
    const message = selected === 'CREDIT_CARD'
      ? 'Confirma a troca para cartão? O cartão será validado, mas não será cobrado agora.'
      : `Confirma a troca para ${label[selected]}? As cobranças pendentes também serão atualizadas.`;
    if (!window.confirm(message)) return;

    setSaving(true);
    setFeedback(null);
    try {
      const result = await asaasService.updateStudentBillingMethod({
        user_id: studentId,
        billingType: selected,
        ...(selected === 'CREDIT_CARD' ? { creditCard: card } : {}),
      });
      setCurrent(result.billingType);
      setSelected(result.billingType);
      setCard({ holderName: '', number: '', expiryMonth: '', expiryYear: '', ccv: '' });
      setFeedback({
        tone: 'success',
        text: result.billingType === 'CREDIT_CARD'
          ? 'Cartão validado e forma de pagamento atualizada. Nenhuma cobrança foi feita agora.'
          : `Forma de pagamento atualizada para ${label[result.billingType]}.`,
      });
      onChanged?.(result.billingType);
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível concluir a alteração.' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface-2 p-4 text-xs font-bold text-brand-muted">
        <Loader2 className="animate-spin" size={16} /> Consultando a forma de pagamento no Asaas...
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-brand-border bg-brand-surface-2/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-black text-brand-text">Forma de pagamento</h4>
          <p className="mt-1 text-xs font-medium text-brand-muted">
            {current ? <>Atual no Asaas: <b>{label[current]}</b></> : 'Não foi possível identificar a forma atual.'}
          </p>
        </div>
        {current && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
            <CheckCircle2 size={13} /> Sincronizado
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {([
          ['PIX', 'Pix', QrCode],
          ['BOLETO', 'Boleto', Barcode],
          ['CREDIT_CARD', 'Cartão', CreditCard],
        ] as const).map(([value, text, Icon]) => (
          <button
            key={value}
            type="button"
            onClick={() => { setSelected(value); setFeedback(null); }}
            className={`flex items-center gap-2 rounded-xl border px-3 py-3 text-left text-xs font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tenant-primary ${selected === value ? 'border-tenant-primary bg-tenant-primary/10 text-tenant-primary dark:border-indigo-300 dark:bg-indigo-500/25 dark:text-white' : 'border-brand-border bg-brand-surface text-brand-muted hover:border-tenant-primary/50 dark:text-slate-200 dark:hover:border-indigo-300 dark:hover:text-white'}`}
          >
            <Icon size={17} /> {text}
          </button>
        ))}
      </div>

      {selected === 'CREDIT_CARD' && (
        <div className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900/50 dark:bg-blue-950/20">
          <div className="flex items-start gap-2 text-xs font-medium text-blue-800 dark:text-blue-300">
            <ShieldCheck className="mt-0.5 shrink-0" size={16} />
            <p>Os dados seguem direto para o Asaas, não ficam salvos no sistema e a troca não faz cobrança imediata.</p>
          </div>
          <input
            value={card.holderName}
            onChange={(event) => changeCard('holderName', event.target.value)}
            autoComplete="cc-name"
            placeholder="Nome impresso no cartão"
            className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-tenant-primary dark:border-blue-900 dark:bg-slate-950 dark:text-white"
          />
          <input
            value={card.number}
            onChange={(event) => changeCard('number', event.target.value)}
            autoComplete="cc-number"
            inputMode="numeric"
            placeholder="Número do cartão"
            className="w-full rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-tenant-primary dark:border-blue-900 dark:bg-slate-950 dark:text-white"
          />
          <div className="grid grid-cols-3 gap-2">
            <input value={card.expiryMonth} onChange={(event) => changeCard('expiryMonth', event.target.value)} autoComplete="cc-exp-month" inputMode="numeric" placeholder="MM" className="rounded-xl border border-blue-200 bg-white px-3 py-3 text-center text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-tenant-primary dark:border-blue-900 dark:bg-slate-950 dark:text-white" />
            <input value={card.expiryYear} onChange={(event) => changeCard('expiryYear', event.target.value)} autoComplete="cc-exp-year" inputMode="numeric" placeholder="AAAA" className="rounded-xl border border-blue-200 bg-white px-3 py-3 text-center text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-tenant-primary dark:border-blue-900 dark:bg-slate-950 dark:text-white" />
            <input value={card.ccv} onChange={(event) => changeCard('ccv', event.target.value)} autoComplete="cc-csc" inputMode="numeric" type="password" placeholder="CVV" className="rounded-xl border border-blue-200 bg-white px-3 py-3 text-center text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-tenant-primary dark:border-blue-900 dark:bg-slate-950 dark:text-white" />
          </div>
        </div>
      )}

      {feedback && (
        <p role="status" className={`rounded-xl px-4 py-3 text-xs font-bold ${feedback.tone === 'success' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'}`}>
          {feedback.text}
        </p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={saving || !current || (selected === current && selected !== 'CREDIT_CARD')}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-tenant-primary px-4 py-3 text-xs font-black uppercase tracking-widest text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
        {saving ? 'Atualizando no Asaas...' : selected === 'CREDIT_CARD' && current === 'CREDIT_CARD' ? 'Trocar cartão' : `Mudar para ${label[selected]}`}
      </button>
      <p className="text-center text-[10px] font-medium text-brand-muted">
        {selfService ? 'A alteração vale para as próximas cobranças e para cobranças pendentes.' : 'A alteração é registrada na auditoria financeira e aplicada às cobranças pendentes.'}
      </p>
    </section>
  );
};

export default BillingMethodManager;
