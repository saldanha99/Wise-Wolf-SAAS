import React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Building2,
  Check,
  CircleCheck,
  FileText,
  GraduationCap,
  Layers3,
  LockKeyhole,
  MessageCircle,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import HubMarketingShell, { HubFaq, HubReveal, HubSectionIntro } from './HubMarketingShell';
import HubNativeProductTour, { type HubNativeTourKind } from './HubNativeProductTour';
import HubProductMockup, { type HubMockupKind } from './HubProductMockups';
import HubVideoShowcase, { HUB_PUBLIC_VIDEOS_ENABLED } from './HubVideoShowcase';
import { hubMarketingPath, resolveSystemAppUrl, type HubMarketingPage } from './hubRoutes';
import type { HubAudience, HubBillingCycle, HubPlan, HubSettings } from './types';
import { WOLFIE_STANDALONE_PLANS, wolfieSubscribeHref } from '../../apps/wolfie-web/src/funnel/wolfiePlans';

type SolutionPage = Exclude<HubMarketingPage, 'overview'>;

interface HubSolutionLandingProps {
  page: SolutionPage;
  plans: HubPlan[];
  settings: HubSettings;
  catalogReady?: boolean;
  onAuthenticate: (mode: 'login' | 'signup', audience?: HubAudience) => void;
  onPlanSelect: (planCode: string, billingCycle: HubBillingCycle) => void;
}

type SolutionConfig = {
  name: string;
  eyebrow: string;
  title: string;
  emphasis: string;
  description: string;
  audience: HubAudience;
  icon: React.ElementType;
  accent: string;
  primaryLabel: string;
  primaryKind: 'AUTH' | 'WOLFIE' | 'SAAS';
  planCodes: string[];
  mockup: HubMockupKind;
  proof: string[];
  problems: Array<{ before: string; after: string }>;
  steps: Array<{ title: string; description: string; icon: React.ElementType }>;
  outcomes: string[];
  boundaryEyebrow: string;
  boundaryTitle: string;
  boundaryDescription: string;
  boundaryLabel: string;
  boundaryHref: 'PORTAL' | 'PRIMARY';
  faq: Array<{ question: string; answer: string }>;
};

