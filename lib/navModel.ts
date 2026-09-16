import type { ElementType } from 'react';
import {
  Activity, AlertCircle, Bell, Book, BookOpen, Brain, Calendar, CalendarClock, CreditCard,
  DollarSign, FileText, Gift, Globe, GraduationCap, LayoutDashboard, Mic, Repeat, Settings,
  Shield, Sparkles, Target, TrendingUp, UserPlus, Users, Video, Zap,
} from 'lucide-react';
import { UserRole } from '../types';
import { ADMIN_NAV, groupForTab } from './adminNav';

/**
 * Modelo de navegação — FONTE ÚNICA dos menus por papel.
 *
 * Os menus viviam como closures dentro do `ModernSidebar`. Com o layout de topo
 * (barra de categorias + trilho de atalhos, copiado do MotoFix) passam a existir
 * três superfícies lendo a mesma lista, e uma cópia em cada uma divergiria no
 * primeiro item novo. Aqui é puro: recebe o que varia (contador de pendentes) e
 * devolve a lista; quem renderiza decide a forma.
 */

export interface NavItem {
  /** Id da aba (chave do `renderContent` do App). */
  id: string;
  label: string;
  icon: ElementType;
  /** Badge fixo (número ou selo como "NOVO"). */
  badge?: number | string;
  /** Grupo do menu (ex.: "Pessoas", "Financeiro"). Menu sem seção é plano. */
  section?: string;
  /** Chave em `pendingCounts` que vira badge (ex.: "acolhimento"). */
  badgeKey?: string;
  /** Uso diário — ganha lugar na barra inferior do celular. */
  primary?: boolean;
  /**
   * Rótulo curto para o trilho de atalhos (64 px). Sem ele o trilho usa `label`,
   * que quebra em até 2 linhas — "Experimentais e Treinos" não cabe nem assim.
   */
  short?: string;
}

/** MIMEs do drag-and-drop dos atalhos (menu → trilho, trilho → trilho). */
export const DND_VIEW = 'application/x-wisewolf-view';
export const DND_INDEX = 'application/x-wisewolf-shortcut-index';

/** Papéis que podem escolher entre menu lateral e menu no topo. Os outros têm
 *  menu curto e sem seções — categoria no topo viraria uma fileira de botões. */
export const NAV_LAYOUT_ROLES: readonly string[] = [UserRole.SCHOOL_ADMIN, UserRole.TEACHER];

export const teacherMenuItems = (pendingLessonsCount: number): NavItem[] => [
  { id: 'dashboard', label: 'Início', icon: LayoutDashboard, section: 'Dia a dia', primary: true },
  { id: 'schedule', label: 'Agenda', icon: Calendar, section: 'Dia a dia', primary: true },
  { id: 'lessons', label: 'Lançar Aula', icon: BookOpen, section: 'Dia a dia', primary: true, short: 'Lançar' },
  { id: 'lesson-sessions', label: 'Salas e continuidade', icon: Video, section: 'Dia a dia', short: 'Salas' },
  { id: 'pending', label: 'Pendentes', icon: AlertCircle, section: 'Dia a dia', badge: pendingLessonsCount, primary: true },
  { id: 'reschedules', label: 'Reposições', icon: Repeat, section: 'Dia a dia' },
  { id: 'students', label: 'Alunos', icon: Users, section: 'Dia a dia' },
  { id: 'meeting_links', label: 'Links de Aula', icon: Video, section: 'Dia a dia', short: 'Links' },
  { id: 'teacher_workflows', label: 'Saída / Ausência', icon: AlertCircle, section: 'Dia a dia', short: 'Ausência' },

  { id: 'pedagogical', label: 'Materiais', icon: Book, section: 'Pedagógico' },
  { id: 'lesson-planner-ai', label: 'Planner IA', icon: Sparkles, section: 'Pedagógico' },
  { id: 'class_skills', label: 'Skills da Turma', icon: Activity, section: 'Pedagógico', short: 'Skills' },
  { id: 'oral-tests', label: 'Testes Orais', icon: Mic, section: 'Pedagógico', short: 'Orais' },
  { id: 'training', label: 'Treinamentos', icon: GraduationCap, section: 'Pedagógico', short: 'Treinos' },
  { id: 'wolfie-lab', label: 'Wolfie Lab', icon: Brain, section: 'Pedagógico' },

  { id: 'msg_settings', label: 'Mensagens', icon: Bell, section: 'Comunicação' },
  { id: 'automation', label: 'Smart', icon: Zap, section: 'Comunicação' },

  { id: 'teacher-financials', label: 'Financeiro', icon: DollarSign, section: 'Financeiro' },
  { id: 'invoices', label: 'Enviar NFS-e', icon: FileText, section: 'Financeiro', short: 'NFS-e' },

  { id: 'referral', label: 'Indicações', icon: Gift, section: 'Conta e carreira' },
  { id: 'contract_teacher', label: 'Meu Contrato', icon: FileText, section: 'Conta e carreira', short: 'Contrato' },
];

