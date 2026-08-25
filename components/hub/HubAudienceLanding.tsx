import React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  BriefcaseBusiness,
  Building2,
  CalendarCheck2,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDollarSign,
  ClipboardCheck,
  GraduationCap,
  Handshake,
  Layers3,
  LineChart,
  LockKeyhole,
  MessagesSquare,
  Palette,
  Route,
  Settings2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Workflow,
} from 'lucide-react';
import HubMarketingShell, {
  HubFaq,
  HubReveal,
  HubSectionIntro,
  type HubMarketingNavItem,
} from './HubMarketingShell';
import HubPricingSection from './HubPricingSection';
import HubNativeProductTour from './HubNativeProductTour';
import HubProductMockup, { type HubMockupKind } from './HubProductMockups';
import { isHubCorePlan } from './hubService';
import { hubMarketingPath, resolveSystemAppUrl } from './hubRoutes';
import type { HubAudience, HubBillingCycle, HubPlan, HubSettings } from './types';
import './hub-audience.css';

export type HubCommercialAudience = 'teachers' | 'schools';

export interface HubAudienceLandingProps {
  audience: HubCommercialAudience;
  plans: HubPlan[];
  settings: HubSettings;
  catalogReady?: boolean;
  onAuthenticate: (mode: 'login' | 'signup', audience?: HubAudience) => void;
  onPlanSelect: (planCode: string, billingCycle: HubBillingCycle) => void;
}

type JourneyStep = {
  label: string;
  title: string;
  description: string;
  marker: string;
  icon: React.ElementType;
};

type OfferCard = {
  eyebrow: string;
  title: string;
  description: string;
  href?: string;
  link?: string;
  icon: React.ElementType;
  details: string[];
  tone: string;
};

const TEACHER_JOURNEY: JourneyStep[] = [
  {
    label: 'Ensinar',
    title: 'Prepare com direção',
    description: 'Encontre materiais e transforme um objetivo real em uma sequência estruturada para adaptar.',
    marker: 'Hub pedagógico',
    icon: BookOpen,
  },
  {
    label: 'Engajar',
    title: 'Continue entre encontros',
    description: 'Explore situações contextualizadas e transforme a prática individual em repertório para suas aulas.',
    marker: 'Hub completo',
    icon: Bot,
  },
  {
    label: 'Crescer',
    title: 'Cuide das oportunidades',
    description: 'Organize contatos, aulas experimentais e matrículas quando a atuação já pedir estrutura.',
    marker: 'Implantação assistida',
    icon: LineChart,
  },
  {
    label: 'Operar',
    title: 'Tire a rotina da memória',
    description: 'Centralize agenda, acordos, cobranças e visão dos alunos em um ambiente configurado.',
    marker: 'Professor Negócio',
    icon: BriefcaseBusiness,
  },
];

const SCHOOL_JOURNEY: JourneyStep[] = [
  {
    label: 'Atrair',
    title: 'Dê contexto ao comercial',
    description: 'Acompanhe oportunidades sem perder a origem e o próximo passo de cada contato.',
    marker: 'Growth',
    icon: LineChart,
  },
  {
    label: 'Matricular',
    title: 'Conecte a entrada do aluno',
    description: 'Aula experimental, proposta, matrícula e primeiros acessos seguem o mesmo contexto.',
    marker: 'Growth + Backoffice',
    icon: Handshake,
  },
  {
    label: 'Entregar',
    title: 'Coordene a experiência',
    description: 'Direção, professores e alunos enxergam o que precisam para a rotina pedagógica.',
    marker: 'School Delivery',
    icon: GraduationCap,
  },
  {
    label: 'Evoluir',
    title: 'Decida com a operação visível',
    description: 'Agenda, equipe, contratos e financeiro deixam de formar versões diferentes da escola.',
    marker: 'Backoffice',
    icon: Route,
  },
];