const SOLUTIONS: Record<SolutionPage, SolutionConfig> = {
  library: {
    name: 'Wise Wolf Library',
    eyebrow: 'Acervo para professores de inglês',
    title: 'Pare de procurar material.',
    emphasis: 'Escolha com intenção.',
    description: 'Uma biblioteca organizada por nível, nicho e coleção para você chegar ao material certo sem desmontar sua rotina de preparação.',
    audience: 'EDUCATOR',
    icon: BookOpen,
    accent: '#d66a45',
    primaryLabel: 'Testar a Biblioteca',
    primaryKind: 'AUTH',
    planCodes: ['LIBRARY_SOLO', 'EDUCATOR_PRO', 'HUB_COMPLETE'],
    mockup: 'library',
    proof: ['Catálogo com curadoria', 'Filtros por contexto', 'Prévia separada do arquivo'],
    problems: [
      { before: 'Pastas, links e arquivos dispersos', after: 'Um acervo navegável por objetivo' },
      { before: 'Tempo perdido antes da aula', after: 'Escolha mais rápida e consciente' },
      { before: 'Conteúdo sem origem clara', after: 'Publicação após validação de direitos' },
    ],
    steps: [
      { title: 'Filtre o contexto', description: 'Parta do nível, nicho e tipo de experiência que você quer criar.', icon: Layers3 },
      { title: 'Avalie a prévia', description: 'Confira a proposta antes de abrir o conteúdo completo liberado para seu plano.', icon: FileText },
      { title: 'Leve para a aula', description: 'Use o material como base e adapte a condução ao seu aluno.', icon: GraduationCap },
    ],
    outcomes: ['Mais consistência na preparação', 'Menos improviso operacional', 'Materiais para diferentes perfis de aluno'],
    boundaryEyebrow: 'Já é aluno Wise Wolf?',
    boundaryTitle: 'Não assine duas vezes o que sua escola já oferece.',
    boundaryDescription: 'O aluno acessa a biblioteca incluída na própria jornada pelo Portal do Aluno. Esta assinatura externa é voltada ao uso profissional do educador.',
    boundaryLabel: 'Acessar Portal do Aluno',
    boundaryHref: 'PORTAL',
    faq: [
      { question: 'Os materiais são públicos?', answer: 'Não. O catálogo mostra apenas conteúdos autorizados; os arquivos ficam protegidos e o acesso completo depende do plano.' },
      { question: 'Posso usar com qualquer nível?', answer: 'O catálogo pode reunir materiais de A1 a C2, conforme o conteúdo efetivamente publicado pela curadoria.' },
      { question: 'Como o acesso ao arquivo é protegido?', answer: 'A prévia e o arquivo completo seguem rotas diferentes. A abertura do conteúdo exige conta, plano e permissão válidos.' },
      { question: 'Sou aluno da Wise Wolf. Preciso assinar?', answer: 'Não para acessar a biblioteca escolar incluída na sua jornada. Entre pelo Portal do Aluno.' },
    ],
  },
  'educator-ai': {
    name: 'Educador IA',
    eyebrow: 'Planejamento pedagógico com contexto',
    title: 'A IA não começa pela atividade.',
    emphasis: 'Começa pelo resultado.',
    description: 'Transforme nível, duração, objetivo e realidade do aluno em um plano estruturado — sem entregar sua intenção pedagógica para um prompt genérico.',
    audience: 'EDUCATOR',
    icon: Sparkles,
    accent: '#7652ed',
    primaryLabel: 'Criar meu primeiro plano',
    primaryKind: 'AUTH',
    planCodes: ['EDUCATOR_PRO', 'HUB_COMPLETE'],
    mockup: 'educator',
    proof: ['Objetivo antes da atividade', 'Base pronta para adaptar', 'Consumo controlado por plano'],
    problems: [
      { before: 'Prompts repetidos e respostas genéricas', after: 'Contexto pedagógico em cada geração' },
      { before: 'Atividades sem sequência', after: 'Aquecimento, prática e continuidade' },
      { before: 'Plano bonito, mas pouco aplicável', after: 'Duração e nível entram desde o início' },
    ],
    steps: [
      { title: 'Defina o resultado', description: 'Explique o que o aluno precisa conseguir fazer ao final.', icon: CircleCheck },
      { title: 'Adicione o contexto', description: 'Informe nível, duração, profissão, dificuldade ou interesse relevante.', icon: MessageCircle },
      { title: 'Refine a sequência', description: 'Receba uma base estruturada, revise e conduza com sua experiência.', icon: Workflow },
    ],
    outcomes: ['Planejamento mais consistente', 'Atividades ligadas a objetivos reais', 'Mais tempo para observar e ensinar'],
    boundaryEyebrow: 'Inteligência com responsabilidade',
    boundaryTitle: 'A IA estrutura. O professor decide.',
    boundaryDescription: 'O plano é uma primeira versão estruturada para revisão. A escolha da abordagem, a adaptação ao aluno e a condução da aula continuam sob responsabilidade do educador.',
    boundaryLabel: 'Começar a descoberta',
    boundaryHref: 'PRIMARY',
    faq: [
      { question: 'A IA substitui o professor?', answer: 'Não. Ela organiza uma primeira versão. A decisão pedagógica, a adaptação e a condução continuam com o educador.' },
      { question: 'Existe limite de uso?', answer: 'Sim. Cada plano define sua franquia de gerações e o consumo só é confirmado quando a criação é concluída.' },
      { question: 'Como adapto o plano gerado?', answer: 'Use o resultado como base estruturada: copie o plano e revise abordagem, exemplos e condução antes da aula.' },
      { question: 'Os dados de uma escola aparecem para outra?', answer: 'Não. A conta escolhida determina o contexto e as permissões; ambientes diferentes permanecem isolados.' },
    ],
  },
  wolfie: {
    name: 'Wolfie AI Tutor',
    eyebrow: 'Prática de inglês para situações reais',
    title: 'Pratique antes de o inglês',
    emphasis: 'virar uma situação real.',
    description: 'Entre em conversas ligadas ao seu objetivo, ao seu nível e ao mundo em que você quer agir — do trabalho à viagem, sem esperar a próxima aula.',
    audience: 'LEARNER',
    icon: Bot,
    accent: '#20a9cc',
    primaryLabel: 'Conhecer os planos Wolfie',
    primaryKind: 'WOLFIE',
    planCodes: [],
    mockup: 'wolfie',
    proof: ['Prática contextual', 'Nível ajustável', 'Histórico protegido por usuário'],
    problems: [
      { before: 'Estudo distante da vida real', after: 'Cenários ligados ao seu objetivo' },
      { before: 'Medo de errar em público', after: 'Espaço privado para tentar e repetir' },
      { before: 'Longos intervalos entre aulas', after: 'Prática disponível quando você precisa' },
    ],
    steps: [
      { title: 'Escolha um universo', description: 'Comece por uma situação relevante para sua profissão, viagem ou rotina.', icon: Layers3 },
      { title: 'Converse no seu nível', description: 'O contexto orienta vocabulário, exigência e continuidade da conversa.', icon: MessageCircle },
      { title: 'Volte com mais confiança', description: 'Repita cenários e leve novas dúvidas para suas aulas reais.', icon: GraduationCap },
    ],
    outcomes: ['Mais contato ativo com o idioma', 'Prática alinhada ao seu momento', 'Confiança construída pela repetição'],
    boundaryEyebrow: 'Aluno Wise Wolf',
    boundaryTitle: 'Comece pelo acesso que sua escola já incluiu.',
    boundaryDescription: 'Alunos da escola têm biblioteca e uma experiência parcial do tutor no Portal do Aluno. A assinatura individual do Wolfie é opcional e fica em um ambiente separado.',
    boundaryLabel: 'Acessar Portal do Aluno',
    boundaryHref: 'PORTAL',
    faq: [
      { question: 'Sou aluno da Wise Wolf. Preciso assinar?', answer: 'Seu acesso escolar já inclui a biblioteca e uma experiência parcial do tutor. Use o Portal do Aluno; a assinatura individual é opcional e separada.' },
      { question: 'O Wolfie é uma aula particular?', answer: 'Não. Ele é uma ferramenta de prática com IA e não substitui acompanhamento pedagógico ou uma aula com professor.' },
      { question: 'Posso praticar situações do meu trabalho?', answer: 'A proposta é justamente partir de contextos relevantes ao seu objetivo e ao nível configurado.' },
      { question: 'Onde assino a versão individual?', answer: 'A contratação individual acontece no ambiente próprio do Wolfie, separado do sistema escolar.' },
    ],
  },
  'school-os': {
    name: 'Wise Wolf School OS',
    eyebrow: 'Sistema para escolas de idiomas',
    title: 'Sua escola não precisa crescer',
    emphasis: 'em processos soltos.',
    description: 'Conecte agenda, matrícula, contratos, equipe e visão financeira em uma operação com contexto, papéis definidos e dados separados por escola.',
    audience: 'INSTITUTION',
    icon: Building2,
    accent: '#258e79',
    primaryLabel: 'Solicitar demonstração',
    primaryKind: 'SAAS',
    planCodes: [],
    mockup: 'school',
    proof: ['Operação multi-tenant', 'Papéis e permissões', 'Implantação assistida'],
    problems: [
      { before: 'Agenda, contratos e cobrança separados', after: 'Fluxos conectados por uma operação' },
      { before: 'Acesso amplo demais para a equipe', after: 'Papéis e escopos por responsabilidade' },
      { before: 'Decisões com informação fragmentada', after: 'Contexto operacional em um só lugar' },
    ],
    steps: [
      { title: 'Mapeamos sua operação', description: 'Entendemos equipe, alunos, rotina comercial e modelo financeiro.', icon: Workflow },
      { title: 'Configuramos o ambiente', description: 'Marca, permissões, credenciais e regras ficam ligadas à sua escola.', icon: LockKeyhole },
      { title: 'Evoluímos por etapas', description: 'A adoção acompanha sua operação sem misturar dados com outras instituições.', icon: Building2 },
    ],
    outcomes: ['Responsabilidades mais claras', 'Menos retrabalho entre áreas', 'Base segura para crescer com consistência'],
    boundaryEyebrow: 'Isolamento antes da personalização',
    boundaryTitle: 'Sua marca aparece. Os dados de outra escola, nunca.',
    boundaryDescription: 'Branding, integrações e credenciais pertencem ao tenant da escola. O acesso administrativo segue papéis e escopos, sem depender apenas da interface para proteger informações.',
    boundaryLabel: 'Solicitar demonstração',
    boundaryHref: 'PRIMARY',
    faq: [
      { question: 'É uma assinatura de autoatendimento?', answer: 'O plano institucional usa venda assistida para validar escopo, implantação e necessidades da escola antes da contratação.' },
      { question: 'Os dados ficam separados por escola?', answer: 'Sim. O sistema usa contexto de tenant, regras de acesso e políticas no banco para limitar leitura e escrita ao ambiente autorizado.' },
      { question: 'Consigo configurar a identidade da escola?', answer: 'A proposta inclui marca, identidade e configurações administrativas dentro do escopo liberado para o responsável da instituição.' },
      { question: 'Como credenciais de integrações são protegidas?', answer: 'Credenciais não devem ser expostas no navegador nem compartilhadas entre tenants. A configuração administrativa usa escopo de conta e processamento no servidor.' },
    ],
  },
};

