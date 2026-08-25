import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Building2,
  Check,
  FileText,
  MailCheck,
  MessageCircleMore,
  QrCode,
} from 'lucide-react';
import type { HubBillingCycle, HubPlan } from './types';
import { HubReveal, HubSectionIntro } from './HubMarketingShell';
import { hubMarketingPath } from './hubRoutes';

interface HubPricingSectionProps {
  plans: HubPlan[];
  onChoosePlan: (plan: HubPlan, billingCycle: HubBillingCycle) => void;
  mode?: 'educator' | 'overview';
  catalogReady?: boolean;
}

const CORE_PRICING_ORDER = ['LIBRARY_SOLO', 'EDUCATOR_PRO', 'HUB_COMPLETE'];

const PLAN_SCOPE: Record<string, { eyebrow: string; outcome: string }> = {
  LIBRARY_SOLO: {
    eyebrow: 'Micro solução · Biblioteca',
    outcome: 'Para encontrar, avaliar e levar materiais para a aula.',
  },
  EDUCATOR_PRO: {
    eyebrow: 'Biblioteca + Educador IA',
    outcome: 'Para transformar objetivos reais em aulas estruturadas.',
  },
  HUB_COMPLETE: {
    eyebrow: 'Solução pedagógica completa',
    outcome: 'Para unir preparação, planejamento e prática por texto.',
  },
};

const formatMoney = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  maximumFractionDigits: 2,
  ...options,
}).format(value);