const TEACHER_OFFERS: OfferCard[] = [
  {
    eyebrow: 'Escolha melhor',
    title: 'Wise Wolf Library',
    description: 'Um acervo licenciado e navegável para reduzir a busca antes da aula.',
    href: hubMarketingPath('library'),
    link: 'Explorar Biblioteca',
    icon: BookOpen,
    details: ['Curadoria por nível e contexto', 'Prévia antes do conteúdo completo', 'Uso individual conforme o plano'],
    tone: '#d66a45',
  },
  {
    eyebrow: 'Planeje melhor',
    title: 'Educador IA',
    description: 'Objetivo, duração e realidade do aluno entram antes da atividade.',
    href: hubMarketingPath('educator-ai'),
    link: 'Conhecer Educador IA',
    icon: Sparkles,
    details: ['Sequência pronta para adaptar', 'Objetivo, duração e contexto', 'Gerações controladas por plano'],
    tone: '#7652ed',
  },
  {
    eyebrow: 'Pratique melhor',
    title: 'Wolfie',
    description: 'Um estúdio individual para o professor explorar situações, linguagem e níveis dentro do Hub.',
    href: hubMarketingPath('wolfie'),
    link: 'Ver experiência Wolfie',
    icon: Bot,
    details: ['Cenários ligados ao objetivo', 'Interação guiada por texto', 'Uso individual no Professor Studio'],
    tone: '#20a9cc',
  },
];

const SCHOOL_MODULES: OfferCard[] = [
  {
    eyebrow: 'Experiência educacional',
    title: 'School Delivery',
    description: 'A estrutura para coordenar o que a escola promete e o que o aluno recebe.',
    icon: GraduationCap,
    details: ['Agenda e rotina de aulas', 'Contexto de alunos e professores', 'Portais e acompanhamento pedagógico'],
    tone: '#7652ed',
  },
  {
    eyebrow: 'Jornada comercial',
    title: 'Growth',
    description: 'O caminho do primeiro contato à matrícula com responsáveis e próximos passos visíveis.',
    icon: LineChart,
    details: ['Oportunidades e acompanhamento', 'Aulas experimentais no fluxo', 'Conversão conectada à matrícula'],
    tone: '#d66a45',
  },
  {
    eyebrow: 'Gestão da escola',
    title: 'Backoffice',
    description: 'Operação administrativa configurada para a realidade, a marca e a equipe da escola.',
    icon: Building2,
    details: ['Contratos e visão financeira', 'Papéis e permissões da equipe', 'Branding e configuração por tenant'],
    tone: '#258e79',
  },
];

const TEACHER_FAQ = [
  {
    question: 'Os planos para professores incluem a gestão completa do negócio?',
    answer: 'Não. Os planos públicos do Hub são ferramentas pedagógicas. A operação de agenda, comercial, contratos e financeiro entra no Professor Negócio, com diagnóstico e implantação assistida.',
  },
  {
    question: 'O teste pede cartão?',
    answer: 'Não. Quando a experiência de descoberta está ativa, a conta pode ser criada sem cartão. Uma assinatura paga só libera acesso depois da confirmação da cobrança.',
  },
  {
    question: 'Posso começar apenas pela Biblioteca?',
    answer: 'Sim. Os planos foram organizados para permitir uma entrada menor e a evolução para IA e Wolfie conforme a rotina pedir.',
  },
  {
    question: 'A inteligência artificial substitui meu planejamento?',
    answer: 'Não. Ela cria uma base estruturada. A escolha da abordagem, a adaptação ao aluno e a condução da aula continuam com o professor.',
  },
  {
    question: 'Como conheço o Professor Negócio?',
    answer: 'A equipe primeiro entende sua carteira de alunos e sua rotina. Depois apresenta o ambiente e define um escopo de implantação, sem misturar essa contratação com os planos pedagógicos.',
  },
];

const SCHOOL_FAQ = [
  {
    question: 'Existe um preço único para qualquer escola?',
    answer: 'Não publicamos um valor genérico porque equipe, alunos, módulos, integrações e implantação mudam o escopo. O diagnóstico vem antes da proposta.',
  },
  {
    question: 'Preciso trocar toda a operação de uma vez?',
    answer: 'Não. A implantação é organizada por etapas, priorizando os fluxos que hoje causam mais retrabalho ou risco para a escola.',
  },
  {
    question: 'Os dados de uma escola podem aparecer para outra?',
    answer: 'O produto foi estruturado com contexto de tenant, vínculos de conta, papéis e políticas de acesso para manter cada instituição em seu próprio ambiente.',
  },
  {
    question: 'A escola pode configurar sua própria identidade?',
    answer: 'Sim, dentro do escopo habilitado. Branding, responsáveis, permissões e credenciais pertencem ao ambiente da instituição e não são compartilhados entre tenants.',
  },
  {
    question: 'O que acontece no diagnóstico?',
    answer: 'A equipe percorre a jornada comercial, pedagógica e administrativa, identifica prioridades e demonstra apenas os módulos relevantes para a operação analisada.',
  },
];

