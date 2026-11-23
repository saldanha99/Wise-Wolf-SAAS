import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, Loader2, Mic, QrCode, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { HUB_PAYMENT_PROCESSOR_NOTICE } from '../supabase/functions/_shared/hub-payment-processor';

/**
 * Compra de minutos de conversa ao vivo DENTRO do app (22/11/2026).
 *
 * PIX pelo Asaas (create-wolfie-topup), QR e copia-e-cola na própria tela, e a
 * confirmação chega sozinha: o webhook marca o pedido como PAID e credita os
 * minutos; aqui só acompanhamos o pedido do próprio aluno (RLS de leitura).
 * Abre por cima do tutor, então a conversa não se perde. Cartão não aparece:
 * a recarga do Wolfie hoje só aceita PIX.
 */
interface TopupPackage {
  id: string;
  name: string;
  minutes: number;
  price_brl: number;
}

interface PixCharge {
  orderId: string;
  minutes: number;
  value: number;
  pixPayload: string | null;
  pixQrCode: string | null;
  invoiceUrl: string | null;
}

const ERROR_TEXT: Record<string, string> = {
  CUSTOMER_NOT_READY: 'Seu cadastro de pagamento ainda não está pronto. Fale com a escola para liberar a compra.',
  ASAAS_NOT_CONFIGURED: 'A compra de minutos ainda não está ativa nesta escola.',
  TOPUP_UNAVAILABLE: 'A compra está indisponível agora. Tente de novo em alguns minutos.',
  TOPUP_RECONCILIATION_PENDING: 'Estamos conferindo um pedido anterior. Tente de novo em alguns minutos.',
  IDEMPOTENCY_KEY_CONFLICT: 'Este pedido mudou de pacote. Feche e abra de novo para gerar o PIX.',
};

const brl = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function errorCode(error: unknown): Promise<string> {
  const context = (error as { context?: { json?: () => Promise<unknown> } })?.context;
  if (context?.json) {
    try {
      const body = await context.json() as { error?: unknown };
      if (typeof body?.error === 'string') return body.error;
    } catch {
      // resposta sem JSON
    }
  }
  return 'TOPUP_UNAVAILABLE';
}

