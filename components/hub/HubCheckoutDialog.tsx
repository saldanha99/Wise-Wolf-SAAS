import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Barcode,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  Loader2,
  LockKeyhole,
  MailCheck,
  MessageCircleMore,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from '../../lib/supabase';
import {
  HUB_CORE_PRIVACY_SHA256,
  HUB_CORE_PRIVACY_VERSION,
  HUB_CORE_TERMS_SHA256,
  HUB_CORE_TERMS_VERSION,
  HUB_PAYMENT_PROCESSOR_NOTICE,
} from '../../supabase/functions/create-hub-checkout/legal';
import { hubMarketingPath } from './hubRoutes';
import { HUB_CORE_PRODUCT_FAMILY, isHubCorePlan } from './hubService';
import type { HubBillingCycle, HubPlan } from './types';

interface HubCheckoutDialogProps {
  plan: HubPlan;
  accountId: string;
  accountName: string;
  email: string;
  isCurrentPlan?: boolean;
  replacingSubscription?: boolean;
  currentBillingCycle?: HubBillingCycle | null;
  initialBillingCycle?: HubBillingCycle;
  onClose: () => void;
}

type BillingType = 'PIX' | 'BOLETO' | 'CREDIT_CARD';

type CheckoutResult = {
  checkoutId?: string;
  planName?: string;
  amount: number;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  pix?: { copyPaste?: string | null; qrCode?: string | null } | null;
};

const onlyDigits = (value: string) => value.replace(/\D/g, '');

/**
 * Cartão: os campos ficam no formulário isolado do site (/pagamento/cartao.html, iframe com sandbox,
 * origem opaca e CSP própria; ver docs/PAGAMENTOS-CARTAO.md). Este componente nunca vê o cartão:
 * manda ao iframe só a sessão, o id da cobrança e o valor; o iframe paga direto na hub-card-payment.
 */
export const HUB_CARD_FORM_URL = 'https://wisewolflanguage.com.br/pagamento/cartao.html';
const BILLING_LABEL: Record<BillingType, string> = { PIX: 'PIX', BOLETO: 'Boleto bancário', CREDIT_CARD: 'Cartão de crédito' };
const formatMoney = (value: number) => value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const resolveHubCheckoutInitialCycle = (
  plan: HubPlan,
  initialBillingCycle?: HubBillingCycle,
  isCurrentPlan = false,
  currentBillingCycle?: HubBillingCycle | null,
): HubBillingCycle => {
  const isAvailable = (cycle: HubBillingCycle) => {
    const price = Number(cycle === 'YEARLY' ? plan.price_yearly : plan.price_monthly);
    return price > 0 && !(isCurrentPlan && currentBillingCycle === cycle);
  };
  if (initialBillingCycle && isAvailable(initialBillingCycle)) return initialBillingCycle;
  if (isAvailable('MONTHLY')) return 'MONTHLY';
  if (isAvailable('YEARLY')) return 'YEARLY';
  return initialBillingCycle ?? 'MONTHLY';
};

