import React, { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import {
  BookOpen,
  Bot,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDollarSign,
  FileText,
  Headphones,
  LayoutDashboard,
  Library,
  Mic2,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import {
  WolfieCharacter,
  type WolfieCharacterState,
} from '../../src/components/wolfie/visuals/WolfieCharacter';
import type { WolfieVisualSceneProfile } from '../../src/components/wolfie/visuals/types';

export type HubMockupKind = 'ecosystem' | 'library' | 'educator' | 'wolfie' | 'school';

const HERO_IMAGE = '/assets/wolfie/standalone/hero-light-phone-v2.webp';
const WOLFIE_SCENE = '/assets/wolfie/scenes/career/job-interviews/desktop.dc0f18a9a9dc.webp';

const MARKETING_PROFILE: WolfieVisualSceneProfile = {
  version: 1,
  key: 'hub-marketing-wolfie',
  layout: 'conversation',
  environmentId: 'career-interview',
  environmentDescription: 'Ambiente profissional para ensaio de entrevista em inglês.',
  castIds: ['wolfie-coach'],
  camera: 'medium',
  characterSide: 'center',
  palette: {
    accent: '#ff785f',
    glow: 'rgba(255, 120, 95, 0.62)',
    scrim: 'rgba(7, 17, 31, 0.72)',
    gradient: 'linear-gradient(145deg, #101827, #2c1830)',
  },
  hudVariant: 'conversation',
  accessibleEnvironmentLabel: 'Simulação profissional com o Wolfie.',
};

const WindowChrome: React.FC<{ label: string; status?: string }> = ({ label, status }) => (
  <div className="hub-mock-window__chrome">
    <span /><span /><span />
    <p>{label}</p>
    {status && <em>{status}</em>}
  </div>
);

const EcosystemMockup: React.FC = () => (
  <div className="hub-ecosystem-visual" role="img" aria-label="Wolfie apresentando a jornada conectada do Wise Wolf Hub">
    <span className="hub-ecosystem-visual__aura" aria-hidden="true" />
    <div className="hub-ecosystem-visual__frame">
      <img src={HERO_IMAGE} alt="" width="971" height="1619" fetchPriority="high" decoding="async" />
    </div>
    <div className="hub-ecosystem-chip hub-ecosystem-chip--library"><span><Library size={17} /></span><div><b>Ensinar</b><small>Biblioteca + Educador IA</small></div></div>
    <div className="hub-ecosystem-chip hub-ecosystem-chip--educator"><span><Sparkles size={17} /></span><div><b>Engajar</b><small>Prática + experiência do aluno</small></div></div>
    <div className="hub-ecosystem-chip hub-ecosystem-chip--school"><span><LayoutDashboard size={17} /></span><div><b>Operar</b><small>Comercial + School OS</small></div></div>
    <div className="hub-ecosystem-trust"><ShieldCheck size={15} /><span><b>Acesso no lugar certo</b><small>Conta, plano e ambiente separados</small></span></div>
  </div>
);

const LibraryMockup: React.FC = () => (
  <div className="hub-mock-window hub-product-mockup hub-library-mockup" role="img" aria-label="Catálogo da Biblioteca Wise Wolf com filtros por nível e contexto">
    <WindowChrome label="Wise Wolf Library" status="Catálogo protegido" />
    <div className="hub-library-mockup__toolbar">
      <div className="hub-mock-search"><Search size={14} />Apresentação de resultados</div>
      <div className="hub-mock-filter is-active">B1</div><div className="hub-mock-filter">Business</div>
    </div>
    <div className="hub-library-mockup__body">
      <aside>
        <p>COLEÇÕES</p>
        <span className="is-active">Business English</span>
        <span>Conversation</span>
        <span>Travel</span>
        <span>Grammar in context</span>
      </aside>
      <div className="hub-library-mockup__grid">
        <article className="is-featured">
          <div className="hub-library-cover"><span>B1</span><FileText size={30} /></div>
          <b>Presenting monthly results</b>
          <small>Plano de aula · 60 min</small>
          <div><span>Ver prévia</span><ChevronRight size={14} /></div>
        </article>
        <article><div className="hub-library-cover is-warm"><span>A2</span><BookOpen size={25} /></div><b>Handling a reservation</b><small>Atividade · 45 min</small></article>
        <article><div className="hub-library-cover is-violet"><span>B2</span><FileText size={25} /></div><b>Negotiating deadlines</b><small>Plano de aula · 60 min</small></article>
      </div>
    </div>
    <div className="hub-mock-security"><ShieldCheck size={14} />Prévia pública. Arquivo completo liberado somente pelo plano.</div>
  </div>
);

const EducatorMockup: React.FC = () => (
  <div className="hub-mock-window hub-product-mockup hub-educator-mockup" role="img" aria-label="Educador IA transformando um objetivo em uma sequência estruturada para adaptação">
    <WindowChrome label="Educador IA · novo plano" status="Base para adaptar" />
    <div className="hub-educator-mockup__body">
      <section>
        <p className="hub-mock-kicker">CONTEXTO PEDAGÓGICO</p>
        <label>Nível<span>B1</span></label>
        <label>Duração<span>60 minutos</span></label>
        <label className="is-tall">Resultado esperado<span>Apresentar resultados e explicar um atraso com clareza.</span></label>
        <div className="hub-educator-mockup__button"><Sparkles size={15} />Estruturar aula</div>
      </section>
      <section className="hub-educator-mockup__result">
        <div className="hub-educator-mockup__result-head"><div><p className="hub-mock-kicker">PLANO ESTRUTURADO</p><b>From update to next step</b></div><span>60 min</span></div>
        {[
          ['01', 'Aquecimento', '10 min', 'Ative vocabulário e contexto.'],
          ['02', 'Experiência central', '25 min', 'Organize contexto, impacto e proposta.'],
          ['03', 'Prática guiada', '20 min', 'Simule a conversa com variações.'],
        ].map(([number, title, time, detail]) => (
          <article key={number}><span>{number}</span><div><b>{title}</b><small>{detail}</small></div><em>{time}</em></article>
        ))}
        <div className="hub-educator-mockup__continuity"><Check size={14} />Continuidade fora da aula incluída</div>
      </section>
    </div>
  </div>
);

const WolfieMockup: React.FC = () => {
  const [state, setState] = useState<WolfieCharacterState>('LISTENING');
  const [autoCycle, setAutoCycle] = useState(true);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion || !autoCycle) return undefined;
    const interval = window.setInterval(() => {
      setState((current) => current === 'LISTENING' ? 'SPEAKING' : 'LISTENING');
    }, 3200);
    return () => window.clearInterval(interval);
  }, [autoCycle, reducedMotion]);

  const speaking = state === 'SPEAKING';

  return (
    <div className="hub-wolfie-live" role="group" aria-label="Demonstração visual do Wolfie ouvindo e respondendo">
      <img className="hub-wolfie-live__scene" src={WOLFIE_SCENE} alt="Ambiente profissional preparado para prática de entrevista" loading="lazy" decoding="async" />
      <span className="hub-wolfie-live__scrim" aria-hidden="true" />
      <div className="hub-wolfie-live__top"><span><Bot size={15} />Wolfie AI Tutor</span><em className={speaking ? 'is-speaking' : ''}>{speaking ? 'Respondendo' : 'Ouvindo'}</em></div>
      <div className="hub-wolfie-live__character">
        <WolfieCharacter profile={MARKETING_PROFILE} state={state} inputLevel={0.55} outputLevel={0.58} />
      </div>
      <div className="hub-wolfie-live__copy">
        <p>ENTREVISTA · B1</p>
        <h3>{speaking ? 'Vamos deixar sua resposta mais natural.' : 'Conte sua experiência no seu ritmo.'}</h3>
        <div className="hub-wave" aria-hidden="true">{[18, 32, 45, 24, 52, 38, 62, 30, 44, 22, 56, 35].map((height, index) => <i key={`${height}-${index}`} style={{ height }} />)}</div>
      </div>
      <div className="hub-wolfie-live__controls" aria-label="Estado do personagem">
        <button type="button" aria-pressed={!speaking} className={!speaking ? 'is-active' : ''} onClick={() => { setAutoCycle(false); setState('LISTENING'); }}><Headphones size={15} />Ouvir</button>
        <button type="button" aria-pressed={speaking} className={speaking ? 'is-active' : ''} onClick={() => { setAutoCycle(false); setState('SPEAKING'); }}><Mic2 size={15} />Responder</button>
      </div>
    </div>
  );
};

