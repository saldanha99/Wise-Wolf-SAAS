import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion';
import {
  BookOpen,
  Bot,
  Building2,
  CalendarDays,
  Check,
  LayoutDashboard,
  Palette,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';

export type HubNativeTourKind = 'ecosystem' | 'teacher' | 'library' | 'educator' | 'wolfie' | 'school';

type NativeTourScene = {
  label: string;
  title: string;
  description: string;
  image: string;
  imageAlt: string;
  icon: React.ElementType;
  proof: string;
};

const NATIVE_ASSET_ROOT = '/assets/hub/native';

const TOUR_SCENES: Record<HubNativeTourKind, NativeTourScene[]> = {
  ecosystem: [
    {
      label: '01 · Biblioteca nativa',
      title: 'O professor encontra e organiza a base da aula.',
      description: 'O Hub abre o mesmo módulo pedagógico usado pela escola, com busca, níveis, nichos e coleções no mesmo padrão visual.',
      image: `${NATIVE_ASSET_ROOT}/library-native.png`,
      imageAlt: 'Tela nativa da gestão pedagógica e Biblioteca Master',
      icon: BookOpen,
      proof: 'Mesmo componente, acesso isolado pela assinatura',
    },
    {
      label: '02 · Planejador nativo',
      title: 'O contexto vira uma sequência ensinável.',
      description: 'Objetivo, aluno e memória pedagógica entram no planejador original; o Hub apenas adapta o contexto da conta contratante.',
      image: `${NATIVE_ASSET_ROOT}/planner-native.png`,
      imageAlt: 'Tela nativa do planejador de aula com inteligência artificial',
      icon: Sparkles,
      proof: 'Motor pedagógico compartilhado, dados separados',
    },
    {
      label: '03 · Wolfie nativo',
      title: 'A prática continua no universo certo.',
      description: 'Cenários, personagem e experiência conversacional são os mesmos do Wolfie; o plano define franquia e contexto de acesso.',
      image: `${NATIVE_ASSET_ROOT}/wolfie-interview.png`,
      imageAlt: 'Tela nativa do Wolfie em uma prática de entrevista profissional',
      icon: Bot,
      proof: 'Experiência real, histórico por usuário e conta',
    },
    {
      label: '04 · School OS nativo',
      title: 'Da operação diária à visão da direção.',
      description: 'A solução completa conecta comercial, agenda, equipe, financeiro e configurações dentro do tenant da própria escola.',
      image: `${NATIVE_ASSET_ROOT}/director-dashboard.png`,
      imageAlt: 'Dashboard nativo do diretor no Wise Wolf School OS',
      icon: Building2,
      proof: 'Papéis, tenant e políticas de banco em conjunto',
    },
  ],
  teacher: [
    {
      label: '01 · Encontrar',
      title: 'A Biblioteca reduz a busca antes da aula.',
      description: 'O professor navega pelo módulo pedagógico original, com curadoria, nível, nicho e coleções no mesmo lugar.',
      image: `${NATIVE_ASSET_ROOT}/library-native.png`,
      imageAlt: 'Tela nativa da Biblioteca Master para professores',
      icon: BookOpen,
      proof: 'Biblioteca nativa dentro da assinatura do professor',
    },
    {
      label: '02 · Planejar',
      title: 'O objetivo do aluno orienta a estrutura da aula.',
      description: 'O Educador IA reutiliza o planejador nativo e recebe um adaptador seguro para a conta contratante.',
      image: `${NATIVE_ASSET_ROOT}/planner-native.png`,
      imageAlt: 'Tela nativa do Planejador IA para professores',
      icon: Sparkles,
      proof: 'Mesmo motor pedagógico, contexto isolado',
    },
    {
      label: '03 · Continuar',
      title: 'O Wolfie mantém o inglês ativo entre encontros.',
      description: 'O professor pode conectar prática por texto no Hub, enquanto a voz individual permanece em planos próprios do Wolfie.',
      image: `${NATIVE_ASSET_ROOT}/wolfie-business.png`,
      imageAlt: 'Tela nativa do Wolfie em um cenário profissional',
      icon: Bot,
      proof: 'Escopo do plano explicado sem misturar produtos',
    },
  ],
  library: [
    {
      label: '01 · Curadoria',
      title: 'Biblioteca e aprovação dentro do mesmo módulo.',
      description: 'O professor trabalha com a estrutura pedagógica nativa. Materiais novos passam pelo fluxo de aprovação antes de entrar no acervo.',
      image: `${NATIVE_ASSET_ROOT}/library-native.png`,
      imageAlt: 'Tela nativa da Biblioteca Master com envio de material para aprovação',
      icon: BookOpen,
      proof: 'Publicação controlada e catálogo protegido',
    },
    {
      label: '02 · Descoberta',
      title: 'Busca por nível e nicho, sem pastas soltas.',
      description: 'O acervo herda a navegação do sistema original e aplica o plano da conta antes de liberar qualquer arquivo completo.',
      image: `${NATIVE_ASSET_ROOT}/student-materials.png`,
      imageAlt: 'Tela nativa da biblioteca de materiais no portal do aluno',
      icon: LayoutDashboard,
      proof: 'Catálogo visível; arquivo entregue por rota autorizada',
    },
    {
      label: '03 · Entrega',
      title: 'O aluno recebe somente o que foi atribuído.',
      description: 'A mesma biblioteca assume o papel correto: curadoria para o professor e materiais atribuídos para o aluno, sem cruzar contas.',
      image: `${NATIVE_ASSET_ROOT}/student-materials.png`,
      imageAlt: 'Tela nativa de materiais atribuídos ao aluno',
      icon: Users,
      proof: 'Papel e vínculo pedagógico determinam a visualização',
    },
  ],
  educator: [
    {
      label: '01 · Contexto',
      title: 'O plano começa pelo aluno, não por um prompt vazio.',
      description: 'Seleção do aluno, objetivo e memória recente permanecem no componente original do Planejador IA.',
      image: `${NATIVE_ASSET_ROOT}/planner-native.png`,
      imageAlt: 'Tela nativa do Planejador IA com seleção de aluno e contexto',
      icon: Users,
      proof: 'Contexto vinculado à conta e ao perfil escolhido',
    },
    {
      label: '02 · Estrutura',
      title: 'A IA organiza uma base que o professor revisa.',
      description: 'A geração acontece pelo adaptador isolado do Hub, preservando o motor nativo e o controle de consumo por assinatura.',
      image: `${NATIVE_ASSET_ROOT}/planner-native.png`,
      imageAlt: 'Assistente nativo de planejamento de aula com IA',
      icon: Sparkles,
      proof: 'Franquia confirmada apenas após uma geração concluída',
    },
    {
      label: '03 · Continuidade',
      title: 'O plano se conecta aos materiais e à prática.',
      description: 'Biblioteca e Wolfie continuam disponíveis como módulos do mesmo ecossistema, sem duplicar o núcleo pedagógico.',
      image: `${NATIVE_ASSET_ROOT}/library-native.png`,
      imageAlt: 'Biblioteca nativa conectada ao fluxo de planejamento',
      icon: BookOpen,
      proof: 'Um ecossistema, módulos contratáveis separadamente',
    },
  ],
  wolfie: [
    {
      label: '01 · Objetivo profissional',
      title: 'A conversa nasce do mundo em que o aluno quer agir.',
      description: 'O usuário entra em cenários reais do Wolfie, com ambiente, intenção e competência claramente definidos.',
      image: `${NATIVE_ASSET_ROOT}/wolfie-business.png`,
      imageAlt: 'Tela nativa do Wolfie em um cenário de inglês para negócios',
      icon: Building2,
      proof: 'Experiência visual e conversacional original',
    },
    {
      label: '02 · Ensaio seguro',
      title: 'Entrevistas podem ser praticadas antes de valerem uma vaga.',
      description: 'O personagem ouve, responde e mantém o contexto da prática sem expor conversas de outro usuário.',
      image: `${NATIVE_ASSET_ROOT}/wolfie-interview.png`,
      imageAlt: 'Tela nativa do Wolfie em um ensaio de entrevista',
      icon: Bot,
      proof: 'Histórico protegido por usuário e conta',
    },
    {
      label: '03 · Vocabulário de área',
      title: 'A pressão e o vocabulário mudam com o cenário.',
      description: 'Saúde, negócios e outros universos usam o mesmo motor, calibrado pelo nível e pela experiência escolhida.',
      image: `${NATIVE_ASSET_ROOT}/wolfie-medical.png`,
      imageAlt: 'Tela nativa do Wolfie em um cenário de inglês para saúde',
      icon: ShieldCheck,
      proof: 'Nível, contexto e franquia orientam a sessão',
    },
  ],
  school: [
    {
      label: '01 · Visão da direção',
      title: 'A operação chega à direção sem planilhas paralelas.',
      description: 'Indicadores, pendências e fluxos financeiros aparecem no painel nativo respeitando o papel do diretor.',
      image: `${NATIVE_ASSET_ROOT}/director-dashboard.png`,
      imageAlt: 'Dashboard nativo do diretor com indicadores da unidade',
      icon: LayoutDashboard,
      proof: 'Leitura autorizada pelo tenant e pelo papel',
    },
    {
      label: '02 · Comercial conectado',
      title: 'O lead percorre o funil até a matrícula.',
      description: 'CRM, experimental, contrato e entrada do aluno fazem parte da mesma operação escolar.',
      image: `${NATIVE_ASSET_ROOT}/school-crm.png`,
      imageAlt: 'Tela nativa do CRM e funil de vendas da escola',
      icon: Users,
      proof: 'Contexto comercial permanece dentro da escola',
    },
    {
      label: '03 · Agenda operacional',
      title: 'A rotina de aulas conserva responsáveis e regras.',
      description: 'Agenda e gestão pedagógica usam os vínculos reais da unidade, reduzindo remarcações ou ações fora da autoridade correta.',
      image: `${NATIVE_ASSET_ROOT}/school-agenda.png`,
      imageAlt: 'Tela nativa da agenda escolar',
      icon: CalendarDays,
      proof: 'Responsável e disponibilidade entram antes da alteração',
    },
    {
      label: '04 · Marca por escola',
      title: 'Cada tenant configura a própria identidade.',
      description: 'Cores, logotipos e experiência visual pertencem à escola ativa e não vazam para outra instituição.',
      image: `${NATIVE_ASSET_ROOT}/school-branding.png`,
      imageAlt: 'Tela nativa de configuração de branding da escola',
      icon: Palette,
      proof: 'Branding, credenciais e dados isolados por ambiente',
    },
  ],
};

interface HubNativeProductTourProps {
  kind: HubNativeTourKind;
  compact?: boolean;
}

const HubNativeProductTour: React.FC<HubNativeProductTourProps> = ({ kind, compact = false }) => {
  const scenes = useMemo(() => TOUR_SCENES[kind], [kind]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [manualSelection, setManualSelection] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const inView = useInView(rootRef, { amount: 0.18 });
  const activeScene = scenes[activeIndex] || scenes[0];

  useEffect(() => {
    setActiveIndex(0);
    setManualSelection(false);
  }, [kind]);

  useEffect(() => {
    if (reducedMotion || !inView || manualSelection || scenes.length < 2) return undefined;
    const interval = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % scenes.length);
    }, 4600);
    return () => window.clearInterval(interval);
  }, [inView, manualSelection, reducedMotion, scenes.length]);

  const activate = (index: number, manual = false) => {
    setActiveIndex(index);
    if (manual) setManualSelection(true);
  };

  return (
    <div ref={rootRef} className={`hub-native-tour ${compact ? 'is-compact' : ''}`} data-tour-kind={kind}>
      <div className="hub-native-tour__stage-wrap">
        <div className="hub-native-tour__stage">
          <div className="hub-native-tour__chrome">
            <span /><span /><span />
            <p>Wise Wolf · tela nativa</p>
            <em><ShieldCheck size={12} />dados fictícios</em>
          </div>
          <div className="hub-native-tour__viewport">
            <AnimatePresence mode="sync" initial={false}>
              <motion.img
                key={activeScene.image}
                src={activeScene.image}
                alt={activeScene.imageAlt}
                className="hub-native-tour__image"
                initial={reducedMotion ? false : { opacity: 0, scale: 1.025, x: 16 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={reducedMotion ? undefined : { opacity: 0, scale: 0.985, x: -12 }}
                transition={{ duration: reducedMotion ? 0 : 0.55, ease: [0.22, 1, 0.36, 1] }}
                loading={activeIndex === 0 ? 'eager' : 'lazy'}
                decoding="async"
              />
            </AnimatePresence>
            <span className="hub-native-tour__light" aria-hidden="true" />
            <div className="hub-native-tour__caption">
              <span><Check size={12} />{activeScene.proof}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="hub-native-tour__steps" aria-label="Etapas demonstradas na tela nativa">
        {scenes.map((scene, index) => {
          const Icon = scene.icon;
          const active = activeIndex === index;
          return (
            <motion.button
              key={`${kind}-${scene.label}`}
              type="button"
              className={`hub-native-tour__step ${active ? 'is-active' : ''}`}
              aria-pressed={active}
              onClick={() => activate(index, true)}
              onFocus={() => activate(index)}
              onViewportEnter={() => activate(index)}
              viewport={{ amount: compact ? 0.5 : 0.68, margin: '-12% 0px -28% 0px' }}
            >
              <span className="hub-native-tour__step-icon"><Icon size={19} /></span>
              <span className="hub-native-tour__step-copy">
                <small>{scene.label}</small>
                <strong>{scene.title}</strong>
                <span>{scene.description}</span>
              </span>
              <i aria-hidden="true"><span /></i>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
};

export default HubNativeProductTour;