const HubCheckoutDialog: React.FC<HubCheckoutDialogProps> = ({
  plan,
  accountId,
  accountName,
  email,
  isCurrentPlan = false,
  replacingSubscription = false,
  currentBillingCycle,
  initialBillingCycle,
  onClose,
}) => {
  const [name, setName] = useState(accountName);
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [phone, setPhone] = useState('');
  const [billingCycle, setBillingCycle] = useState<HubBillingCycle>(() =>
    resolveHubCheckoutInitialCycle(plan, initialBillingCycle, isCurrentPlan, currentBillingCycle));
  const [billingType, setBillingType] = useState<BillingType>('PIX');
  const [cardHeight, setCardHeight] = useState(520);
  const [cardNotice, setCardNotice] = useState('');
  const [paid, setPaid] = useState(false);
  const cardFrameRef = useRef<HTMLIFrameElement>(null);
  const accessTokenRef = useRef('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const dialogRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(loading);
  const amount = Number(billingCycle === 'YEARLY' ? plan.price_yearly : plan.price_monthly) || 0;
  const monthlyPrice = Number(plan.price_monthly || 0);
  const yearlyPrice = Number(plan.price_yearly || 0);
  const yearlySaving = Math.max((monthlyPrice * 12) - yearlyPrice, 0);
  const step = result ? 3 : reviewing ? 2 : 1;
  const cardOpen = Boolean(result?.checkoutId) && billingType === 'CREDIT_CARD' && !paid;

  // Conversa só com o iframe do cartão; o token da sessão vai só para ele.
  useEffect(() => {
    if (!cardOpen) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== cardFrameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; height?: number; status?: string };
      if (data?.type === 'ww-card-ready') {
        cardFrameRef.current?.contentWindow?.postMessage({
          type: 'ww-card-init',
          apiUrl: SUPABASE_URL,
          anonKey: SUPABASE_ANON_KEY,
          accessToken: accessTokenRef.current,
          checkoutId: result?.checkoutId,
          amountLabel: `R$ ${formatMoney(amount)}`,
          holder: { cpfCnpj, phone },
        }, '*');
      } else if (data?.type === 'ww-card-height' && typeof data.height === 'number') {
        setCardHeight(Math.min(Math.max(data.height + 8, 420), 1100));
      } else if (data?.type === 'ww-card-result') {
        if (data.status === 'APPROVED') setCardNotice('Cartão aprovado. Liberando seu acesso…');
        else if (data.status === 'UNKNOWN') setCardNotice('Estamos confirmando o pagamento com o banco. Não pague de novo.');
        else setCardNotice('');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [amount, cardOpen, cpfCnpj, phone, result?.checkoutId]);

  // Acompanha a cobrança até o webhook marcar PAID (RLS: só a própria conta lê).
  useEffect(() => {
    const checkoutId = result?.checkoutId;
    if (!checkoutId || paid) return;
    let alive = true;
    let timer = 0;
    const started = Date.now();
    const tick = async () => {
      try {
        const { data } = await supabase.from('hub_checkout_sessions').select('status').eq('id', checkoutId).maybeSingle();
        if (!alive) return;
        const status = (data as { status?: string } | null)?.status ?? '';
        if (status === 'PAID') {
          setPaid(true);
          return;
        }
      } catch {}
      if (alive && Date.now() - started < 30 * 60_000) timer = window.setTimeout(tick, 4000);
    };
    timer = window.setTimeout(tick, 4000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [paid, result?.checkoutId]);

  useEffect(() => {
    loadingRef.current = loading;
    if (loading) dialogRef.current?.focus();
  }, [loading]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusTimer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loadingRef.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls: HTMLElement[] = [];
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector).forEach((element) => controls.push(element));
      if (controls.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  const review = (event: React.FormEvent) => {
    event.preventDefault();
    const documentDigits = onlyDigits(cpfCnpj);
    const phoneDigits = onlyDigits(phone);
    if (name.trim().length < 3) return setError('Informe o nome completo ou a razão social.');
    if (![11, 14].includes(documentDigits.length)) return setError('Confira o CPF ou CNPJ informado.');
    if (phoneDigits.length < 10 || phoneDigits.length > 13) return setError('Informe um telefone com DDD.');
    if (amount <= 0) return setError('Este ciclo não está disponível para contratação.');
    if (!acceptedTerms || !acceptedPrivacy) return setError('Aceite os Termos de Uso e a Política de Privacidade para continuar.');
    setError('');
    setReviewing(true);
  };

  const submit = async () => {
    if (!isHubCorePlan(plan)) {
      setError('Este plano não pertence ao Wise Wolf Hub e não pode ser contratado aqui.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      if (billingType === 'CREDIT_CARD') {
        const { data: sessionData } = await supabase.auth.getSession();
        accessTokenRef.current = sessionData.session?.access_token ?? '';
        if (!accessTokenRef.current) throw new Error('SESSION_REQUIRED');
      }
      const { data, error: invokeError } = await supabase.functions.invoke('create-hub-checkout', {
        body: {
          accountId,
          planCode: plan.code,
          productFamily: HUB_CORE_PRODUCT_FAMILY,
          billingCycle,
          billingType,
          name,
          email,
          cpfCnpj,
          phone,
          requestKey,
          acceptedTerms,
          acceptedPrivacy,
          termsVersion: HUB_CORE_TERMS_VERSION,
          privacyVersion: HUB_CORE_PRIVACY_VERSION,
          termsSha256: HUB_CORE_TERMS_SHA256,
          privacySha256: HUB_CORE_PRIVACY_SHA256,
        },
      });
      if (invokeError) {
        let functionCode = invokeError.message;
        const context = (invokeError as { context?: Response }).context;
        if (context) {
          try {
            const payload = await context.clone().json() as { code?: string; error?: string };
            functionCode = payload.code ?? payload.error ?? functionCode;
          } catch {}
        }
        throw new Error(functionCode);
      }
      if (data?.error) throw new Error(data.code || data.error);
      setResult(data as CheckoutResult);
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : '';
      if (code.includes('INVALID_CHECKOUT_DATA')) setError('Algum dado não passou pela validação segura. Revise documento e telefone.');
      else if (code.includes('CHECKOUT_IN_PROGRESS')) setError('Sua cobrança já está sendo preparada. Aguarde alguns segundos e tente novamente.');
      else if (code.includes('PENDING_CHECKOUT_EXISTS')) setError('Já existe uma cobrança aberta para esta conta. Conclua ou cancele essa cobrança antes de trocar o plano.');
      else if (code.includes('SUBSCRIPTION_ALREADY_ACTIVE')) setError('Este plano e ciclo já estão ativos na sua conta. Escolha outra opção.');
      else if (code.includes('SUBSCRIPTION_INCOMPLETE')) setError('Há uma assinatura em conciliação. Fale com o suporte antes de criar outra cobrança.');
      else if (code.includes('HUB_ACCOUNT_INACTIVE')) setError('Esta conta está suspensa ou encerrada. Nenhuma cobrança foi criada.');
      else if (code.includes('HUB_DISABLED')) setError('O Hub está temporariamente indisponível e nenhuma cobrança foi criada.');
      else if (code.includes('HUB_CATALOG_NOT_READY')) setError('O catálogo ainda está em curadoria. Nenhuma cobrança foi criada.');
      else if (code.includes('HUB_LEGAL_DOCUMENT_MISMATCH') || code.includes('HUB_LEGAL_DOCUMENT_VERSION_CONFLICT')) setError('Os documentos legais mudaram desde que esta página abriu. Recarregue, revise e aceite o texto atual. Nenhuma cobrança foi criada.');
      else if (code.includes('HUB_LEGAL_CONFIGURATION_INVALID')) setError('A contratação está temporariamente indisponível para uma verificação de integridade. Nenhuma cobrança foi criada.');
      else if (code.includes('HUB_PLAN_AUDIENCE_MISMATCH')) setError('Este plano não está disponível para o perfil desta conta.');
      else if (code.includes('INVALID_PRODUCT')) setError('Este plano não está disponível no Wise Wolf Hub.');
      else if (code.includes('INVALID_HUB_CORE_LEGAL_ACCEPTANCE')) setError('Os documentos legais foram atualizados. Volte, revise e aceite as versões atuais.');
      else if (code.includes('SESSION_REQUIRED')) setError('Sua sessão expirou. Entre de novo para pagar com cartão. Nenhuma cobrança foi criada.');
      else setError('Não foi possível iniciar a cobrança. Nenhum valor foi debitado. Tente novamente.');
      if (!code.includes('CHECKOUT_IN_PROGRESS') && !code.includes('PENDING_CHECKOUT_EXISTS')) setRequestKey(crypto.randomUUID());
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="hub-checkout-overlay" role="dialog" aria-modal="true" aria-labelledby="hub-checkout-title">
      <div ref={dialogRef} tabIndex={-1} aria-busy={loading} className="hub-checkout-panel">
        <aside className="hub-checkout-summary">
          <div>
            <p className="hub-checkout-kicker"><LockKeyhole size={12} />Wise Wolf · checkout protegido</p>
            <h2>{plan.name}</h2>
            <p>{plan.description || 'Assinatura Wise Wolf Hub.'}</p>
          </div>

          <div className="hub-checkout-summary__price">
            <small>TOTAL DO CICLO</small>
            <strong>R$ {formatMoney(amount)}</strong>
            <span>{billingCycle === 'MONTHLY' ? 'Cobrança mensal' : `Cobrança anual · equivalente a R$ ${formatMoney(amount / 12)}/mês`}</span>
            {billingCycle === 'YEARLY' && yearlySaving > 0 && <em>Economia de R$ {formatMoney(yearlySaving)} no ciclo</em>}
          </div>

          <ul>
            {(plan.features || []).slice(0, 4).map((feature) => <li key={feature}><span><Check size={10} /></span>{feature}</li>)}
          </ul>

          <div className="hub-checkout-summary__delivery">
            <span><MailCheck size={16} /></span>
            <div><b>Entrega depois do pagamento</b><small>O acesso e os avisos por e-mail/WhatsApp são liberados assim que o pagamento é confirmado.</small></div>
          </div>
          <div className="hub-checkout-summary__delivery">
            <span><CheckCircle2 size={16} /></span>
            <div><b>Fluxo rastreável</b><small>Esta etapa registra versão dos documentos aceitos e cria trilha de auditoria para segurança da contratação.</small></div>
          </div>
        </aside>

        <section className="hub-checkout-content">
          <header className="hub-checkout-content__header">
            <div>
              <p>ETAPA {step} DE 3</p>
              <h2 id="hub-checkout-title">{paid ? 'Pagamento confirmado' : result ? (billingType === 'CREDIT_CARD' ? 'Pague com cartão' : 'Pagamento preparado') : reviewing ? 'Revise antes de gerar' : 'Complete sua assinatura'}</h2>
            </div>
            <button type="button" onClick={onClose} disabled={loading} aria-label="Fechar checkout"><X size={18} /></button>
          </header>

          <div className="hub-checkout-steps" aria-label={`Etapa ${step} de 3`}>
            {['Seus dados', 'Revisão', 'Pagamento'].map((label, index) => <div key={label} className={index < step ? 'is-active' : ''}><span>{index + 1}</span><p>{label}</p></div>)}
          </div>

          {paid ? (
            <div className="hub-checkout-result" aria-live="polite">
              <span className="hub-checkout-result__icon"><CheckCircle2 size={30} /></span>
              <h3>Assinatura confirmada.</h3>
              <p>Seu {plan.name} está liberado. Recarregue o Hub para ver o plano novo.</p>
              <button type="button" onClick={() => window.location.reload()} className="hub-button hub-button--primary">Abrir o Hub com o plano novo</button>
            </div>
          ) : cardOpen ? (
            <div className="hub-checkout-card">
              <p className="hub-checkout-info" data-testid="hub-payment-processor">{HUB_PAYMENT_PROCESSOR_NOTICE}</p>
              <iframe
                ref={cardFrameRef}
                title="Dados do cartão de crédito"
                src={HUB_CARD_FORM_URL}
                sandbox="allow-scripts allow-forms"
                referrerPolicy="no-referrer"
                style={{ height: cardHeight, width: '100%', border: 0 }}
              />
              {cardNotice && <p className="hub-checkout-info" aria-live="polite"><Loader2 className="hub-checkout-spinner" size={15} /> {cardNotice}</p>}
              <button type="button" onClick={onClose} className="hub-checkout-link">Voltar ao Hub</button>
            </div>
          ) : result ? (
            <div className="hub-checkout-result" aria-live="polite">
              <span className="hub-checkout-result__icon"><CheckCircle2 size={30} /></span>
              <h3>Agora falta confirmar o pagamento.</h3>
              <p>Assim que o pagamento for confirmado, o plano é liberado sozinho.{replacingSubscription ? ' Sua assinatura atual continua válida até a troca ser concluída.' : ''}</p>
              <p className="hub-checkout-info" data-testid="hub-payment-processor">{HUB_PAYMENT_PROCESSOR_NOTICE}</p>
              {result.pix?.qrCode && <img src={`data:image/png;base64,${result.pix.qrCode}`} alt="QR Code para pagamento por PIX" className="hub-checkout-result__qr" />}
              <div className="hub-checkout-result__actions">
                {result.pix?.copyPaste && <button type="button" onClick={() => navigator.clipboard.writeText(result.pix?.copyPaste || '')} className="hub-button hub-button--primary"><Copy size={15} />Copiar PIX</button>}
                {(result.bankSlipUrl || result.invoiceUrl) && <a href={result.bankSlipUrl || result.invoiceUrl || '#'} target="_blank" rel="noreferrer" className="hub-button hub-button--primary">Abrir cobrança</a>}
              </div>
              <div className="hub-checkout-result__timeline">
                <span><Check size={11} /></span><div><b>Cobrança criada</b><small>Nenhum acesso antecipado.</small></div>
                <span><MessageCircleMore size={13} /></span><div><b>Após confirmar</b><small>Acesso e avisos transacionais são processados uma única vez.</small></div>
              </div>
              <button type="button" onClick={onClose} className="hub-checkout-link">Voltar ao Hub</button>
            </div>
          ) : reviewing ? (
            <div className="hub-checkout-review">
              <div className="hub-checkout-review__plan"><div><small>PLANO E CICLO</small><b>{plan.name} · {billingCycle === 'MONTHLY' ? 'mensal' : 'anual'}</b></div><strong>R$ {formatMoney(amount)}</strong></div>
              <dl>
                <div><dt>Responsável</dt><dd>{name}</dd></div>
                <div><dt>Conta</dt><dd>{email}</dd></div>
                <div><dt>Documento</dt><dd>Final {onlyDigits(cpfCnpj).slice(-4).padStart(4, '•')}</dd></div>
                <div><dt>Pagamento</dt><dd>{BILLING_LABEL[billingType]}</dd></div>
                <div><dt>Documentos legais</dt><dd>Termos e Privacidade · versão {HUB_CORE_TERMS_VERSION}</dd></div>
              </dl>
              {replacingSubscription && <p className="hub-checkout-info">A troca só entra em vigor após o pagamento. Até lá, seu acesso atual permanece intacto.</p>}
              <p className="hub-checkout-info">{HUB_PAYMENT_PROCESSOR_NOTICE}</p>
              {error && <p className="hub-checkout-error" role="alert">{error}</p>}
              <button type="button" onClick={() => void submit()} disabled={loading} className="hub-button hub-button--primary hub-checkout-submit">
                {loading ? <Loader2 className="hub-checkout-spinner" size={18} /> : <ShieldCheck size={18} />}{loading ? 'Preparando o pagamento...' : billingType === 'CREDIT_CARD' ? 'Continuar para o cartão' : billingType === 'PIX' ? 'Gerar PIX' : 'Gerar boleto'}
              </button>
              <button type="button" onClick={() => { setReviewing(false); setError(''); }} disabled={loading} className="hub-checkout-link"><ArrowLeft size={15} />Corrigir dados</button>
              <p className="hub-checkout-legal">Esta ação cria uma cobrança. Ela não confirma pagamento e não libera o produto antecipadamente.</p>
            </div>
          ) : (
            <form onSubmit={review} noValidate className="hub-checkout-form">
              <fieldset className="hub-checkout-cycle">
                <legend>Ciclo de cobrança</legend>
                {(['MONTHLY', 'YEARLY'] as const).map((cycle) => {
                  const price = Number(cycle === 'YEARLY' ? plan.price_yearly : plan.price_monthly);
                  const isCurrentCycle = isCurrentPlan && currentBillingCycle === cycle;
                  const unavailable = price <= 0;
                  return (
                    <button key={cycle} type="button" aria-pressed={billingCycle === cycle} disabled={isCurrentCycle || unavailable} className={billingCycle === cycle ? 'is-active' : ''} onClick={() => setBillingCycle(cycle)}>
                      <span>{cycle === 'MONTHLY' ? 'Mensal' : 'Anual'}{isCurrentCycle && <small>Atual</small>}</span>
                      <strong>{unavailable ? 'Indisponível' : `R$ ${formatMoney(price)}`}</strong>
                    </button>
                  );
                })}
              </fieldset>

              <label className="hub-checkout-field">
                <span>Nome completo ou razão social</span>
                <input value={name} onChange={(event) => setName(event.target.value)} required minLength={3} autoComplete="name" />
              </label>
              <div className="hub-checkout-form__row">
                <label className="hub-checkout-field"><span>CPF ou CNPJ</span><input value={cpfCnpj} onChange={(event) => setCpfCnpj(event.target.value)} required inputMode="numeric" autoComplete="off" placeholder="Somente números" /></label>
                <label className="hub-checkout-field"><span>Telefone com DDD</span><input value={phone} onChange={(event) => setPhone(event.target.value)} required inputMode="tel" autoComplete="tel" placeholder="(11) 99999-9999" /></label>
              </div>

              <fieldset className="hub-checkout-payment">
                <legend>Como deseja pagar?</legend>
                <button type="button" aria-pressed={billingType === 'PIX'} className={billingType === 'PIX' ? 'is-active' : ''} onClick={() => setBillingType('PIX')}><Smartphone size={20} /><span><b>PIX</b><small>Liberação após confirmação</small></span><i>{billingType === 'PIX' && <Check size={11} />}</i></button>
                <button type="button" aria-pressed={billingType === 'CREDIT_CARD'} className={billingType === 'CREDIT_CARD' ? 'is-active' : ''} onClick={() => setBillingType('CREDIT_CARD')}><CreditCard size={20} /><span><b>Cartão de crédito</b><small>{billingCycle === 'MONTHLY' ? 'Renova todo mês no cartão' : 'Anual à vista'}</small></span><i>{billingType === 'CREDIT_CARD' && <Check size={11} />}</i></button>
                <button type="button" aria-pressed={billingType === 'BOLETO'} className={billingType === 'BOLETO' ? 'is-active' : ''} onClick={() => setBillingType('BOLETO')}><Barcode size={20} /><span><b>Boleto</b><small>Compensação bancária</small></span><i>{billingType === 'BOLETO' && <Check size={11} />}</i></button>
              </fieldset>

              <fieldset className="hub-checkout-consents">
                <legend>Documentos da contratação</legend>
                <label>
                  <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} required />
                  <span>Li e aceito os <a href={hubMarketingPath('terms')} target="_blank" rel="noreferrer">Termos de Uso</a> do Wise Wolf Hub, versão {HUB_CORE_TERMS_VERSION}.</span>
                </label>
                <label>
                  <input type="checkbox" checked={acceptedPrivacy} onChange={(event) => setAcceptedPrivacy(event.target.checked)} required />
                  <span>Li e aceito a <a href={hubMarketingPath('privacy')} target="_blank" rel="noreferrer">Política de Privacidade</a>, versão {HUB_CORE_PRIVACY_VERSION}.</span>
                </label>
                <div className="hub-checkout-legal">Esses aceites são necessários para a contratação e não autorizam mensagens de marketing.</div>
                <div className="hub-checkout-legal">A cobrança é criada após revisão e só vira acesso após confirmação do pagamento pelo provedor.</div>
              </fieldset>

              {replacingSubscription && <p className="hub-checkout-info">A troca acontece somente após o pagamento. Até lá, sua assinatura atual permanece intacta.</p>}
              {error && <p className="hub-checkout-error" role="alert">{error}</p>}
              <button type="submit" className="hub-button hub-button--primary hub-checkout-submit"><ShieldCheck size={17} />Revisar assinatura</button>
              <p className="hub-checkout-legal">A Wise Wolf não guarda dados do cartão. Ao informar o telefone, você receberá apenas comunicações transacionais desta contratação; marketing permanece separado.</p>
            </form>
          )}
        </section>
      </div>
    </div>
  );
};

export default HubCheckoutDialog;
