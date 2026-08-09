import type { ElementType } from 'react';
import {
  LayoutDashboard, CalendarClock, GraduationCap, Users, DollarSign, FileBarChart,
  ShieldAlert, Zap, CalendarOff, Mic, Book, Target, Brain, Globe, Gift, Settings,
} from 'lucide-react';

/**
 * Navegação do diretor — FONTE ÚNICA do menu e das abas.
 *
 * O menu tinha 37 itens em 7 seções (o do MotoFix, referência do projeto, tem
 * 16 em 4). Pior: `verify-rooms` e `coverage` (seção Aulas) estavam no meio do
 * bloco Financeiro, e como o cabeçalho de seção só compara com o item ANTERIOR,
 * a tela mostrava "Financeiro", depois "Aulas", depois "Financeiro" de novo.
 * `ai-costs` não tinha seção nenhuma. Não era só sensação de bagunça — era isso.
 *
 * Aqui cada entrada do menu é um GRUPO com abas. Duas garantias:
 *   1. Nenhuma tela foi apagada — as 39 continuam acessíveis, agora como aba.
 *   2. Nenhum link direto quebra. `DirectorPendingCenter`, os "Ver todos" e a
 *      allowlist de abas navegam por id; o id continua valendo e agora abre a
 *      tela já com o grupo certo em volta.
 *
 * ⚠️ Ao adicionar tela nova: inclua o id AQUI (como grupo ou como aba) e em
 * `allowedAdminTabs` no App.tsx. Fora daqui, ela não aparece no menu.
 */

export interface NavTab {
  id: string;
  label: string;
  /** Chave em pendingCounts — mostra contador na aba e no item do menu. */
  badgeKey?: string;
}

export interface NavGroup {
  /** Id da aba que abre ao clicar no menu (é sempre a primeira aba). */
  id: string;
  label: string;
  icon: ElementType;
  section: string;
  /** Uso diário: ganha lugar na barra inferior do celular. */
  primary?: boolean;
  badgeKey?: string;
  /** Vazio = tela única, sem abas. */
  tabs: NavTab[];
}