const AudienceJourney: React.FC<{
  audience: HubCommercialAudience;
  steps: JourneyStep[];
}> = ({ audience, steps }) => (
  <ol className="hub-audience-journey" aria-label={audience === 'teachers' ? 'Ciclo do professor' : 'Ciclo da escola'}>
    {steps.map(({ label, title, description, marker, icon: Icon }, index) => (
      <HubReveal as="li" key={label} delay={index * 0.06} className="hub-audience-journey__step">
          <div className="hub-audience-journey__rail" aria-hidden="true">
            <span>{String(index + 1).padStart(2, '0')}</span>
          </div>
          <div className="hub-audience-journey__icon"><Icon size={21} /></div>
          <p className="hub-audience-journey__label">{label}</p>
          <h3>{title}</h3>
          <p className="hub-audience-journey__description">{description}</p>
          <span className="hub-audience-journey__marker">{marker}</span>
      </HubReveal>
    ))}
  </ol>
);

const OfferGrid: React.FC<{ items: OfferCard[]; ariaLabel: string }> = ({ items, ariaLabel }) => (
  <div className="hub-audience-offer-grid" aria-label={ariaLabel}>
    {items.map(({ eyebrow, title, description, href, link, icon: Icon, details, tone }, index) => (
      <HubReveal key={title} delay={index * 0.06}>
        <article className="hub-audience-offer-card" style={{ '--audience-card-tone': tone } as React.CSSProperties}>
          <div className="hub-audience-offer-card__top">
            <span className="hub-audience-offer-card__icon"><Icon size={23} /></span>
            <span className="hub-audience-offer-card__number">{String(index + 1).padStart(2, '0')}</span>
          </div>
          <p className="hub-audience-offer-card__eyebrow">{eyebrow}</p>
          <h3>{title}</h3>
          <p className="hub-audience-offer-card__description">{description}</p>
          <ul>{details.map((detail) => <li key={detail}><Check size={12} />{detail}</li>)}</ul>
          {href && link && <a href={href}>{link}<ArrowRight size={15} /></a>}
        </article>
      </HubReveal>
    ))}
  </div>
);