const SchoolMockup: React.FC = () => (
  <div className="hub-mock-window hub-product-mockup hub-school-mockup" role="img" aria-label="Sistema escolar conectando agenda, financeiro, equipe e permissões">
    <WindowChrome label="Wise Wolf School OS" status="Ambiente da escola" />
    <div className="hub-school-mockup__body">
      <aside>
        <span className="hub-school-mockup__mark">W</span>
        <span className="is-active"><LayoutDashboard size={16} /></span>
        <span><CalendarDays size={16} /></span>
        <span><Users size={16} /></span>
        <span><CircleDollarSign size={16} /></span>
        <span><ShieldCheck size={16} /></span>
      </aside>
      <section>
        <div className="hub-school-mockup__heading"><div><p className="hub-mock-kicker">OPERAÇÃO DA ESCOLA</p><h3>Hoje, sem pontos cegos.</h3></div><span>Direção</span></div>
        <div className="hub-school-mockup__stats">
          <article><CalendarDays size={17} /><small>AGENDA</small><b>Aulas organizadas</b><span>ver fluxo</span></article>
          <article><Users size={17} /><small>EQUIPE</small><b>Papéis definidos</b><span>ver acessos</span></article>
          <article><CircleDollarSign size={17} /><small>FINANCEIRO</small><b>Cobranças visíveis</b><span>ver gestão</span></article>
        </div>
        <div className="hub-school-mockup__schedule">
          <div><span>PRÓXIMOS FLUXOS</span><span>RESPONSÁVEL</span><span>STATUS</span></div>
          {[
            ['Aula experimental · novo contato', 'Comercial', 'Confirmar'],
            ['Contrato e primeira cobrança', 'Financeiro', 'Preparado'],
            ['Acesso do professor', 'Direção', 'Restrito'],
          ].map(([flow, owner, status]) => <div key={flow}><b>{flow}</b><span>{owner}</span><em>{status}</em></div>)}
        </div>
      </section>
    </div>
  </div>
);

export const HubProductMockup: React.FC<{ kind: HubMockupKind }> = ({ kind }) => {
  if (kind === 'library') return <LibraryMockup />;
  if (kind === 'educator') return <EducatorMockup />;
  if (kind === 'wolfie') return <WolfieMockup />;
  if (kind === 'school') return <SchoolMockup />;
  return <EcosystemMockup />;
};

export default HubProductMockup;
