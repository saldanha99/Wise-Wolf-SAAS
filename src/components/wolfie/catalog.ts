import type {
  CefrLevel,
  WolfieSubject,
} from './types';

export interface SubjectOption {
  id: WolfieSubject;
  title: string;
  shortTitle: string;
  description: string;
  outcome: string;
}

export const SUBJECT_OPTIONS: SubjectOption[] = [
  {
    id: 'vocabulary',
    title: 'Vocabulário em contexto',
    shortTitle: 'Vocabulário',
    description:
      'Aprenda expressões dentro de situações reais, sem decorar palavras soltas.',
    outcome: 'Reconhecer e usar palavras com intenção.',
  },
  {
    id: 'grammar',
    title: 'Gramática em ação',
    shortTitle: 'Gramática',
    description:
      'Tome decisões de estrutura e tempo verbal dentro de mensagens úteis.',
    outcome: 'Construir frases corretas sem travar.',
  },
  {
    id: 'listening',
    title: 'Listening para agir',
    shortTitle: 'Listening',
    description:
      'Ouça uma situação, entenda o que importa e responda com confiança.',
    outcome: 'Captar intenção, detalhes e próximos passos.',
  },
  {
    id: 'reading',
    title: 'Reading com propósito',
    shortTitle: 'Reading',
    description:
      'Leia textos curtos e transforme informação em decisões práticas.',
    outcome: 'Ler com velocidade e compreensão real.',
  },
  {
    id: 'writing',
    title: 'Writing que você usaria',
    shortTitle: 'Writing',
    description:
      'Escreva mensagens reais e receba uma versão corrigida e mais natural.',
    outcome: 'Sair com um texto pronto para o mundo real.',
  },
  {
    id: 'global_meetings',
    title: 'Reuniões corporativas globais',
    shortTitle: 'Reuniões globais',
    description:
      'Construa um roteiro, memorize sua lógica e readapte em um novo cenário.',
    outcome: 'Conduzir reuniões sem depender de um script.',
  },
];

export interface LevelOption {
  id: CefrLevel;
  label: string;
  reference: string;
  coaching: string;
}

export const LEVEL_OPTIONS: LevelOption[] = [
  {
    id: 'A1',
    label: 'Começando',
    reference: 'Consigo usar palavras e frases muito simples.',
    coaching: 'Frases curtas, apoio claro e correção encorajadora.',
  },
  {
    id: 'A2',
    label: 'Básico funcional',
    reference: 'Consigo lidar com trocas simples e rotineiras.',
    coaching: 'Vocabulário frequente e situações previsíveis.',
  },
  {
    id: 'B1',
    label: 'Independente',
    reference: 'Consigo explicar experiências, planos e opiniões.',
    coaching: 'Situações reais, autonomia e clareza.',
  },
  {
    id: 'B2',
    label: 'Confiante',
    reference: 'Consigo interagir com fluidez em temas complexos.',
    coaching: 'Precisão, repertório profissional e espontaneidade.',
  },
  {
    id: 'C1',
    label: 'Avançado',
    reference: 'Consigo me expressar com flexibilidade e propósito.',
    coaching: 'Naturalidade, nuance, tom e escolhas estratégicas.',
  },
  {
    id: 'C2',
    label: 'Domínio',
    reference: 'Consigo compreender e comunicar quase tudo com precisão.',
    coaching: 'Sutileza, impacto e comunicação de alta complexidade.',
  },
];

export interface SectorOption {
  id: string;
  title: string;
  context: string;
}

export const SECTOR_OPTIONS: SectorOption[] = [
  {
    id: 'pharma_health',
    title: 'Farmacêutico / Saúde',
    context: 'Qualidade, compliance, estudos e operações clínicas.',
  },
  {
    id: 'manufacturing_foundry',
    title: 'Manufatura / Fundição',
    context: 'Produção, segurança, qualidade e capacidade.',
  },
  {
    id: 'banking_finance',
    title: 'Bancário / Financeiro',
    context: 'Risco, resultados, governança e decisões de investimento.',
  },
  {
    id: 'technology_ai',
    title: 'Tecnologia / IA',
    context: 'Produto, dados, incidentes e alinhamento técnico.',
  },
  {
    id: 'logistics',
    title: 'Logística',
    context: 'Prazos, rotas, fornecedores e continuidade.',
  },
  {
    id: 'information_technology',
    title: 'TI',
    context: 'Projetos, suporte, segurança e infraestrutura.',
  },
  {
    id: 'tax',
    title: 'Fiscal',
    context: 'Prazos, auditoria, conformidade e impactos tributários.',
  },
  {
    id: 'beauty_cosmetics_perfumery',
    title: 'Beleza / Cosméticos / Perfumaria',
    context: 'Produtos, ingredientes, lançamentos, treinamento e distribuição.',
  },
  {
    id: 'retail_wholesale',
    title: 'Varejo / Atacado',
    context: 'Compras, estoque, margem, fornecedores e expansão de canais.',
  },
  {
    id: 'food_beverage',
    title: 'Alimentos / Bebidas',
    context: 'Portfólio, sabores, embalagem, compradores e entrada em mercado.',
  },
  {
    id: 'veterinary_pet',
    title: 'Veterinária / Mercado Animal',
    context: 'Saúde animal, produtos técnicos, clínicas e parcerias comerciais.',
  },
  {
    id: 'tourism_hospitality',
    title: 'Turismo / Hospitalidade',
    context: 'Atendimento, reservas, eventos, parceiros e hóspedes internacionais.',
  },
  {
    id: 'sales_expansion',
    title: 'Vendas / Expansão Internacional',
    context: 'Pitch, negociação, distribuição, objeções e entrada em novos mercados.',
  },
  {
    id: 'projects_operations',
    title: 'Projetos / Operações',
    context: 'Stakeholders, riscos, indicadores, implantação e melhoria de processos.',
  },
];

export const getSubjectOption = (subject: WolfieSubject): SubjectOption =>
  SUBJECT_OPTIONS.find((option) => option.id === subject) ??
  SUBJECT_OPTIONS[0];

export const getLevelOption = (level: CefrLevel): LevelOption =>
  LEVEL_OPTIONS.find((option) => option.id === level) ?? LEVEL_OPTIONS[0];

export const getSectorOption = (sector?: string): SectorOption | undefined =>
  SECTOR_OPTIONS.find((option) => option.id === sector);