export const WolfieTopupModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onCredited?: () => void;
}> = ({ open, onClose, onCredited }) => {
  const [packages, setPackages] = useState<TopupPackage[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [charge, setCharge] = useState<PixCharge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [paid, setPaid] = useState(false);
  // Uma chave de idempotência por pacote: trocar de pacote depois de um erro não
  // pode reaproveitar a chave do pedido anterior (IDEMPOTENCY_KEY_CONFLICT).
  const requestKeys = useRef<Record<string, string>>({});
  const onCreditedRef = useRef(onCredited);
  onCreditedRef.current = onCredited;
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setCharge(null);
    setPaid(false);
    setError('');
    requestKeys.current = {};
    supabase.from('wolfie_topup_packages').select('id,name,minutes,price_brl').eq('active', true)
      .order('minutes', { ascending: true })
      .then(({ data, error: loadError }) => {
        if (loadError) {
          setError(ERROR_TEXT.TOPUP_UNAVAILABLE);
          setPackages([]);
          return;
        }
        const list = (data ?? []) as TopupPackage[];
        setPackages(list);
        // Destaque: o do meio quando há 3; senão, o de melhor preço por minuto.
        const featured = list.length === 3
          ? list[1]
          : [...list].sort((a, b) => a.price_brl / a.minutes - b.price_brl / b.minutes)[0];
        setSelected(featured?.id ?? null);
      });
  }, [open]);

  // Confirmação automática: o webhook do Asaas marca o pedido como PAID.
  useEffect(() => {
    if (!charge || paid) return;
    let alive = true;
    const started = Date.now();
    const waiting = new Set(['PENDING', 'CREATING', 'AWAITING_PAYMENT']);
    const tick = async () => {
      const { data } = await supabase.from('wolfie_topup_orders').select('status').eq('id', charge.orderId).maybeSingle();
      if (!alive) return;
      const status = (data as { status?: string } | null)?.status ?? '';
      if (status === 'PAID') {
        setPaid(true);
        onCreditedRef.current?.();
        return;
      }
      if (status && !waiting.has(status)) {
        setCharge(null);
        setError('Este PIX não foi concluído. Gere um novo para continuar.');
        return;
      }
      if (Date.now() - started < 30 * 60_000) timer = setTimeout(tick, 4000);
    };
    let timer = setTimeout(tick, 4000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [charge, paid]);

  // Esc fecha; o foco entra no diálogo ao abrir.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const buy = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    const { data, error: invokeError } = await supabase.functions.invoke('create-wolfie-topup', {
      body: {
        packageId: selected,
        requestKey: (requestKeys.current[selected] ??= crypto.randomUUID()),
      },
    });
    setBusy(false);
    if (invokeError || !data || (data as { error?: unknown }).error) {
      const code = invokeError ? await errorCode(invokeError) : String((data as { error?: unknown })?.error ?? '');
      setError(ERROR_TEXT[code] ?? 'Não foi possível gerar o PIX agora. Tente de novo.');
      return;
    }
    setCharge(data as PixCharge);
  }, [selected]);

  const copy = async () => {
    if (!charge?.pixPayload) return;
    try {
      await navigator.clipboard.writeText(charge.pixPayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[300] flex items-end justify-center bg-slate-950/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="wolfie-topup-title">
      <div ref={dialogRef} tabIndex={-1} className="w-full max-w-md outline-none rounded-t-3xl border border-slate-800 bg-slate-950 p-5 text-slate-100 shadow-2xl sm:rounded-3xl sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-emerald-300">
              <Mic size={14} aria-hidden="true" /> Conversa ao vivo
            </p>
            <h2 id="wolfie-topup-title" className="mt-1 text-xl font-black tracking-tight">
              {paid ? 'Minutos creditados!' : charge ? 'Pague com PIX' : 'Mais minutos com o Wolfie'}
            </h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Fechar">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {paid ? (
          <div className="mt-5 text-center">
            <CheckCircle2 size={48} className="mx-auto text-emerald-400" aria-hidden="true" />
            <p className="mt-3 text-slate-300">{charge?.minutes} minutos já estão no seu saldo. Pode continuar a conversa.</p>
            <button type="button" onClick={onClose} className="mt-5 w-full rounded-full bg-emerald-400 py-3 text-sm font-black text-slate-950">
              Voltar para a conversa
            </button>
          </div>
        ) : charge ? (
          <div className="mt-4">
            <p className="text-sm text-slate-400">
              {charge.minutes} minutos por <strong className="text-white">{brl(Number(charge.value))}</strong>. Abra o app do banco e pague pelo QR ou pelo copia-e-cola.
            </p>
            <p data-testid="wolfie-topup-payment-processor" className="mt-2 rounded-xl bg-white/5 px-3 py-2 text-xs font-semibold text-slate-200">{HUB_PAYMENT_PROCESSOR_NOTICE}</p>
            {charge.pixQrCode ? (
              <img
                src={`data:image/png;base64,${charge.pixQrCode}`}
                alt="QR Code do PIX"
                className="mx-auto mt-4 h-52 w-52 rounded-2xl bg-white p-2"
              />
            ) : (
              <p className="mt-4 flex items-center gap-2 rounded-xl bg-slate-900 p-3 text-sm text-slate-300">
                <QrCode size={16} aria-hidden="true" /> O QR não carregou; use o copia-e-cola abaixo.
              </p>
            )}
            {charge.pixPayload ? (
              <button type="button" onClick={() => void copy()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-full border border-slate-700 py-3 text-sm font-bold hover:bg-slate-900">
                <Copy size={15} aria-hidden="true" /> {copied ? 'Código copiado!' : 'Copiar código PIX'}
              </button>
            ) : null}
            <p className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-400" aria-live="polite">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Esperando o pagamento — os minutos entram sozinhos em segundos.
            </p>
          </div>
        ) : (
          <div className="mt-4">
            <p className="text-sm text-slate-400">A prática por escrita continua ilimitada. Os minutos extras valem para a conversa por voz ao vivo.</p>
            {packages === null ? (
              <p className="mt-4 flex items-center gap-2 text-sm text-slate-300"><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Carregando pacotes…</p>
            ) : (
              <fieldset className="mt-4 space-y-2">
                <legend className="sr-only">Pacotes de minutos</legend>
                {packages.map((pkg, index) => {
                  const featured = packages.length === 3 ? index === 1 : pkg.id === selected && index === packages.length - 1;
                  const active = pkg.id === selected;
                  return (
                    <label
                      key={pkg.id}
                      className={`relative flex w-full cursor-pointer items-center justify-between rounded-2xl border px-4 py-3.5 text-left transition focus-within:ring-2 focus-within:ring-emerald-300 ${
                        active ? 'border-emerald-400 bg-emerald-400/10' : 'border-slate-800 bg-slate-900 hover:border-slate-600'
                      }`}
                    >
                      <input
                        type="radio"
                        name="wolfie-topup-package"
                        value={pkg.id}
                        checked={active}
                        onChange={() => setSelected(pkg.id)}
                        className="sr-only"
                      />
                      {featured ? (
                        <span className="absolute -top-2.5 right-4 rounded-full bg-emerald-400 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-slate-950">Mais escolhido</span>
                      ) : null}
                      <span>
                        <span className="block text-base font-black">{pkg.minutes} minutos</span>
                        <span className="block text-xs text-slate-400">{brl(pkg.price_brl / pkg.minutes)} por minuto</span>
                      </span>
                      <span className="text-lg font-black">{brl(Number(pkg.price_brl))}</span>
                    </label>
                  );
                })}
              </fieldset>
            )}
            {error ? <p className="mt-3 rounded-xl bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}
            <button
              type="button"
              onClick={() => void buy()}
              disabled={!selected || busy || !packages?.length}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-emerald-400 py-3.5 text-sm font-black text-slate-950 disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <QrCode size={16} aria-hidden="true" />}
              Gerar PIX
            </button>
            <p className="mt-3 text-center text-[11px] text-slate-500">Pagamento por PIX. {HUB_PAYMENT_PROCESSOR_NOTICE} Os minutos entram assim que o pagamento é confirmado.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default WolfieTopupModal;