const TeacherLanding: React.FC<Omit<HubAudienceLandingProps, 'audience'>> = ({
  plans,
  settings,
  catalogReady = true,
  onAuthenticate,
  onPlanSelect,
}) => {
  const hubPlans = plans.filter(isHubCorePlan);
  const discoveryDays = Math.max(Number(hubPlans.find((plan) => plan.code === 'DISCOVERY')?.trial_days || 0), 0);
  const discoveryAvailable = catalogReady && discoveryDays > 0;
  const discoveryCtaLabel = !catalogReady ? 'Abertura em breve' : discoveryAvailable ? 'Preparar minha próxima aula grátis' : 'Falar com a equipe';
  const assistedUrl = resolveSystemAppUrl('/seja-professor');
  const supportUrl = resolveSystemAppUrl(settings.support_url, '/');
  const directDiscoveryHref = catalogReady && !discoveryAvailable ? supportUrl : undefined;

  const beginDiscovery = () => {
    if (!catalogReady) return;
    if (discoveryAvailable) {
      onAuthenticate('signup', 'EDUCATOR');
      return;
    }
  };

  const discoveryCta = (className: string) => directDiscoveryHref
    ? <a className={className} href={directDiscoveryHref}>{discoveryCtaLabel}<ArrowRight size={17} /></a>
    : <button type="button" disabled={!catalogReady} className={className} onClick={beginDiscovery}>{discoveryCtaLabel}<ArrowRight size={17} /></button>;

  const choosePlan = (plan: HubPlan, billingCycle: HubBillingCycle) => {
    if (!catalogReady) return;
    onPlanSelect(plan.code, billingCycle);
    onAuthenticate('signup', 'EDUCATOR');
  };

  const navItems: HubMarketingNavItem[] = [
    { label: 'Jornada', href: '#jornada' },
    { label: 'Ferramentas', href: '#ferramentas' },
    { label: 'Tour', href: '#tour-nativo' },
    { label: 'Professor Negócio', href: '#professor-negocio' },
    { label: 'Planos', href: '#planos' },
  ];

  return (
    <HubMarketingShell
      navItems={navItems}
      onLogin={() => onAuthenticate('login', 'EDUCATOR')}
      onPrimary={directDiscoveryHref ? undefined : beginDiscovery}
      primaryHref={directDiscoveryHref}
      primaryLabel={discoveryCtaLabel}
      primaryDisabled={!catalogReady}
      accent="#7652ed"
      pageLabel="Para professores"
    >
      <div className="hub-audience-page" data-audience="teachers">
        <section className="hub-audience-hero">
          <div className="hub-container hub-audience-hero__grid">
            <HubReveal className="hub-audience-hero__content">
              <a href={hubMarketingPath('overview')} className="hub-audience-back"><ArrowLeft size={14} />Voltar ao Hub</a>
              <p className="hub-eyebrow"><span />Ecossistema para professores de inglês</p>
              <h1>Mais intenção na aula. <em>Mais estrutura para crescer.</em></h1>
              <p className="hub-audience-hero__description">Prepare, ensine e mantenha o aluno em movimento com ferramentas que entram na sua rotina — e evolua para uma operação de negócio quando chegar a hora.</p>
              <div className="hub-audience-hero__actions">
                {discoveryCta('hub-button hub-button--primary')}
                <a className="hub-button hub-button--secondary" href="#jornada">Ver a jornada</a>
              </div>
              <div className="hub-audience-hero__proof">
                {discoveryAvailable && <span><CircleCheck size={13} />{discoveryDays} dias de descoberta</span>}
                {discoveryAvailable && <span><CircleCheck size={13} />Sem cartão</span>}
                <span><ShieldCheck size={13} />Conta individual protegida</span>
              </div>
            </HubReveal>

            <HubReveal className="hub-audience-hero__visual" delay={0.12} direction="scale">
              <div className="hub-audience-hero__visual-head">
                <span>Próxima aula</span>
                <em>Objetivo → plano → continuidade</em>
              </div>
              <HubProductMockup kind="educator" />
              <div className="hub-audience-hero__floating-card is-teacher">
                <span><Bot size={17} /></span>
                <div><b>Estúdio individual</b><small>Explore situações por texto no seu nível</small></div>
              </div>
            </HubReveal>
          </div>
        </section>

        <section className="hub-audience-proof-strip" aria-label="Pilares da experiência para professores">
          <div className="hub-container">
            <span><BookOpen size={16} /><b>Material com curadoria</b></span>
            <span><Sparkles size={16} /><b>IA com contexto pedagógico</b></span>
            <span><Bot size={16} /><b>Prática além da aula</b></span>
            <span><BriefcaseBusiness size={16} /><b>Caminho para profissionalizar</b></span>
          </div>
        </section>

        <section id="jornada" className="hub-section hub-audience-journey-section">
          <div className="hub-container">
            <HubReveal>
              <HubSectionIntro
                eyebrow="A jornada inteira"
                title={<>Comece pela aula. <em>Estruture o negócio no seu ritmo.</em></>}
                description="As ferramentas pedagógicas têm contratação direta. Crescimento e operação entram em uma implantação separada, quando sua carteira de alunos pedir mais estrutura."
              />
            </HubReveal>
            <AudienceJourney audience="teachers" steps={TEACHER_JOURNEY} />
          </div>
        </section>

        <section id="ferramentas" className="hub-section hub-section--quiet hub-audience-offers-section">
          <div className="hub-container">
            <HubReveal>
              <HubSectionIntro
                eyebrow="Ferramentas pedagógicas"
                title={<>Uma preparação mais curta. <em>Uma experiência mais contínua.</em></>}
                description="Cada solução resolve uma parte concreta da rotina e mantém claro o que está incluído em cada plano."
                align="center"
              />
            </HubReveal>
            <OfferGrid items={TEACHER_OFFERS} ariaLabel="Ferramentas para professores" />
          </div>
        </section>

        <section className="hub-section hub-audience-product-story">
          <div className="hub-container hub-audience-product-story__grid">
            <HubReveal className="hub-audience-product-story__copy">
              <p className="hub-eyebrow"><span />Da ideia à continuidade</p>
              <h2>O aluno percebe uma jornada. <em>Você mantém a autoria.</em></h2>
              <p>A Biblioteca acelera a escolha, o Educador IA estrutura uma primeira versão e o Wolfie amplia o contato com o inglês. O professor continua decidindo como adaptar, conduzir e acompanhar.</p>
              <div className="hub-audience-product-story__sequence">
                <span><BookOpen size={16} />Escolher</span><ChevronRight size={15} />
                <span><Sparkles size={16} />Planejar</span><ChevronRight size={15} />
                <span><GraduationCap size={16} />Ensinar</span><ChevronRight size={15} />
                <span><Bot size={16} />Praticar</span>
              </div>
              <a href={hubMarketingPath('educator-ai')} className="hub-audience-text-link">Ver o Educador IA em detalhe<ArrowRight size={15} /></a>
            </HubReveal>
            <HubReveal className="hub-audience-product-story__visual" delay={0.08} direction="right">
              <HubProductMockup kind="library" />
            </HubReveal>
          </div>
        </section>

        <section id="tour-nativo" className="hub-section hub-native-story-section">
          <div className="hub-container">
            <HubReveal>
              <HubSectionIntro
                eyebrow="Tour nativo do professor"
                title={<>Escolha. Planeje. Continue. <em>Dentro dos módulos reais.</em></>}
                description="As telas abaixo pertencem à plataforma que o Hub abre por assinatura. Os dados são fictícios; a interface e os fluxos são nativos."
              />
            </HubReveal>
            <HubNativeProductTour kind="teacher" />
          </div>
        </section>

        <section id="professor-negocio" className="hub-audience-assisted">
          <div className="hub-container hub-audience-assisted__panel">
            <HubReveal className="hub-audience-assisted__copy">
              <p className="hub-eyebrow"><span />Professor Negócio</p>
              <h2>Quando ensinar bem já não basta para <em>operar sozinho.</em></h2>
              <p>Para professores com uma carteira ativa de alunos, configuramos um ambiente de operação com agenda, acompanhamento comercial, contratos e visão financeira. O escopo é definido em conversa — não faz parte automaticamente dos planos pedagógicos.</p>
              <div className="hub-audience-assisted__capabilities">
                <span><CalendarCheck2 size={15} />Agenda e rotina</span>
                <span><Handshake size={15} />Oportunidades e matrículas</span>
                <span><CircleDollarSign size={15} />Contratos e financeiro</span>
              </div>
              <a className="hub-button hub-button--inverse" href={assistedUrl}>Conhecer o Professor Negócio<ArrowRight size={16} /></a>
            </HubReveal>
            <HubReveal className="hub-audience-assisted__visual" delay={0.08} direction="scale">
              <HubProductMockup kind="school" />
              <span className="hub-audience-assisted__badge"><Settings2 size={14} />Implantação assistida</span>
            </HubReveal>
          </div>
        </section>

        <HubPricingSection plans={hubPlans} onChoosePlan={choosePlan} catalogReady={catalogReady} />

        <HubFaq items={TEACHER_FAQ} eyebrow="Antes de começar" title="Dúvidas de quem ensina e também empreende" />

        <section className="hub-audience-final">
          <div className="hub-container hub-audience-final__panel">
            <HubReveal>
              <span className="hub-audience-final__eyebrow">Sua próxima aula é um bom começo</span>
              <h2>Entre com um objetivo. <em>Saia com um caminho.</em></h2>
              <p>{discoveryAvailable ? `Experimente por ${discoveryDays} dias, sem cartão, e veja como as ferramentas entram na sua preparação real.` : 'Converse com a equipe para validar a melhor entrada para sua rotina.'}</p>
              {discoveryCta('hub-button hub-button--primary')}
            </HubReveal>
          </div>
        </section>
      </div>
    </HubMarketingShell>
  );
};