const formatPrice = (value: number) => new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  maximumFractionDigits: 2,
}).format(value);

const HubSolutionLanding: React.FC<HubSolutionLandingProps> = ({ page, plans, settings, catalogReady = true, onAuthenticate, onPlanSelect }) => {
  const solution = SOLUTIONS[page];
  const Icon = solution.icon;
  const relevantPlans = plans.filter((plan) => solution.planCodes.includes(plan.code));
  const [billingCycle, setBillingCycle] = React.useState<HubBillingCycle>('YEARLY');
  const discoveryDays = Math.max(Number(plans.find((plan) => plan.code === 'DISCOVERY')?.trial_days || 0), 0);
  const hubCoreUnavailable = solution.primaryKind === 'AUTH' && !catalogReady;
  const discoveryAvailable = !hubCoreUnavailable && discoveryDays > 0;
  const assistedAccessUrl = resolveSystemAppUrl(settings.support_url, '/');
  const conversionHref = solution.primaryKind === 'WOLFIE'
    ? 'https://wolfie.wisewolflanguage.com.br/planos'
    : solution.primaryKind === 'SAAS'
      ? resolveSystemAppUrl(settings.saas_cta_url, '/new-saas')
      : undefined;
  const directPrimaryHref = conversionHref
    ?? (solution.primaryKind === 'AUTH' && !hubCoreUnavailable && !discoveryAvailable
      ? assistedAccessUrl
      : undefined);
  const loginHref = solution.primaryKind === 'WOLFIE'
    ? 'https://wolfie.wisewolflanguage.com.br/entrar?next=/app/praticar'
    : solution.primaryKind === 'SAAS'
      ? resolveSystemAppUrl('/')
      : undefined;
  const effectivePrimaryLabel = hubCoreUnavailable
    ? 'Abertura em breve'
    : solution.primaryKind === 'AUTH' && !discoveryAvailable
    ? 'Falar com a equipe'
    : solution.primaryLabel;

  const primaryAction = (planCode?: string, billingCycle: HubBillingCycle = 'MONTHLY') => {
    if (solution.primaryKind !== 'AUTH') return;
    if (hubCoreUnavailable) return;
    if (planCode) {
      onPlanSelect(planCode, billingCycle);
      onAuthenticate('signup', solution.audience);
      return;
    }
    if (!discoveryAvailable) return;
    onAuthenticate('signup', solution.audience);
  };

  const loginAction = () => {
    onAuthenticate('login', 'EDUCATOR');
  };

  const primaryCta = (label: string, className: string) => directPrimaryHref && !hubCoreUnavailable
    ? <a className={className} href={directPrimaryHref}>{label}<ArrowRight size={17} /></a>
    : <button type="button" disabled={hubCoreUnavailable} className={className} onClick={() => primaryAction()}>{label}<ArrowRight size={17} /></button>;

  const navItems = [
    { label: 'Produto', href: '#produto' },
    { label: 'Proposta', href: '#proposta' },
    { label: 'Como funciona', href: '#como-funciona' },
    { label: 'Planos', href: '#planos' },
  ];

  const nativeTourKind: HubNativeTourKind = page === 'educator-ai'
    ? 'educator'
    : page === 'school-os'
      ? 'school'
      : page;

  return (
    <HubMarketingShell
      navItems={navItems}
      onLogin={loginHref ? undefined : loginAction}
      onPrimary={directPrimaryHref ? undefined : () => primaryAction()}
      loginHref={loginHref}
      primaryHref={directPrimaryHref}
      primaryLabel={effectivePrimaryLabel}
      primaryDisabled={hubCoreUnavailable}
      accent={solution.accent}
      pageLabel={solution.name}
    >
      <section className="hub-solution-hero">
        <div className="hub-container hub-solution-hero__grid">
          <HubReveal className="hub-solution-hero__content">
            <a href={hubMarketingPath('overview')} className="hub-solution-hero__back"><ArrowLeft size={14} />Voltar ao ecossistema</a>
            <p className="hub-eyebrow"><span /><Icon size={13} />{solution.eyebrow}</p>
            <h1>{solution.title}<em>{` ${solution.emphasis}`}</em></h1>
            <p className="hub-solution-hero__description">{solution.description}</p>
            <div className="hub-solution-hero__actions">
              {primaryCta(effectivePrimaryLabel, 'hub-button hub-button--primary')}
              <a href="#proposta" className="hub-button hub-button--secondary">Ver como funciona</a>
            </div>
            <div className="hub-solution-hero__proof">{solution.proof.map((item) => <span key={item}><Check size={12} />{item}</span>)}</div>
          </HubReveal>
          <HubReveal className="hub-solution-hero__mockup" delay={0.12}>
            {HUB_PUBLIC_VIDEOS_ENABLED ? <HubVideoShowcase videoId={page} /> : <HubProductMockup kind={solution.mockup} />}
          </HubReveal>
        </div>
      </section>

      <section id="produto" className="hub-section hub-native-story-section">
        <div className="hub-container">
          <HubReveal>
            <HubSectionIntro
              eyebrow="Tour pela solução"
              title={<>Veja o módulo verdadeiro. <em>Não uma ilustração genérica.</em></>}
              description="As telas usam dados fictícios de demonstração, mas pertencem ao produto nativo que a assinatura abre para o usuário final."
            />
          </HubReveal>
          <HubNativeProductTour kind={nativeTourKind} />
        </div>
      </section>

      <section id="proposta" className="hub-section hub-section--quiet">
        <div className="hub-container">
          <HubReveal>
            <HubSectionIntro eyebrow="Da fricção ao fluxo" title={<>Tecnologia só faz sentido quando <em>deixa o trabalho mais claro.</em></>} description="A proposta não é adicionar outra tela à rotina, mas retirar o atrito que existe antes do resultado." />
          </HubReveal>
          <div className="hub-problem-grid">
            {solution.problems.map((item, index) => (
              <HubReveal key={item.before} delay={index * 0.06}>
                <article className="hub-problem-card">
                  <span className="hub-problem-card__index">{String(index + 1).padStart(2, '0')}</span>
                  <p className="hub-problem-card__before">{item.before}</p>
                  <div className="hub-problem-card__line" />
                  <h3>{item.after}</h3>
                </article>
              </HubReveal>
            ))}
          </div>
        </div>
      </section>

      <section id="como-funciona" className="hub-section">
        <div className="hub-container hub-steps-layout">
          <HubReveal className="hub-steps-layout__intro">
            <HubSectionIntro eyebrow="Como funciona" title={<>Uma sequência curta. <em>Um resultado concreto.</em></>} description="A interface esconde a complexidade técnica e mantém decisão, contexto e segurança visíveis para quem usa." />
            <div className="hub-security-note"><ShieldCheck size={18} />Conta, permissões e consumo permanecem ligados ao ambiente selecionado.</div>
          </HubReveal>
          <div className="hub-steps">
            {solution.steps.map(({ title, description, icon: StepIcon }, index) => (
              <HubReveal key={title} delay={index * 0.05}>
                <article className="hub-step">
                  <div className="hub-step__icon"><StepIcon size={22} /></div>
                  <div><span className="hub-step__number">ETAPA {String(index + 1).padStart(2, '0')}</span><h3>{title}</h3><p>{description}</p></div>
                </article>
              </HubReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="hub-section hub-section--dark">
        <div className="hub-container hub-student-boundary">
          <HubReveal>
            <p className="hub-eyebrow"><span />{solution.boundaryEyebrow}</p>
            <h2>{solution.boundaryTitle}</h2>
            <p>{solution.boundaryDescription}</p>
            {solution.boundaryHref === 'PORTAL'
              ? <a href={resolveSystemAppUrl('/')} className="hub-button hub-button--inverse">{solution.boundaryLabel}<ArrowRight size={16} /></a>
              : primaryCta(hubCoreUnavailable ? 'Abertura em breve' : solution.boundaryLabel, 'hub-button hub-button--inverse')}
          </HubReveal>
          <HubReveal className="hub-outcomes-card" delay={0.08}>
            <p>O que esta solução busca entregar</p>
            <ul>{solution.outcomes.map((outcome) => <li key={outcome}><span><Check size={11} /></span>{outcome}</li>)}</ul>
          </HubReveal>
        </div>
      </section>

      <section id="planos" className="hub-section hub-section--quiet">
        <div className="hub-container">
          <HubReveal className={`hub-solution-plan hub-solution-plan--${solution.primaryKind.toLowerCase()}`}>
            <div className="hub-solution-plan__intro">
              <p className="hub-eyebrow"><span />Contratação sem surpresa</p>
              <h2>{solution.primaryKind === 'SAAS' ? 'Um escopo alinhado à sua escola.' : solution.primaryKind === 'WOLFIE' ? 'Planos no ambiente próprio do Wolfie.' : 'Comece pela solução certa.'}</h2>
              <p>{solution.primaryKind === 'SAAS' ? 'A implantação institucional é assistida para validar equipe, integrações, permissões e contexto antes da contratação.' : solution.primaryKind === 'WOLFIE' ? 'A assinatura individual permanece separada da conta escolar e do acesso institucional.' : hubCoreUnavailable ? 'Catálogo em curadoria · abertura em breve. Assinaturas e teste permanecem fechados até a publicação do acervo validado.' : discoveryAvailable ? `${discoveryDays} dias de descoberta sem cartão. A cobrança só libera acesso após confirmação do Asaas.` : 'Os planos pagos continuam disponíveis em contratação direta. O acesso só é liberado depois da confirmação da cobrança.'}</p>
              {solution.primaryKind === 'AUTH' && (
                <div className="hub-billing-toggle hub-solution-plan__toggle" aria-label="Ciclo de cobrança desta solução">
                  <button type="button" aria-pressed={billingCycle === 'MONTHLY'} className={billingCycle === 'MONTHLY' ? 'is-active' : ''} onClick={() => setBillingCycle('MONTHLY')}>Mensal</button>
                  <button type="button" aria-pressed={billingCycle === 'YEARLY'} className={billingCycle === 'YEARLY' ? 'is-active' : ''} onClick={() => setBillingCycle('YEARLY')}>Anual<small>melhor valor</small></button>
                </div>
              )}
            </div>
            <div className={`hub-solution-plan__cards ${relevantPlans.length <= 1 && solution.primaryKind === 'AUTH' ? 'is-single' : ''}`}>
              {solution.primaryKind === 'AUTH' && relevantPlans.map((plan) => {
                const monthly = Number(plan.price_monthly || 0);
                const yearly = Number(plan.price_yearly || 0);
                const annualEquivalent = yearly > 0 ? yearly / 12 : monthly;
                const shownPrice = billingCycle === 'YEARLY' ? annualEquivalent : monthly;
                return (
                  <article key={plan.id} className={`hub-solution-plan-card ${plan.metadata?.popular === true ? 'is-featured' : ''}`}>
                    {plan.metadata?.popular === true && <span className="hub-solution-plan-card__badge">Recomendado</span>}
                    <span className="hub-solution-plan-card__name">{plan.name}</span>
                    <div className="hub-solution-plan-card__price">R$ {formatPrice(shownPrice)}<small>/mês</small></div>
                    <p>{plan.description || 'Plano Wise Wolf para esta solução.'} {billingCycle === 'YEARLY' && yearly > 0 ? `Total anual de R$ ${formatPrice(yearly)}.` : 'Cobrança recorrente mensal.'}</p>
                    <ul>{(plan.features || []).map((feature) => <li key={feature}><Check size={13} />{feature}</li>)}</ul>
                    <button type="button" disabled={hubCoreUnavailable} className={`hub-button ${plan.metadata?.popular === true ? 'hub-button--primary' : 'hub-button--secondary'}`} onClick={() => primaryAction(plan.code, billingCycle)}>{hubCoreUnavailable ? 'Abertura em breve' : `Escolher ${plan.name}`}<ArrowRight size={15} /></button>
                  </article>
                );
              })}
              {solution.primaryKind === 'WOLFIE' && WOLFIE_STANDALONE_PLANS.map((plan) => (
                <article key={plan.code} className={`hub-solution-plan-card ${plan.recommended ? 'is-featured' : ''}`}>
                  {plan.recommended && <span className="hub-solution-plan-card__badge">Recomendado</span>}
                  <span className="hub-solution-plan-card__name">Wolfie {plan.name}</span>
                  <div className="hub-solution-plan-card__price">R$ {formatPrice(plan.monthlyPrice)}<small>/mês</small></div>
                  <p>{plan.tagline}</p>
                  <ul>{plan.features.map((feature) => <li key={feature}><Check size={13} />{feature}</li>)}</ul>
                  <a className={`hub-button ${plan.recommended ? 'hub-button--primary' : 'hub-button--secondary'}`} href={`https://wolfie.wisewolflanguage.com.br${wolfieSubscribeHref(plan.code)}`}>{plan.cta}<ArrowRight size={15} /></a>
                </article>
              ))}
              {solution.primaryKind === 'SAAS' && (
                <article className="hub-solution-plan-card hub-solution-plan-card--assisted">
                  <span className="hub-solution-plan-card__name">Wise Wolf School OS</span>
                  <div className="hub-solution-plan-card__price">Sob medida</div>
                  <p>A proposta é formada depois do diagnóstico. Não usamos um preço legado de ferramentas pedagógicas para representar a operação completa da escola.</p>
                  <ul>
                    <li><Check size={13} />Unidades, equipe e papéis necessários</li>
                    <li><Check size={13} />Módulos e automações do escopo</li>
                    <li><Check size={13} />Migração, integrações e implantação</li>
                    <li><Check size={13} />Branding, segurança e governança</li>
                  </ul>
                  <a className="hub-button hub-button--primary" href={conversionHref}>Solicitar diagnóstico<ArrowRight size={15} /></a>
                </article>
              )}
            </div>
          </HubReveal>
        </div>
      </section>

      <HubFaq items={solution.faq} />

      <section className="hub-final-cta">
        <div className="hub-container hub-final-cta__panel">
          <div className="hub-final-cta__content">
            <span>{solution.name}</span>
            <h2>Menos atrito. <em>Mais clareza para avançar.</em></h2>
            <p>{solution.description}</p>
            {primaryCta(effectivePrimaryLabel, 'hub-button hub-button--inverse')}
          </div>
        </div>
      </section>
    </HubMarketingShell>
  );
};

export default HubSolutionLanding;
