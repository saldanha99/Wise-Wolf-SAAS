import React from 'react';
import {
  ArrowRight,
  BookOpen,
  Bot,
  Building2,
  Check,
  CircleDollarSign,
  FileText,
  GraduationCap,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
} from 'lucide-react';
import HubMarketingShell, { HubFaq, HubReveal, HubSectionIntro } from './HubMarketingShell';
import HubNativeProductTour from './HubNativeProductTour';
import HubPricingSection from './HubPricingSection';
import HubProductMockup, { type HubMockupKind } from './HubProductMockups';
import HubVideoShowcase, { HUB_PUBLIC_VIDEOS_ENABLED } from './HubVideoShowcase';
import { hubMarketingPath, resolveSystemAppUrl } from './hubRoutes';
import type { HubAudience, HubBillingCycle, HubContentItem, HubPlan, HubSettings } from './types';

interface HubLandingProps {
  plans: HubPlan[];
  settings: HubSettings;
  content: HubContentItem[];
  catalogReady?: boolean;
  onAuthenticate: (mode: 'login' | 'signup', audience?: HubAudience) => void;
  onPlanSelect: (planCode: string, billingCycle: HubBillingCycle) => void;
}

export function resolveHubVideoEmbed(url?: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.replace('/', '').slice(0, 24);
      return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    }
    if (parsed.hostname.endsWith('youtube.com')) {
      const id = parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop();
      return id ? `https://www.youtube-nocookie.com/embed/${id.slice(0, 24)}` : null;
    }
    if (parsed.hostname.endsWith('vimeo.com')) {
      const id = parsed.pathname.split('/').filter(Boolean).pop();
      return id && /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export const HubSaasShowcase: React.FC<{
  settings: HubSettings;
  compact?: boolean;
  onCta?: () => void;
}> = ({ settings, compact = false, onCta }) => {
  const embedUrl = resolveHubVideoEmbed(settings.saas_video_url);
  const ctaUrl = compact
    ? resolveSystemAppUrl(settings.saas_cta_url, '/new-saas')
    : hubMarketingPath('school-os');

  return (
    <section className={compact ? 'hub-portal-saas' : 'hub-section hub-section--dark hub-school-showcase'}>
      <div className={compact ? 'hub-school-showcase__grid' : 'hub-container hub-school-showcase__grid'}>
        <div className="hub-school-showcase__copy">
          <p className="hub-eyebrow"><span />Para escolas de idiomas</p>
          <h2>A operação inteira pode falar a <em>mesma língua.</em></h2>
          <p>Agenda, matrícula, contratos, financeiro, equipe e portal do aluno conectados em um ambiente com papéis definidos e dados separados por escola.</p>
          <div className="hub-school-showcase__capabilities">
            <span><Workflow size={15} />Fluxos conectados</span>
            <span><ShieldCheck size={15} />Permissões por papel</span>
            <span><Building2 size={15} />Ambiente por escola</span>
          </div>
          <a href={ctaUrl} onClick={onCta} className="hub-button hub-button--inverse">Conhecer o sistema escolar <ArrowRight size={16} /></a>
        </div>
        <div className="hub-school-showcase__visual">
          {embedUrl ? (
            <div className="hub-mock-window hub-school-video">
              <div className="hub-mock-window__chrome"><span /><span /><span /><p>Wise Wolf School OS</p></div>
              <iframe
                src={embedUrl}
                title="Apresentação do sistema escolar Wise Wolf"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : <HubProductMockup kind="school" />}
        </div>
      </div>
    </section>
  );
};

const HubLanding: React.FC<HubLandingProps> = ({ plans, settings, content, catalogReady = true, onAuthenticate, onPlanSelect }) => {
  const discoveryDays = Math.max(Number(plans.find((plan) => plan.code === 'DISCOVERY')?.trial_days || 0), 0);
  const discoveryAvailable = discoveryDays > 0;
  const previews = content.slice(0, 3);

  const choosePlan = (plan: HubPlan, billingCycle: HubBillingCycle) => {
    if (!catalogReady) return;
    onPlanSelect(plan.code, billingCycle);
    onAuthenticate('signup', 'EDUCATOR');
  };

  const solutions: Array<{
    name: string;
    description: string;
    href: string;
    icon: React.ElementType;
    accent: string;
  }> = [
    { name: 'Ensinar', description: 'Biblioteca, planejamento com IA, materiais e trilhas para preparar com intenção.', href: hubMarketingPath('teachers'), icon: Sparkles, accent: '#d66a45' },
    { name: 'Engajar', description: 'Portal, atividades e prática contextual com o Wolfie entre uma aula e outra.', href: hubMarketingPath('wolfie'), icon: Bot, accent: '#20a9cc' },
    { name: 'Crescer', description: 'CRM, aula experimental, matrícula, contratos e automações trabalhando em sequência.', href: hubMarketingPath('schools'), icon: Users, accent: '#7652ed' },
    { name: 'Operar', description: 'Agenda, equipe, presença, financeiro, permissões e marca no mesmo contexto.', href: hubMarketingPath('schools'), icon: Workflow, accent: '#258e79' },
  ];

  // As quatro páginas de solução. A home roteia por público; este índice existe
  // para que cada módulo tenha uma entrada própria a partir do topo do funil.
  const modules: Array<{
    name: string;
    summary: string;
    href: string;
    icon: React.ElementType;
    accent: string;
  }> = [
    { name: 'Biblioteca', summary: 'Acervo com curadoria', href: hubMarketingPath('library'), icon: BookOpen, accent: '#d66a45' },
    { name: 'Educador IA', summary: 'Planejamento com contexto', href: hubMarketingPath('educator-ai'), icon: Sparkles, accent: '#7652ed' },
    { name: 'Wolfie', summary: 'Prática conversacional', href: hubMarketingPath('wolfie'), icon: Bot, accent: '#20a9cc' },
    { name: 'School OS', summary: 'Sistema da escola', href: hubMarketingPath('school-os'), icon: Building2, accent: '#258e79' },
  ];

  const features: Array<{
    label: string;
    title: string;
    description: string;
    pills: string[];
    href: string;
    link: string;
    kind: HubMockupKind;
    icon: React.ElementType;
    accent: string;
  }> = [
    {
      label: 'Wise Wolf para professores',
      title: 'Ensine melhor hoje. Profissionalize sua operação no seu ritmo.',
      description: 'Comece preparando aulas com Biblioteca e Educador IA. Quando sua rotina pedir mais estrutura, conecte agenda, oportunidades, contratos, pagamentos e gestão em uma implantação acompanhada.',
      pills: ['Preparação de aulas', 'Estúdio individual', 'Crescimento assistido'],
      href: hubMarketingPath('teachers'),
      link: 'Ver a jornada do professor',
      kind: 'educator',
      icon: BookOpen,
      accent: '#d66a45',
    },
    {
      label: 'Wise Wolf para escolas',
      title: 'Cresça sem transformar sua escola em processos soltos.',
      description: 'Conecte captação, experimental, matrícula, entrega pedagógica, agenda, equipe e financeiro em um ambiente configurado para a sua operação e implantado por etapas.',
      pills: ['Comercial conectado', 'Entrega pedagógica', 'Operação por escola'],
      href: hubMarketingPath('schools'),
      link: 'Ver a jornada da escola',
      kind: 'school',
      icon: Building2,
      accent: '#258e79',
    },
  ];

  const faq = [
    { question: 'O que exatamente é o Wise Wolf Hub?', answer: 'É a marca guarda-chuva das soluções Wise Wolf para professores autônomos, escolas de idiomas e prática individual. O Hub ajuda você a escolher uma jornada; os produtos, acessos e contratações continuam com escopos próprios.' },
    { question: 'Qual é a diferença entre a oferta para professor e para escola?', answer: 'O professor pode começar em autoatendimento com ferramentas pedagógicas. A escola passa por diagnóstico e implantação assistida, porque envolve equipe, processos, integrações, permissões e migração de operação.' },
    { question: 'Já sou aluno Wise Wolf. Preciso assinar?', answer: 'Não para usar o que sua escola já incluiu. A biblioteca escolar e a experiência parcial do tutor ficam no Portal do Aluno. Uma assinatura externa só é necessária se você quiser um produto individual adicional.' },
    { question: 'O teste gratuito pede cartão?', answer: discoveryDays > 0 ? `Não. O acesso de descoberta para educadores dura ${discoveryDays} dias e não exige cartão.` : 'Não. Quando o acesso de descoberta está disponível, ele pode ser iniciado sem cartão.' },
    { question: 'Quando o plano do professor é liberado após a compra?', answer: 'Somente depois que o Asaas confirma o pagamento. Cobrança pendente não libera acesso; e-mail e WhatsApp seguem uma fila com controle de reenvio.' },
    { question: 'Como funciona a proteção entre escolas?', answer: 'A contratação institucional é assistida justamente para validar ambiente, papéis, vínculos e limites de acesso antes da abertura. Cada implantação permanece ligada ao contexto da própria escola.' },
    { question: 'O Wolfie substitui uma aula com professor?', answer: 'Não. Ele é uma ferramenta de prática com inteligência artificial. Acompanhamento, adaptação pedagógica e decisões de ensino continuam com o professor.' },
  ];

  return (
    <HubMarketingShell
      onLogin={() => onAuthenticate('login', 'EDUCATOR')}
      primaryHref={hubMarketingPath('teachers')}
      primaryLabel="Para professores"
    >
      <section className="hub-hero">
        <div className="hub-container hub-hero__grid">
          <HubReveal className="hub-hero__content">
            <div className="hub-hero__kicker"><span />Infraestrutura para professores e escolas de inglês</div>
            <h1>Do primeiro plano de aula à <em>operação inteira.</em></h1>
            <p className="hub-hero__description">A Wise Wolf conecta criação pedagógica, prática do aluno, captação e gestão. Você escolhe a jornada; a tecnologia organiza o caminho sem transformar tudo em mais uma ferramenta solta.</p>
            <div className="hub-hero__actions">
              <a className="hub-button hub-button--primary" href={hubMarketingPath('teachers')}>Sou professor <ArrowRight size={17} /></a>
              <a className="hub-button hub-button--secondary" href={hubMarketingPath('schools')}>Tenho uma escola</a>
            </div>
            <div className="hub-hero__proof">
              <span><Check size={13} />Entrada por objetivo</span>
              <span><Check size={13} />Venda direta para educadores</span>
              <span><ShieldCheck size={13} />Implantação assistida para escolas</span>
            </div>
          </HubReveal>
          <HubReveal className="hub-hero__visual" delay={0.12}>
            {HUB_PUBLIC_VIDEOS_ENABLED ? <HubVideoShowcase videoId="overview" /> : <HubProductMockup kind="ecosystem" />}
          </HubReveal>
        </div>
      </section>

      <section className="hub-audience-strip hub-audience-strip--dual" aria-label="Escolha seu ponto de entrada">
        <div className="hub-container hub-audience-strip__inner">
          {[
            { icon: BookOpen, title: 'Professor autônomo', text: 'Prepare aulas, engaje alunos e estruture seu negócio.', href: hubMarketingPath('teachers') },
            { icon: Building2, title: 'Escola de idiomas', text: 'Conecte comercial, pedagógico e operação com clareza.', href: hubMarketingPath('schools') },
          ].map(({ icon: Icon, title, text, href }) => (
            <a key={title} href={href}><span className="hub-audience-strip__icon"><Icon size={17} /></span><span><b>{title}</b><small>{text}</small></span><ArrowRight size={14} /></a>
          ))}
        </div>
        <div className="hub-container hub-audience-strip__utility">
          <a href={resolveSystemAppUrl('/')}><GraduationCap size={14} />Já sou aluno Wise Wolf</a>
          <a href={hubMarketingPath('wolfie')}><Bot size={14} />Quero praticar com o Wolfie</a>
        </div>
      </section>

      <section className="hub-section hub-native-story-section">
        <div className="hub-container">
          <HubReveal>
            <HubSectionIntro
              eyebrow="O produto, por dentro"
              title={<>Não são quatro promessas. <em>São quatro módulos reais trabalhando.</em></>}
              description="Role a página para percorrer telas nativas da plataforma. O Hub reutiliza o núcleo existente e adiciona assinatura, conta e autorização próprias para cada acesso."
            />
          </HubReveal>
          <HubNativeProductTour kind="ecosystem" />
        </div>
      </section>

      <section id="solucoes" className="hub-section">
        <div className="hub-container">
          <HubReveal>
            <HubSectionIntro
              eyebrow="Uma plataforma, quatro resultados"
              title={<>O comprador entende o destino. <em>A tecnologia conecta o percurso.</em></>}
              description="Cada módulo aparece pelo trabalho que resolve — da preparação de uma aula à gestão completa de uma escola."
              align="center"
            />
          </HubReveal>
          <div className="hub-solutions-grid">
            {solutions.map(({ name, description, href, icon: Icon, accent }, index) => (
              <a key={name} href={href} className="hub-solution-card" style={{ '--card-accent': accent } as React.CSSProperties}>
                <span className="hub-solution-card__index">{String(index + 1).padStart(2, '0')}</span>
                <div className="hub-solution-card__object"><div><Icon size={31} /></div></div>
                <h3>{name}</h3>
                <p>{description}</p>
                <span className="hub-solution-card__link">Ver esta jornada <ArrowRight size={15} /></span>
              </a>
            ))}
          </div>

          <nav className="hub-module-index" aria-label="Páginas das soluções do Hub">
            <p className="hub-module-index__label">Ou vá direto a uma solução</p>
            <div className="hub-module-index__links">
              {modules.map(({ name, summary, href, icon: Icon, accent }) => (
                <a key={name} href={href} style={{ '--module-accent': accent } as React.CSSProperties}>
                  <span className="hub-module-index__icon"><Icon size={16} /></span>
                  <span className="hub-module-index__text"><b>{name}</b><small>{summary}</small></span>
                  <ArrowRight size={13} />
                </a>
              ))}
            </div>
          </nav>

          <div className="hub-feature-stack">
            {features.map(({ label, title, description, pills, href, link, kind, icon: Icon, accent }, index) => (
              <HubReveal key={label}>
                <article className={`hub-feature-row ${index % 2 === 1 ? 'is-reversed' : ''}`} style={{ '--row-accent': accent } as React.CSSProperties}>
                  <div className="hub-feature-row__text">
                    <span className="hub-feature-row__label"><Icon size={14} />{label}</span>
                    <h3>{title}</h3>
                    <p>{description}</p>
                    <div className="hub-feature-row__pills">{pills.map((pill) => <span key={pill}>{pill}</span>)}</div>
                    <a href={href} className="hub-feature-row__link">{link}<ArrowRight size={15} /></a>
                  </div>
                  <div className="hub-feature-row__visual"><HubProductMockup kind={kind} /></div>
                </article>
              </HubReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="hub-editorial-banner">
        <div className="hub-container hub-editorial-banner__layout">
          <div className="hub-editorial-banner__content">
            <p>Da primeira conversa à próxima renovação</p>
            <h2>Uma jornada conectada. <em>Responsabilidades separadas.</em></h2>
            <p>Captação, ensino, prática e operação compartilham o contexto necessário. Conta, papel e ambiente definem quem pode acessar cada etapa.</p>
            <a href={hubMarketingPath('schools')} className="hub-button hub-button--inverse">Ver a arquitetura para escolas <ArrowRight size={16} /></a>
          </div>
          <HubReveal className="hub-architecture-visual" direction="scale">
            <div className="hub-architecture-visual__character">
              <img src="/assets/wolfie/characters/wolfie-coach/wolfie-v2-listening.07cf0629cc2d.webp" alt="Wolfie, personagem da Wise Wolf" loading="lazy" decoding="async" />
            </div>
            <span className="hub-architecture-node is-library"><Users size={17} /><b>Atrair</b></span>
            <span className="hub-architecture-node is-educator"><BookOpen size={17} /><b>Ensinar</b></span>
            <span className="hub-architecture-node is-wolfie"><Bot size={17} /><b>Engajar</b></span>
            <span className="hub-architecture-node is-school"><CircleDollarSign size={17} /><b>Gerir</b></span>
            <div className="hub-architecture-lock"><ShieldCheck size={18} /><span><b>Contexto por ambiente</b><small>papéis, conta e implantação</small></span></div>
          </HubReveal>
        </div>
      </section>

      {previews.length > 0 && (
        <section className="hub-section">
          <div className="hub-container">
            <HubReveal>
              <HubSectionIntro eyebrow="Prévia da Biblioteca" title={<>Conteúdo para entrar na aula com <em>intenção.</em></>} description="Uma amostra do catálogo publicado. O acesso ao arquivo completo segue o plano e a licença do conteúdo." />
            </HubReveal>
            <div className="hub-catalog-grid">
              {previews.map((item, index) => (
                <HubReveal key={item.id} delay={index * 0.06}>
                  <article className="hub-catalog-card">
                    <div className="hub-catalog-card__cover"><span>{item.level_tag || 'Todos os níveis'}</span><FileText size={28} /></div>
                    <div className="hub-catalog-card__body">
                      <div className="hub-catalog-card__tags"><span>{item.niche || 'Geral'}</span>{item.collection_name && <span>{item.collection_name}</span>}</div>
                      <h3>{item.title}</h3>
                      <p>{item.description || 'Material organizado para aplicação prática em aula.'}</p>
                    </div>
                  </article>
                </HubReveal>
              ))}
            </div>
          </div>
        </section>
      )}

      <HubPricingSection plans={plans} onChoosePlan={choosePlan} mode="overview" catalogReady={catalogReady} />

      <HubFaq items={faq} />

      <section className="hub-final-cta">
        <div className="hub-container hub-final-cta__panel">
          <div className="hub-final-cta__content">
            <span>Duas jornadas. Uma infraestrutura.</span>
            <h2>Escolha onde você está. <em>A Wise Wolf mostra o próximo passo.</em></h2>
            <p>Professores podem começar pelas ferramentas pedagógicas. Escolas entram por um diagnóstico de operação e implantação assistida.</p>
            <div className="hub-final-cta__actions">
              <a href={hubMarketingPath('teachers')} className="hub-button hub-button--inverse">Explorar para professores <ArrowRight size={17} /></a>
              <a href={hubMarketingPath('schools')} className="hub-button hub-button--secondary">Explorar para escolas</a>
            </div>
          </div>
        </div>
      </section>
    </HubMarketingShell>
  );
};

export default HubLanding;