export const ADMIN_NAV: NavGroup[] = [
  // ── Dia a dia ─────────────────────────────────────────────────────────────
  { id: 'dashboard', label: 'Início', icon: LayoutDashboard, section: 'Dia a dia', primary: true, tabs: [] },
  { id: 'schedule_explorer', label: 'Mapa de Aulas', icon: CalendarClock, section: 'Dia a dia', primary: true, tabs: [] },
  {
    id: 'students', label: 'Alunos', icon: GraduationCap, section: 'Dia a dia', primary: true,
    tabs: [
      { id: 'students', label: 'Lista de alunos' },
      { id: 'student-insights', label: 'Painel de risco' },
    ],
  },
  {
    id: 'teachers', label: 'Professores', icon: Users, section: 'Dia a dia', badgeKey: 'acolhimento',
    tabs: [
      { id: 'teachers', label: 'Lista' },
      { id: 'teacher-insights', label: 'Scorecard' },
      { id: 'approvals', label: 'Acolhimento', badgeKey: 'acolhimento' },
      { id: 'recruiting', label: 'Recrutamento' },
      { id: 'hr', label: 'RH' },
    ],
  },

  // ── Financeiro ────────────────────────────────────────────────────────────
  // Eram 8 itens de menu. Oito entradas para uma coisa só é o que fazia a seção
  // parecer interminável — viraram duas, separadas pelo que se faz nelas:
  // movimentar dinheiro x entender o resultado.
  {
    id: 'student-payments', label: 'Dinheiro', icon: DollarSign, section: 'Financeiro', primary: true,
    tabs: [
      { id: 'student-payments', label: 'Mensalidades' },
      { id: 'payments', label: 'Repasse a profs' },
      { id: 'financial', label: 'Lançamentos' },
      { id: 'reconciliation', label: 'Reconciliação' },
    ],
  },
  {
    id: 'dre', label: 'Relatórios', icon: FileBarChart, section: 'Financeiro',
    tabs: [
      { id: 'dre', label: 'Resultado (DRE)' },
      { id: 'balancete', label: 'Balancete por prof' },
      { id: 'cashflow', label: 'Fluxo de caixa' },
      { id: 'margin', label: 'Custo e margem' },
      { id: 'ai-costs', label: 'Custo de IA' },
    ],
  },

  // ── Aulas ─────────────────────────────────────────────────────────────────
  { id: 'attendance-disputes', label: 'Verificar Presença', icon: ShieldAlert, section: 'Aulas', badgeKey: 'presenca', tabs: [] },
  {
    id: 'trials', label: 'Experimentais e Treinos', icon: Zap, section: 'Aulas', badgeKey: 'trials',
    tabs: [
      { id: 'trials', label: 'Agendar' },
      { id: 'trial-settlement', label: 'Liquidar', badgeKey: 'trials' },
      { id: 'training', label: 'Treinamentos' },
    ],
  },
  {
    // Reposição entrou aqui porque o diretor não tinha NENHUMA porta para ela:
    // a aba 'reschedules' só existia no menu do professor, então o passivo de
    // 102 reposições sem data (a mais antiga de 04/03/2026) não tinha dono nem
    // contador. Sem esta entrada, o link da Central de Pendências cairia na
    // allowlist e voltaria para o dashboard.
    id: 'coverage', label: 'Cobertura e Reposições', icon: CalendarOff, section: 'Aulas', badgeKey: 'reposicoes',
    tabs: [
      { id: 'coverage', label: 'Cobertura de profs' },
      { id: 'reschedules', label: 'Reposições', badgeKey: 'reposicoes' },
      { id: 'verify-rooms', label: 'Verificar salas' },
    ],
  },
  { id: 'oral-tests', label: 'Testes Orais', icon: Mic, section: 'Aulas', tabs: [] },

  // ── Pedagógico ────────────────────────────────────────────────────────────
  {
    id: 'pedagogical', label: 'Biblioteca', icon: Book, section: 'Pedagógico', badgeKey: 'materiais',
    tabs: [
      { id: 'pedagogical', label: 'Materiais' },
      { id: 'material-approvals', label: 'Aprovar', badgeKey: 'materiais' },
    ],
  },
  {
    id: 'learning_paths_builder', label: 'Trilhas', icon: Target, section: 'Pedagógico',
    tabs: [
      { id: 'learning_paths_builder', label: 'Trilhas' },
      { id: 'class_skills', label: 'Skills da turma' },
    ],
  },
  { id: 'wolfie-lab', label: 'Wolfie Lab', icon: Brain, section: 'Pedagógico', tabs: [] },

  // ── Crescimento ───────────────────────────────────────────────────────────
  { id: 'crm', label: 'CRM & Funil', icon: Users, section: 'Crescimento', tabs: [] },
  { id: 'marketing', label: 'Site & Vendas', icon: Globe, section: 'Crescimento', tabs: [] },
  {
    id: 'referral-admin', label: 'Indicações', icon: Gift, section: 'Crescimento',
    tabs: [
      { id: 'referral-admin', label: 'Programa' },
      { id: 'vendors-mgmt', label: 'Vendedores' },
    ],
  },

  // ── Configurações ─────────────────────────────────────────────────────────
  {
    id: 'settings_school', label: 'Configurações', icon: Settings, section: 'Configurações',
    tabs: [
      { id: 'settings_school', label: 'Branding' },
      { id: 'contracts', label: 'Contratos' },
      { id: 'automation', label: 'WhatsApp (conexão)' },
      { id: 'automations', label: 'Disparos' },
      { id: 'admin_workflows', label: 'Workflows' },
      { id: 'tenant_advanced', label: 'Avançada' },
    ],
  },
];

/** Grupo a que um id pertence — usado para desenhar as abas em volta da tela. */
export const groupForTab = (tabId: string): NavGroup | undefined =>
  ADMIN_NAV.find(g => g.id === tabId || g.tabs.some(t => t.id === tabId));

/** Todo id navegável do diretor (grupos + abas), sem repetição. */
export const ALL_ADMIN_TAB_IDS: string[] = Array.from(new Set(
  ADMIN_NAV.flatMap(g => [g.id, ...g.tabs.map(t => t.id)]),
));