const SchoolLanding: React.FC<Omit<HubAudienceLandingProps, 'audience'>> = ({ settings }) => {
  const assistedUrl = resolveSystemAppUrl(settings.saas_cta_url, '/new-saas');

  const navItems: HubMarketingNavItem[] = [
    { label: 'Jornada', href: '#jornada' },
    { label: 'Módulos', href: '#modulos' },
    { label: 'Tour', href: '#tour-nativo' },
    { label: 'Preço', href: '#planos' },
    { label: 'Implantação', href: '#implantacao' },
  ];

  return (
    <HubMarketingShell
      navItems={navItems}
      loginHref={resolveSystemAppUrl('/')}
      primaryHref={assistedUrl}
      primaryLabel="Solicitar diagnóstico"
      accent="#258e79"
      pageLabel="Para escolas"
    >
      <div className="hub-audience-page" data-audience="schools">
        <section className="hub-audience-hero">
          <div className="hub-container hub-audience-hero__grid">
            <HubReveal className="hub-audience-hero__content">
              <a href={hubMarketingPath('overview')} className="hub-audience-back"><ArrowLeft size={14} />Voltar ao Hub</a>
              <p className="hub-eyebrow"><span />Sistema para escolas de inglês</p>
              <h1>Sua escola inteira, <em>na mesma operação.</em></h1>
              <p className="hub-audience-hero__description">Conecte a jornada comercial, a entrega pedagógica e o backoffice em um ambiente configurado para sua marca, sua equipe e suas responsabilidades.</p>
              <div className="hub-audience-hero__actions">
                <a className="hub-button hub-button--primary" href={assistedUrl}>Solicitar diagnóstico da escola<ArrowRight size={17} /></a>
                <a className="hub-button hub-button--secondary" href="#modulos">Fazer um tour pelos módulos</a>
              </div>
              <div className="hub-audience-hero__proof">
                <span><CircleCheck size={13} />Diagnóstico antes da proposta</span>
                <span><ShieldCheck size={13} />Ambiente separado por escola</span>
                <span><Settings2 size={13} />Implantação assistida</span>
              </div>
            </HubReveal>

            <HubReveal className="hub-audience-hero__visual" delay={0.12} direction="scale">
              <div className="hub-audience-hero__visual-head">
                <span>Visão da direção</span>
                <em>Comercial + entrega + gestão</em>
              </div>
              <HubProductMockup kind="school" />
              <div className="hub-audience-hero__floating-card is-school">
                <span><ShieldCheck size={17} /></span>
                <div><b>Contexto da escola</b><small>Marca, equipe e acessos no tenant certo</small></div>
              </div>
            </HubReveal>
          </div>
        </section>

        <section className="hub-audience-proof-strip" aria-label="Pilares do sistema para escolas">
          <div className="hub-container">
            <span><Workflow size={16} /><b>Fluxos conectados</b></span>
            <span><UsersRound size={16} /><b>Papéis por responsabilidade</b></span>
            <span><Palette size={16} /><b>Identidade da escola</b></span>
            <span><LockKeyhole size={16} /><b>Contexto separado por tenant</b></span>
          </div>
        </section>

        <section id="jornada" className="hub-section hub-audience-journey-section">
          <div className="hub-container">
            <HubReveal>
              <HubSectionIntro
                eyebrow="Uma jornada, três áreas"
                title={<>Do primeiro contato à gestão. <em>Sem perder o contexto.</em></>}
                description="A clareza vem antes da quantidade de recursos: cada módulo existe para sustentar uma etapa real da escola."
              />
            </HubReveal>
            <AudienceJourney audience="schools" steps={SCHOOL_JOURNEY} />
          </div>
        </section>

        <section id="modulos" className="hub-section hub-section--quiet hub-audience-offers-section">
          <div className="hub-container">
            <HubReveal>
              <HubSectionIntro
                eyebrow="Arquitetura da solução"
                title={<>Três blocos para uma escola <em>que funciona como sistema.</em></>}
                description="O diagnóstico define quais módulos entram primeiro. A proposta acompanha o tamanho e as prioridades da operação."
                align="center"
              />
            </HubReveal>
            <OfferGrid items={SCHOOL_MODULES} ariaLabel="Módulos para escolas" />
            <div className="hub-audience-modules-link">
              <a href={hubMarketingPath('school-os')} className="hub-audience-text-link">Ver o sistema escolar em detalhe<ArrowRight size={15} /></a>
            </div>
          </div>
        </section>

        <section id="tour-nativo" className="hub-section hub-native-story-section">
          <div className="hub-container">
            <HubReveal>
              <HubSectionIntro
                eyebrow="Tour nativo da escola"
                title={<>Comercial, agenda, direção e marca. <em>Uma operação visível.</em></>}
                description="Role para percorrer telas reais do School OS em ambiente de demonstração, sem dados de clientes."
              />
            </HubReveal>
            <HubNativeProductTour kind="school" />
          </div>
        </section>

        <section className="hub-section hub-audience-product-story">
          <div className="hub-container hub-audience-product-story__grid is-school">
            <HubReveal className="hub-audience-product-story__visual" direction="left">
              <HubProductMockup kind="school" />
            </HubReveal>
            <HubReveal className="hub-audience-product-story__copy" delay={0.08}>
              <p className="hub-eyebrow"><span />Uma fonte de contexto</p>
              <h2>Informação no lugar certo. <em>Acesso na medida certa.</em></h2>
              <p>A direção enxerga a operação; cada pessoa acessa o que sua função exige. Branding, configurações e credenciais permanecem ligados ao ambiente da escola.</p>
              <div className="hub-audience-control-list">
                <article><span><UsersRound size={17} /></span><div><b>Papéis claros</b><small>Equipe com acesso coerente à responsabilidade.</small></div></article>
                <article><span><Building2 size={17} /></span><div><b>Tenant da escola</b><small>Dados e configurações pertencem à instituição correta.</small></div></article>
                <article><span><ShieldCheck size={17} /></span><div><b>Proteção além da interface</b><small>Regras de acesso também são aplicadas no banco.</small></div></article>
              </div>
            </HubReveal>
          </div>
        </section>

        <section id="implantacao" className="hub-section hub-audience-rollout-section">
          <div className="hub-container hub-audience-rollout">
            <HubReveal className="hub-audience-rollout__intro">
              <HubSectionIntro
                eyebrow="Implantação assistida"
                title={<>A proposta nasce do diagnóstico, <em>não de uma tabela genérica.</em></>}
                description="Mapeamos a operação atual, demonstramos o que realmente se aplica e organizamos uma entrada por etapas."
              />
              <a className="hub-button hub-button--primary" href={assistedUrl}>Solicitar diagnóstico<ArrowRight size={16} /></a>
            </HubReveal>
            <div className="hub-audience-rollout__steps">
              {[
                { number: '01', icon: ClipboardCheck, title: 'Diagnóstico', description: 'Percorremos os fluxos comercial, pedagógico e administrativo com a direção.' },
                { number: '02', icon: Layers3, title: 'Tour orientado', description: 'Mostramos os módulos ligados às prioridades encontradas, sem uma demonstração genérica.' },
                { number: '03', icon: Settings2, title: 'Escopo e implantação', description: 'Definimos ambiente, acessos, configurações e uma sequência segura de adoção.' },
              ].map(({ number, icon: Icon, title, description }, index) => (
                <HubReveal key={number} delay={index * 0.06}>
                  <article>
                    <span className="hub-audience-rollout__number">{number}</span>
                    <span className="hub-audience-rollout__icon"><Icon size={21} /></span>
                    <div><h3>{title}</h3><p>{description}</p></div>
                  </article>
                </HubReveal>
              ))}
            </div>
          </div>
        </section>

        <section id="planos" className="hub-section hub-section--quiet hub-school-pricing-section">
          <div className="hub-container">
            <HubReveal>
              <HubSectionIntro
                eyebrow="Preço do School OS"
                title={<>Sob medida não precisa ser <em>sem critério.</em></>}
                description="A proposta mostra exatamente quais fatores formam o escopo. O plano Institucional legado do Hub pedagógico não é usado como preço do sistema escolar completo."
              />
            </HubReveal>
            <div className="hub-school-pricing">
              <HubReveal className="hub-school-pricing__summary" direction="scale">
                <span>School OS</span>
                <strong>Proposta após diagnóstico</strong>
                <p>Você recebe módulos, implantação, responsabilidades e condições definidos antes de decidir.</p>
                <a className="hub-button hub-button--primary" href={assistedUrl}>Solicitar diagnóstico<ArrowRight size={16} /></a>
              </HubReveal>
              <div className="hub-school-pricing__factors">
                {[
                  { icon: Building2, title: 'Estrutura da escola', text: 'Unidades, alunos, equipe e papéis necessários.' },
                  { icon: Layers3, title: 'Módulos do escopo', text: 'Comercial, pedagógico, backoffice e automações escolhidas.' },
                  { icon: Workflow, title: 'Migração e integrações', text: 'Dados existentes, conexões e regras operacionais.' },
                  { icon: ShieldCheck, title: 'Implantação segura', text: 'Tenant, acessos, branding, treinamento e entrada por etapas.' },
                ].map(({ icon: FactorIcon, title, text }, index) => (
                  <HubReveal key={title} delay={index * 0.05}>
                    <article><span><FactorIcon size={19} /></span><div><b>{title}</b><small>{text}</small></div></article>
                  </HubReveal>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="hub-audience-assisted is-school">
          <div className="hub-container hub-audience-assisted__panel">
            <HubReveal className="hub-audience-assisted__copy">
              <p className="hub-eyebrow"><span />Venda assistida</p>
              <h2>Uma proposta coerente com <em>a escola que você opera.</em></h2>
              <p>Quantidade de alunos, equipe, módulos e integrações mudam o escopo. Por isso, a contratação institucional começa por uma conversa e termina com uma implantação definida.</p>
              <div className="hub-audience-assisted__capabilities">
                <span><MessagesSquare size={15} />Diagnóstico com a direção</span>
                <span><Workflow size={15} />Prioridades por fluxo</span>
                <span><ShieldCheck size={15} />Escopo por tenant desde a configuração</span>
              </div>
              <a className="hub-button hub-button--inverse" href={assistedUrl}>Agendar diagnóstico e tour<ArrowRight size={16} /></a>
            </HubReveal>
            <HubReveal className="hub-audience-assisted__commercial" delay={0.08} direction="scale">
              <p>O que você recebe antes de decidir</p>
              <ul>
                <li><span>01</span><div><b>Leitura da operação atual</b><small>Gargalos, riscos e prioridades.</small></div></li>
                <li><span>02</span><div><b>Tour com contexto</b><small>Módulos aplicados ao cenário da escola.</small></div></li>
                <li><span>03</span><div><b>Escopo de implantação</b><small>Etapas, acessos e responsabilidades.</small></div></li>
              </ul>
              <div><LockKeyhole size={15} />Nenhum dado real é necessário para a primeira conversa.</div>
            </HubReveal>
          </div>
        </section>

        <HubFaq items={SCHOOL_FAQ} eyebrow="Antes da demonstração" title="Dúvidas de quem dirige uma escola" />

        <section className="hub-audience-final">
          <div className="hub-container hub-audience-final__panel">
            <HubReveal>
              <span className="hub-audience-final__eyebrow">Clareza antes da contratação</span>
              <h2>Vamos percorrer sua escola <em>como uma jornada.</em></h2>
              <p>Mostre onde a operação perde contexto. A demonstração parte desses pontos e apresenta um caminho de implantação possível.</p>
              <a className="hub-button hub-button--primary" href={assistedUrl}>Solicitar diagnóstico da escola<ArrowRight size={17} /></a>
            </HubReveal>
          </div>
        </section>
      </div>
    </HubMarketingShell>
  );
};

export const HubAudienceLanding: React.FC<HubAudienceLandingProps> = ({ audience, ...props }) => {
  if (audience === 'schools') return <SchoolLanding {...props} />;
  return <TeacherLanding {...props} />;
};

export default HubAudienceLanding;