export const studentMenuItems: NavItem[] = [
  { id: 'dashboard', label: 'Meu Portal', icon: LayoutDashboard },
  // Nomes explícitos: "Wolfie Tutor" x "Praticar" não diziam ao aluno qual
  // era a prática livre e qual era a trilha do professor.
  { id: 'ai-tutor', label: 'Praticar com o Wolfie', icon: Sparkles, badge: 'NOVO' },
  { id: 'practice', label: 'Minhas Trilhas', icon: Target },
  { id: 'schedule', label: 'Aulas', icon: Calendar },
  { id: 'meeting_links', label: 'Links', icon: Video },
  { id: 'materials', label: 'Materiais', icon: Book },
  { id: 'financial', label: 'Financeiro', icon: CreditCard },
  { id: 'evolution', label: 'Evolução', icon: Sparkles },
  { id: 'training', label: 'Treinamentos', icon: GraduationCap },
  { id: 'referral', label: 'Indicações', icon: Gift },
];

// Deriva de ADMIN_NAV (lib/adminNav.ts), fonte única do menu e das abas.
// Rótulo curto do trilho: os grupos do diretor têm nomes compostos.
const ADMIN_SHORT: Record<string, string> = {
  schedule_explorer: 'Mapa',
  'student-payments': 'Dinheiro',
  'lesson-quality': 'Qualidade',
  'attendance-disputes': 'Presença',
  trials: 'Experim.',
  coverage: 'Cobertura',
  'oral-tests': 'Orais',
  learning_paths_builder: 'Trilhas',
  'wolfie-lab': 'Wolfie',
  crm: 'CRM',
  marketing: 'Site',
  'referral-admin': 'Indicações',
  settings_school: 'Config',
};

export const schoolAdminMenuItems: NavItem[] = ADMIN_NAV.map(g => ({
  id: g.id, label: g.label, icon: g.icon, section: g.section,
  badgeKey: g.badgeKey, primary: g.primary, short: ADMIN_SHORT[g.id],
}));

export const superAdminMenuItems: NavItem[] = [
  { id: 'dashboard', label: 'Visão Global', icon: Shield },
  { id: 'tenants', label: 'Tenants', icon: Globe },
  { id: 'billing', label: 'Faturamento', icon: DollarSign },
  { id: 'settings', label: 'Infra', icon: Settings },
  { id: 'automation', label: 'Smart', icon: Zap },
];

export const salespersonMenuItems: NavItem[] = [
  { id: 'vendor_dashboard', label: 'Dashboard', icon: TrendingUp },
  { id: 'vendor_schedule', label: 'Agenda Professores', icon: CalendarClock },
  { id: 'vendor_trial', label: 'Link Experimental', icon: Zap },
  { id: 'vendor_enrollment', label: 'Gerar Matrícula', icon: UserPlus },
  { id: 'vendor_commissions', label: 'Minhas Comissões', icon: DollarSign },
];

/** Lista de itens do papel. Puro: recebe o contador em vez de ler estado. */
export function buildMenuItems(role: UserRole | string, opts: { pendingLessonsCount: number }): NavItem[] {
  if (role === UserRole.SUPER_ADMIN) return superAdminMenuItems;
  if (role === UserRole.SCHOOL_ADMIN) return schoolAdminMenuItems;
  if (role === UserRole.STUDENT) return studentMenuItems;
  if (role === UserRole.SALESPERSON) return salespersonMenuItems;
  return teacherMenuItems(opts.pendingLessonsCount);
}

/**
 * Item do menu que deve aparecer aceso para a aba ativa. A aba pode ser uma
 * SUB-ABA do diretor (ex.: 'balancete' dentro de Relatórios); sem isto o menu
 * não destacaria nada e o diretor ficaria sem saber onde está.
 */
export function activeMenuIdFor(role: UserRole | string, activeTab: string, hasOverride = false): string {
  if (!hasOverride && role === UserRole.SCHOOL_ADMIN) return groupForTab(activeTab)?.id ?? activeTab;
  return activeTab;
}

/** Badge efetivo de um item: valor fixo OU contador de pendência via badgeKey. */
export function badgeOf(item: NavItem, pendingCounts: Record<string, number>): number | string | undefined {
  return item.badge ?? (item.badgeKey ? pendingCounts[item.badgeKey] : undefined);
}

/** Rótulo do trilho de atalhos. */
export const shortLabel = (item: NavItem): string => item.short ?? item.label;

/**
 * Agrupa por seção na ORDEM DE APARIÇÃO (o menu já vem ordenado por seção).
 * Item sem seção cai em "Menu" — só acontece em papel sem layout de topo, mas
 * a função não pode explodir se alguém passar a lista do aluno.
 */
export function groupBySection(items: NavItem[]): { section: string; items: NavItem[] }[] {
  const groups: { section: string; items: NavItem[] }[] = [];
  for (const item of items) {
    const section = item.section ?? 'Menu';
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.items.push(item);
    else groups.push({ section, items: [item] });
  }
  return groups;
}

/** Soma dos badges numéricos de um grupo — vira o contador do gatilho no topo. */
export function groupBadge(items: NavItem[], pendingCounts: Record<string, number>): number {
  return items.reduce((sum, it) => {
    const b = badgeOf(it, pendingCounts);
    return sum + (typeof b === 'number' && b > 0 ? b : 0);
  }, 0);
}