const HubPricingSection: React.FC<HubPricingSectionProps> = ({ plans, onChoosePlan, mode = 'educator', catalogReady = true }) => {
  const [billingCycle, setBillingCycle] = useState<HubBillingCycle>('YEARLY');
  const paidPlans = useMemo(() => plans
    .filter((plan) => CORE_PRICING_ORDER.includes(plan.code) && plan.metadata?.sales_assisted !== true)
    .sort((first, second) => CORE_PRICING_ORDER.indexOf(first.code) - CORE_PRICING_ORDER.indexOf(second.code)), [plans]);

  const highestAnnualSaving = useMemo(() => paidPlans.reduce((highest, plan) => {
    const monthly = Number(plan.price_monthly || 0);
    const yearly = Number(plan.price_yearly || 0);
    return Math.max(highest, Math.max((monthly * 12) - yearly, 0));
  }, 0), [paidPlans]);

  if (paidPlans.length === 0) return null;

  return (
    <section id="planos" className="hub-section hub-section--quiet hub-pricing-section">
      <div className="hub-container">
        <div className="hub-pricing-toolbar">
          <HubReveal>
            <HubSectionIntro
              eyebrow={mode === 'overview' ? 'Preços por jornada' : 'Planos para educadores'}
              title={mode === 'overview'
                ? <>Contrate uma parte. <em>Ou conecte a experiência inteira.</em></>
                : <>Escolha o que resolve agora. <em>Evolua quando fizer sentido.</em></>}
              description={mode === 'overview'
                ? 'Professores contratam ferramentas pedagógicas diretamente. Wolfie individual usa planos próprios; School OS começa por diagnóstico e implantação.'
                : 'Compare as soluções pelo resultado que entra na sua rotina. O pagamento é criado no Asaas e o acesso só é liberado após confirmação.'}
            />
          </HubReveal>
          <HubReveal delay={0.08}>
            <div className="hub-billing-toggle" aria-label="Ciclo de cobrança">
              <button type="button" aria-pressed={billingCycle === 'MONTHLY'} className={billingCycle === 'MONTHLY' ? 'is-active' : ''} onClick={() => setBillingCycle('MONTHLY')}>Mensal</button>
              <button type="button" aria-pressed={billingCycle === 'YEARLY'} className={billingCycle === 'YEARLY' ? 'is-active' : ''} onClick={() => setBillingCycle('YEARLY')}>
                Anual{highestAnnualSaving > 0 && <small>economize até R$ {formatMoney(highestAnnualSaving)}</small>}
              </button>
            </div>
          </HubReveal>
        </div>

        {!catalogReady && (
          <p role="status" className="hub-catalog-readiness-note">
            <strong>Catálogo em curadoria · abertura em breve</strong>
            As assinaturas e o teste do Hub Core permanecem fechados até a publicação do acervo validado. Wolfie e School OS continuam disponíveis.
          </p>
        )}

        <div className="hub-pricing-grid">
          {paidPlans.map((plan, index) => {
            const monthlyPrice = Number(plan.price_monthly || 0);
            const yearlyPrice = Number(plan.price_yearly || 0);
            const annualMonthlyEquivalent = yearlyPrice > 0 ? yearlyPrice / 12 : monthlyPrice;
            const amount = billingCycle === 'YEARLY' && yearlyPrice > 0 ? annualMonthlyEquivalent : monthlyPrice;
            const yearlySaving = Math.max((monthlyPrice * 12) - yearlyPrice, 0);
            const isFeatured = plan.metadata?.popular === true;
            const unavailable = !catalogReady || amount <= 0;
            return (
              <HubReveal key={plan.id} delay={index * 0.06}>
                <article className={`hub-pricing-card ${isFeatured ? 'is-featured' : ''}`}>
                  {isFeatured && <span className="hub-pricing-card__badge">Recomendado</span>}
                  <p className="hub-pricing-card__scope">{PLAN_SCOPE[plan.code]?.eyebrow || 'Plano Wise Wolf'}</p>
                  <p className="hub-pricing-card__name">{plan.name}</p>
                  <h3>{PLAN_SCOPE[plan.code]?.outcome || plan.description || 'Uma solução Wise Wolf para sua rotina educacional.'}</h3>
                  <div className="hub-pricing-card__price">
                    <span className="hub-pricing-card__currency">R$</span>
                    <span className="hub-pricing-card__amount">{formatMoney(amount)}</span>
                    <span className="hub-pricing-card__period">/mês</span>
                  </div>
                  <p className="hub-pricing-card__billing-note">
                    {billingCycle === 'YEARLY' && yearlyPrice > 0
                      ? `R$ ${formatMoney(yearlyPrice)} cobrados no ciclo anual.`
                      : 'Cobrança recorrente no ciclo mensal.'}
                  </p>
                  {billingCycle === 'YEARLY' && yearlySaving > 0 && <span className="hub-pricing-card__saving">R$ {formatMoney(yearlySaving)} a menos que 12 meses avulsos</span>}
                  <div className="hub-pricing-card__divider" />
                  <ul>
                    {(Array.isArray(plan.features) ? plan.features : []).map((feature) => (
                      <li key={feature}><span><Check size={11} /></span>{feature}</li>
                    ))}
                  </ul>
                  <button type="button" disabled={unavailable} className={`hub-button ${isFeatured ? 'hub-button--primary' : 'hub-button--secondary'}`} onClick={() => onChoosePlan(plan, billingCycle)}>
                    {!catalogReady ? 'Abertura em breve' : unavailable ? 'Temporariamente indisponível' : `Escolher ${plan.name}`}
                  </button>
                </article>
              </HubReveal>
            );
          })}
        </div>

        <HubReveal className="hub-pricing-trust" delay={0.12}>
          <article><span><QrCode size={16} /></span><div><b>PIX ou boleto</b><small>Cobrança criada e processada pelo Asaas.</small></div></article>
          <article><span><MailCheck size={16} /></span><div><b>Entrega após confirmação</b><small>O acesso não é liberado enquanto o pagamento está pendente.</small></div></article>
          <article><span><MessageCircleMore size={16} /></span><div><b>Aviso transacional</b><small>Confirmação preparada por e-mail e WhatsApp, com controle de reenvio.</small></div></article>
        </HubReveal>

        {mode === 'overview' && (
          <HubReveal className="hub-pricing-paths" delay={0.14}>
            <a href={hubMarketingPath('wolfie')} className="hub-pricing-path is-wolfie">
              <span className="hub-pricing-path__icon"><Bot size={21} /></span>
              <span className="hub-pricing-path__copy">
                <small>Para alunos e prática individual</small>
                <strong>Wolfie a partir de R$ 49,90/mês</strong>
                <span>Planos de voz em ambiente próprio, separados do acesso escolar.</span>
              </span>
              <ArrowRight size={18} />
            </a>
            <a href={hubMarketingPath('school-os')} className="hub-pricing-path is-school">
              <span className="hub-pricing-path__icon"><Building2 size={21} /></span>
              <span className="hub-pricing-path__copy">
                <small>Para escolas de idiomas</small>
                <strong>School OS sob medida</strong>
                <span>Diagnóstico, implantação e escopo antes de qualquer contratação.</span>
              </span>
              <FileText size={18} />
            </a>
          </HubReveal>
        )}
      </div>
    </section>
  );
};

export default HubPricingSection;
