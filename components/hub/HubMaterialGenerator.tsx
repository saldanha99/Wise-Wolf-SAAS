import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  ClipboardList,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Layers,
  ListChecks,
  Map,
  MessageSquare,
  Printer,
  RefreshCw,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { HubBootstrap } from './types';

// Gerador de material do Hub: o professor autônomo escolhe tipo × nicho × nível
// × tema e recebe um material pronto para usar com o aluno dele — sem perfil de
// aluno, sem planner. A geração acontece na edge `pedagogical-content`
// (hubMode + action=material), que cobra 1 unidade de `educator_ai.generate`,
// audita o gabarito e guarda o resultado em `hub_educator_materials`.
// Aqui só existe o que é do navegador: formulário, histórico, renderização e
// impressão (versão do aluno ou versão do professor, com gabarito).

export type HubMaterialKind = 'worksheet' | 'quiz' | 'vocab_cards' | 'grammar_drill' | 'reading' | 'conversation' | 'journey';

interface McQuestion { prompt: string; options: string[]; correct: number; explanation_pt: string }
interface Pair { en: string; pt: string }

export type HubMaterialAudience = 'kids' | 'teens' | 'adults';

export interface HubMaterialRecord {
  id: string;
  kind: HubMaterialKind;
  niche: string;
  level_tag: string;
  topic: string;
  goal?: string;
  audience?: HubMaterialAudience;
  title: string;
  created_at: string;
  dropped_items: number;
  material: Record<string, unknown>;
}

export const HUB_MATERIAL_AUDIENCE_OPTIONS: Array<{ value: HubMaterialAudience; label: string }> = [
  { value: 'adults', label: 'Adulto' },
  { value: 'teens', label: 'Adolescente' },
  { value: 'kids', label: 'Criança' },
];

interface HubMaterialGeneratorProps {
  bootstrap: HubBootstrap;
  onRefresh: () => Promise<void>;
  onUpgrade: () => void;
}

export const HUB_MATERIAL_KIND_OPTIONS: Array<{ value: HubMaterialKind; label: string; hint: string; icon: React.ReactNode }> = [
  { value: 'worksheet', label: 'Worksheet', hint: 'Aquecimento, lacunas, múltipla escolha, abertas e lição', icon: <ClipboardList size={18} /> },
  { value: 'quiz', label: 'Quiz', hint: 'Múltipla escolha com gabarito comentado', icon: <ListChecks size={18} /> },
  { value: 'vocab_cards', label: 'Cards de vocabulário', hint: 'Termo, tradução, definição e exemplo', icon: <Layers size={18} /> },
  { value: 'grammar_drill', label: 'Drill de gramática', hint: 'Regra explicada + exercícios de lacuna', icon: <Wand2 size={18} /> },
  { value: 'reading', label: 'Leitura', hint: 'Texto no nível, glossário e compreensão', icon: <BookOpen size={18} /> },
  { value: 'conversation', label: 'Conversação', hint: 'Situação, papéis, frases úteis e diálogo-modelo', icon: <MessageSquare size={18} /> },
  { value: 'journey', label: 'Jornada de 90 dias', hint: '12 semanas por objetivo, com progressão gramatical, checkpoints e retenção', icon: <Map size={18} /> },
];

export const HUB_MATERIAL_NICHE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'GENERAL', label: '🌎 Geral' },
  { value: 'BUSINESS', label: '💼 Business' },
  { value: 'TECH', label: '💻 Tech / TI' },
  { value: 'TRAVEL', label: '✈️ Viagem' },
  { value: 'MEDICINE', label: '🏥 Saúde' },
  { value: 'KIDS', label: '🧸 Crianças' },
  { value: 'TOEFL_IELTS', label: '🎓 TOEFL / IELTS' },
  { value: 'CONVERSATION', label: '💬 Conversação' },
];

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const ERROR_MESSAGES: Record<string, string> = {
  USAGE_LIMIT_REACHED: 'Você usou todas as gerações do seu plano neste período. Escolha um plano maior para continuar.',
  FEATURE_NOT_INCLUDED: 'Gerações com IA não estão incluídas no seu plano atual.',
  SUBSCRIPTION_REQUIRED: 'Seu teste terminou. Escolha um plano para continuar gerando material.',
  AI_PROVIDER_INVALID_RESPONSE: 'A IA não entregou um material dentro do padrão (gabarito ou seções incompletas). Nada foi cobrado — tente de novo ou ajuste o tema.',
  AI_PROVIDER_UNAVAILABLE: 'O provedor de IA está indisponível agora. Tente novamente em instantes; nada foi cobrado.',
  MATERIAL_TOPIC_REQUIRED: 'Descreva o tema do material (mínimo 3 caracteres).',
  INVALID_MATERIAL_COUNT: 'Escolha entre 4 e 15 itens.',
  HUB_ACCESS_UNAVAILABLE: 'Não foi possível confirmar seu acesso. Recarregue a página e tente de novo.',
  AI_DISABLED_FOR_TEST_FIXTURE: 'Conta de teste: geração desativada.',
};

const friendlyError = (value: unknown): string => {
  const code = value instanceof Error
    ? value.message
    : value && typeof value === 'object' && typeof (value as Record<string, unknown>).code === 'string'
      ? String((value as Record<string, unknown>).code)
      : value && typeof value === 'object' && typeof (value as Record<string, unknown>).error === 'string'
        ? String((value as Record<string, unknown>).error)
        : '';
  return ERROR_MESSAGES[code] || 'Não foi possível gerar o material agora. Tente de novo.';
};

const kindLabel = (kind: string) => HUB_MATERIAL_KIND_OPTIONS.find((option) => option.value === kind)?.label || kind;
const nicheLabel = (niche: string) => HUB_MATERIAL_NICHE_OPTIONS.find((option) => option.value === niche)?.label || niche;
const letter = (index: number) => String.fromCharCode(65 + index);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const questionList = (value: unknown): McQuestion[] => Array.isArray(value)
  ? value.flatMap((item) => isRecord(item) && typeof item.prompt === 'string' && Array.isArray(item.options)
    ? [{ prompt: item.prompt, options: strList(item.options), correct: Number(item.correct), explanation_pt: typeof item.explanation_pt === 'string' ? item.explanation_pt : '' }]
    : [])
  : [];
const pairList = (value: unknown, a: string, b: string): Pair[] => Array.isArray(value)
  ? value.flatMap((item) => isRecord(item) && typeof item[a] === 'string' && typeof item[b] === 'string' ? [{ en: item[a] as string, pt: item[b] as string }] : [])
  : [];

// Texto puro do material (para colar em documento ou WhatsApp). Sempre a versão
// do professor: quem copia é quem ensina.
export const materialAsText = (record: HubMaterialRecord): string => {
  const m = record.material;
  const lines: string[] = [`${record.title} — ${record.level_tag} · ${nicheLabel(record.niche).replace(/^[^\s\w]+\s*/, '')}`, ''];
  if (record.goal) lines.push(`Objetivo do aluno: ${record.goal}`, '');
  if (typeof m.opportunity_pt === 'string' && m.opportunity_pt) lines.push(`Porta que abre: ${m.opportunity_pt}`, '');
  if (isRecord(m.grammar_focus) && typeof m.grammar_focus.point === 'string') {
    lines.push(`Foco gramatical (${record.level_tag}): ${m.grammar_focus.point}`);
    if (typeof m.grammar_focus.why_pt === 'string' && m.grammar_focus.why_pt) lines.push(`  ${m.grammar_focus.why_pt}`);
    pairList(m.grammar_focus.patterns, 'en', 'pt').forEach((pair) => lines.push(`  • ${pair.en} — ${pair.pt}`));
    strList(m.grammar_focus.watch_out_pt).forEach((item) => lines.push(`  ⚠ ${item}`));
    lines.push('');
  }
  const pushQuestions = (heading: string, questions: McQuestion[]) => {
    if (!questions.length) return;
    lines.push(heading);
    questions.forEach((question, index) => {
      lines.push(`${index + 1}. ${question.prompt}`);
      question.options.forEach((option, optionIndex) => lines.push(`   ${letter(optionIndex)}) ${option}`));
    });
    lines.push('', `Gabarito: ${questions.map((question, index) => `${index + 1}-${letter(question.correct)}`).join(' · ')}`, '');
  };
  switch (record.kind) {
    case 'quiz':
      if (typeof m.instructions_pt === 'string') lines.push(m.instructions_pt, '');
      pushQuestions('Questões', questionList(m.questions));
      break;
    case 'vocab_cards':
      (Array.isArray(m.cards) ? m.cards : []).forEach((card) => {
        if (!isRecord(card)) return;
        lines.push(`• ${card.term} — ${card.translation_pt}`, `  ${card.definition_en}`, `  "${card.example}" (${card.example_pt})`);
      });
      break;
    case 'grammar_drill':
      lines.push(`Regra: ${m.rule_pt}`, '');
      pairList(m.examples, 'en', 'pt').forEach((pair) => lines.push(`• ${pair.en} — ${pair.pt}`));
      lines.push('');
      pushQuestions('Exercícios', questionList(m.exercises));
      break;
    case 'reading': {
      const strategies = isRecord(m.strategies) ? m.strategies : {};
      const skimming = isRecord(strategies.skimming) ? strategies.skimming : null;
      if (skimming && typeof skimming.question === 'string') lines.push(`Skimming (${String(skimming.time_seconds || 60)} s): ${String(skimming.instruction_pt || '')} — ${skimming.question}`, '');
      lines.push(String(m.text || ''), '');
      const scanning = pairList(strategies.scanning, 'question', 'answer');
      if (scanning.length) { lines.push('Scanning:'); scanning.forEach((pair, index) => lines.push(`${index + 1}. ${pair.en} → ${pair.pt}`)); lines.push(''); }
      const chunks = pairList(strategies.chunks, 'chunk', 'pt');
      if (chunks.length) { lines.push('Chunking:'); chunks.forEach((pair) => lines.push(`• ${pair.en} — ${pair.pt}`)); lines.push(''); }
      const shadowing = isRecord(strategies.shadowing) ? strategies.shadowing : null;
      if (shadowing && typeof shadowing.passage === 'string' && shadowing.passage) lines.push(`Shadowing: "${shadowing.passage}"`, `  Foco: ${String(shadowing.focus_pt || '')}`, '');
      lines.push('Glossário:');
      pairList(m.glossary, 'term', 'translation_pt').forEach((pair) => lines.push(`• ${pair.en} — ${pair.pt}`));
      lines.push('');
      pushQuestions('Compreensão', questionList(m.questions));
      strList(m.discussion).forEach((item, index) => lines.push(`Discussão ${index + 1}: ${item}`));
      break;
    }
    case 'worksheet': {
      if (typeof m.objective_pt === 'string') lines.push(`Objetivo: ${m.objective_pt}`, '');
      const warm = strList(m.warm_up);
      if (warm.length) lines.push('Warm-up:', ...warm.map((item) => `• ${item}`), '');
      const blanks = Array.isArray(m.fill_blanks) ? m.fill_blanks.filter(isRecord) : [];
      if (blanks.length) {
        lines.push('Complete as lacunas:');
        blanks.forEach((item, index) => lines.push(`${index + 1}. ${item.prompt}${item.hint_pt ? `  (dica: ${item.hint_pt})` : ''}`));
        lines.push(`Respostas: ${blanks.map((item, index) => `${index + 1}-${item.answer}`).join(' · ')}`, '');
      }
      pushQuestions('Múltipla escolha', questionList(m.multiple_choice));
      const open = Array.isArray(m.open_questions) ? m.open_questions.filter(isRecord) : [];
      if (open.length) {
        lines.push('Perguntas abertas:');
        open.forEach((item, index) => lines.push(`${index + 1}. ${item.prompt}`, `   Resposta-modelo: ${item.model_answer}`));
        lines.push('');
      }
      if (typeof m.homework_pt === 'string' && m.homework_pt) lines.push(`Lição de casa: ${m.homework_pt}`);
      break;
    }
    case 'journey': {
      if (typeof m.promise_pt === 'string' && m.promise_pt) lines.push(`Promessa do dia 90: ${m.promise_pt}`, '');
      (Array.isArray(m.weeks) ? m.weeks.filter(isRecord) : []).forEach((week) => {
        lines.push(`Semana ${String(week.week)} — ${String(week.theme)} · ${String(week.grammar_point)} · ${kindLabel(String(week.material_kind))}`);
        if (week.outcome_pt) lines.push(`  Resultado: ${String(week.outcome_pt)}`);
        strList(week.class_plan_pt).forEach((step, index) => lines.push(`  ${index + 1}) ${step}`));
        if (week.homework_pt) lines.push(`  Lição: ${String(week.homework_pt)}`);
      });
      const milestones = Array.isArray(m.milestones) ? m.milestones.filter(isRecord) : [];
      if (milestones.length) { lines.push('', 'Checkpoints:'); milestones.forEach((item) => lines.push(`• Semana ${String(item.week)}: ${String(item.checkpoint_pt)}`)); }
      const moves = Array.isArray(m.retention_moves_pt) ? m.retention_moves_pt.filter(isRecord) : [];
      if (moves.length) { lines.push('', 'Ações de retenção:'); moves.forEach((item) => lines.push(`• Semana ${String(item.week)}: ${String(item.move_pt)}`)); }
      break;
    }
    case 'conversation':
      lines.push(`Situação: ${m.situation_pt}`, '');
      pairList(m.roles, 'name', 'description_pt').forEach((pair) => lines.push(`Papel — ${pair.en}: ${pair.pt}`));
      lines.push('', 'Frases úteis:');
      pairList(m.useful_phrases, 'en', 'pt').forEach((pair) => lines.push(`• ${pair.en} — ${pair.pt}`));
      lines.push('', 'Diálogo-modelo:');
      pairList(m.dialogue, 'speaker', 'line').forEach((pair) => lines.push(`${pair.en}: ${pair.pt}`));
      lines.push('');
      if (isRecord(m.shadowing) && strList(m.shadowing.lines).length) {
        lines.push('Shadowing (repita em voz alta):', ...strList(m.shadowing.lines).map((line) => `• ${line}`), `  Foco: ${String(m.shadowing.focus_pt || '')}`, '');
      }
      strList(m.practice_questions).forEach((item, index) => lines.push(`Pratique ${index + 1}: ${item}`));
      if (typeof m.teacher_notes_pt === 'string' && m.teacher_notes_pt) lines.push('', `Notas para o professor: ${m.teacher_notes_pt}`);
      break;
  }
  const homework = Array.isArray(m.ai_homework) ? m.ai_homework.filter(isRecord) : [];
  if (homework.length) {
    lines.push('', 'Homework com IA:');
    homework.forEach((item, index) => {
      lines.push(`${index + 1}. ${String(item.task_pt || '')}`, `   Prompt: ${String(item.prompt_en || '')}`);
      if (item.tip_pt) lines.push(`   Dica: ${String(item.tip_pt)}`);
    });
  }
  lines.push('', 'Gerado no Wise Wolf Hub · Educador IA');
  return lines.join('\n');
};

// ─── Renderização por tipo ──────────────────────────────────────────────────

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="mt-6 text-[11px] font-black uppercase tracking-[0.18em] text-tenant-primary print:text-black">{children}</h3>
);

const Questions: React.FC<{ questions: McQuestion[]; teacher: boolean }> = ({ questions, teacher }) => (
  <ol className="mt-3 space-y-4">
    {questions.map((question, index) => (
      <li key={index} className="break-inside-avoid">
        <p className="font-bold text-brand-text print:text-black">{index + 1}. {question.prompt}</p>
        <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
          {question.options.map((option, optionIndex) => {
            const isKey = teacher && optionIndex === question.correct;
            return (
              <li key={optionIndex} className={`rounded-xl border px-3 py-1.5 text-sm ${isKey ? 'border-emerald-400 bg-emerald-50 font-bold text-emerald-900 print:bg-white' : 'border-brand-border text-brand-text print:text-black'}`}>
                <span className="mr-2 font-black">{letter(optionIndex)})</span>{option}{isKey && <Check className="ml-2 inline" size={14} aria-label="resposta correta" />}
              </li>
            );
          })}
        </ul>
        {teacher && question.explanation_pt && <p className="mt-1.5 text-xs italic text-brand-muted print:text-black">{question.explanation_pt}</p>}
      </li>
    ))}
  </ol>
);

const PairTable: React.FC<{ pairs: Pair[]; left: string; right: string; hideRight?: boolean }> = ({ pairs, left, right, hideRight = false }) => (
  <table className="mt-3 w-full border-collapse text-sm">
    <thead><tr className="text-left text-[10px] font-black uppercase tracking-widest text-brand-muted print:text-black"><th className="border-b border-brand-border py-1.5 pr-3">{left}</th><th className="border-b border-brand-border py-1.5">{right}</th></tr></thead>
    <tbody>{pairs.map((pair, index) => <tr key={index} className="align-top"><td className="border-b border-brand-border/60 py-1.5 pr-3 font-bold text-brand-text print:text-black">{pair.en}</td><td className="border-b border-brand-border/60 py-1.5 text-brand-text print:text-black">{hideRight ? '' : pair.pt}</td></tr>)}</tbody>
  </table>
);

export const HubMaterialView: React.FC<{ record: HubMaterialRecord; teacher: boolean; onGenerateWeek?: (week: { week: number; theme: string; material_kind: HubMaterialKind }) => void }> = ({ record, teacher, onGenerateWeek }) => {
  const m = record.material;
  return (
    <article id="hub-material-print" className="rounded-[2rem] border border-brand-border bg-white p-6 text-slate-900 shadow-sm print:rounded-none print:border-0 print:p-0 print:shadow-none sm:p-8">
      <header className="border-b border-brand-border pb-4">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-tenant-primary print:text-black">{kindLabel(record.kind)} · {record.level_tag} · {nicheLabel(record.niche)}</p>
        <h2 className="mt-2 text-2xl font-black tracking-tight">{record.title}</h2>
        <p className="mt-1 text-sm text-slate-500">Tema: {record.topic}{record.goal ? ` · Objetivo: ${record.goal}` : ''}{teacher ? ' · versão do professor (com gabarito)' : ' · versão do aluno'}</p>
      </header>

      {typeof m.opportunity_pt === 'string' && m.opportunity_pt && (
        <p className="mt-4 rounded-2xl border border-tenant-primary/30 bg-tenant-primary/5 p-4 text-sm print:border-slate-300 print:bg-white"><span className="font-black">Porta que abre: </span>{m.opportunity_pt}</p>
      )}

      {isRecord(m.grammar_focus) && typeof m.grammar_focus.point === 'string' && (
        <section className="mt-4 rounded-2xl border border-brand-border p-4 print:break-inside-avoid">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary print:text-black">Foco gramatical · {record.level_tag}</p>
          <p className="mt-1 text-lg font-black">{m.grammar_focus.point}</p>
          {typeof m.grammar_focus.why_pt === 'string' && m.grammar_focus.why_pt && <p className="mt-1 text-sm text-slate-600">{m.grammar_focus.why_pt}</p>}
          {pairList(m.grammar_focus.patterns, 'en', 'pt').length > 0 && <PairTable pairs={pairList(m.grammar_focus.patterns, 'en', 'pt')} left="Padrão" right="Português" />}
          {teacher && strList(m.grammar_focus.watch_out_pt).length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-800 print:text-black">{strList(m.grammar_focus.watch_out_pt).map((item, index) => <li key={index}>Atenção: {item}</li>)}</ul>
          )}
        </section>
      )}

      {record.kind === 'quiz' && (<>
        {typeof m.instructions_pt === 'string' && m.instructions_pt && <p className="mt-4 text-sm">{m.instructions_pt}</p>}
        <SectionTitle>Questões</SectionTitle>
        <Questions questions={questionList(m.questions)} teacher={teacher} />
      </>)}

      {record.kind === 'vocab_cards' && (<>
        {typeof m.instructions_pt === 'string' && m.instructions_pt && <p className="mt-4 text-sm">{m.instructions_pt}</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(Array.isArray(m.cards) ? m.cards.filter(isRecord) : []).map((card, index) => (
            <div key={index} className="break-inside-avoid rounded-2xl border border-brand-border p-4">
              <p className="text-lg font-black">{String(card.term)}</p>
              <p className="text-sm font-bold text-tenant-primary print:text-black">{String(card.translation_pt)}</p>
              <p className="mt-2 text-sm">{String(card.definition_en)}</p>
              <p className="mt-2 text-sm italic">“{String(card.example)}”</p>
              {teacher && <p className="text-xs text-slate-500">{String(card.example_pt)}</p>}
            </div>
          ))}
        </div>
      </>)}

      {record.kind === 'grammar_drill' && (<>
        <SectionTitle>Regra</SectionTitle>
        <p className="mt-2 rounded-2xl bg-slate-50 p-4 text-sm print:bg-white print:p-0">{String(m.rule_pt)}</p>
        {pairList(m.examples, 'en', 'pt').length > 0 && (<><SectionTitle>Exemplos</SectionTitle><PairTable pairs={pairList(m.examples, 'en', 'pt')} left="Inglês" right="Português" /></>)}
        <SectionTitle>Exercícios</SectionTitle>
        <Questions questions={questionList(m.exercises)} teacher={teacher} />
      </>)}

      {record.kind === 'reading' && (<>
        {isRecord(m.strategies) && isRecord(m.strategies.skimming) && typeof m.strategies.skimming.question === 'string' && m.strategies.skimming.question && (
          <p className="mt-4 rounded-2xl bg-slate-50 p-3 text-sm print:bg-white print:p-0"><span className="font-black">Skimming ({String(m.strategies.skimming.time_seconds || 60)} s): </span>{String(m.strategies.skimming.instruction_pt || '')} <span className="italic">{m.strategies.skimming.question}</span></p>
        )}
        <SectionTitle>Texto</SectionTitle>
        {String(m.text || '').split(/\n+/).map((paragraph, index) => <p key={index} className="mt-3 text-[15px] leading-7">{paragraph}</p>)}
        {isRecord(m.strategies) && pairList(m.strategies.scanning, 'question', 'answer').length > 0 && (<>
          <SectionTitle>Scanning</SectionTitle>
          <ol className="mt-2 space-y-1.5 text-sm">
            {pairList(m.strategies.scanning, 'question', 'answer').map((pair, index) => <li key={index}>{index + 1}. {pair.en}{teacher && <span className="ml-2 rounded-lg bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-900 print:bg-white">→ {pair.pt}</span>}</li>)}
          </ol>
        </>)}
        {isRecord(m.strategies) && pairList(m.strategies.chunks, 'chunk', 'pt').length > 0 && (<>
          <SectionTitle>Chunking</SectionTitle>
          <PairTable pairs={pairList(m.strategies.chunks, 'chunk', 'pt')} left="Bloco de sentido" right={teacher ? 'Português' : 'Sua tradução'} hideRight={!teacher} />
        </>)}
        {isRecord(m.strategies) && isRecord(m.strategies.shadowing) && typeof m.strategies.shadowing.passage === 'string' && m.strategies.shadowing.passage && (<>
          <SectionTitle>Shadowing</SectionTitle>
          <p className="mt-2 text-[15px] italic leading-7">“{m.strategies.shadowing.passage}”</p>
          {typeof m.strategies.shadowing.focus_pt === 'string' && m.strategies.shadowing.focus_pt && <p className="mt-1 text-xs text-slate-500">Foco: {m.strategies.shadowing.focus_pt}</p>}
        </>)}
        {pairList(m.glossary, 'term', 'translation_pt').length > 0 && (<><SectionTitle>Glossário</SectionTitle><PairTable pairs={pairList(m.glossary, 'term', 'translation_pt')} left="Termo" right="Tradução" /></>)}
        <SectionTitle>Compreensão</SectionTitle>
        <Questions questions={questionList(m.questions)} teacher={teacher} />
        {strList(m.discussion).length > 0 && (<><SectionTitle>Para conversar</SectionTitle><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{strList(m.discussion).map((item, index) => <li key={index}>{item}</li>)}</ul></>)}
      </>)}

      {record.kind === 'worksheet' && (<>
        {typeof m.objective_pt === 'string' && m.objective_pt && <p className="mt-4 text-sm"><span className="font-black">Objetivo:</span> {m.objective_pt}</p>}
        {strList(m.warm_up).length > 0 && (<><SectionTitle>Warm-up</SectionTitle><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{strList(m.warm_up).map((item, index) => <li key={index}>{item}</li>)}</ul></>)}
        {Array.isArray(m.fill_blanks) && m.fill_blanks.length > 0 && (<>
          <SectionTitle>Complete as lacunas</SectionTitle>
          <ol className="mt-2 space-y-2 text-sm">
            {m.fill_blanks.filter(isRecord).map((item, index) => (
              <li key={index} className="break-inside-avoid">
                {index + 1}. {String(item.prompt)}
                {teacher && <span className="ml-2 rounded-lg bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-900 print:bg-white">→ {String(item.answer)}</span>}
                {!teacher && item.hint_pt ? <span className="ml-2 text-xs text-slate-500">(dica: {String(item.hint_pt)})</span> : null}
              </li>
            ))}
          </ol>
        </>)}
        {questionList(m.multiple_choice).length > 0 && (<><SectionTitle>Múltipla escolha</SectionTitle><Questions questions={questionList(m.multiple_choice)} teacher={teacher} /></>)}
        {Array.isArray(m.open_questions) && m.open_questions.length > 0 && (<>
          <SectionTitle>Perguntas abertas</SectionTitle>
          <ol className="mt-2 space-y-3 text-sm">
            {m.open_questions.filter(isRecord).map((item, index) => (
              <li key={index} className="break-inside-avoid">
                <p>{index + 1}. {String(item.prompt)}</p>
                {teacher ? <p className="mt-1 text-xs italic text-slate-500">Resposta-modelo: {String(item.model_answer)}</p> : <div className="mt-2 h-10 border-b border-dashed border-slate-300" aria-hidden="true" />}
              </li>
            ))}
          </ol>
        </>)}
        {typeof m.homework_pt === 'string' && m.homework_pt && (<><SectionTitle>Lição de casa</SectionTitle><p className="mt-2 text-sm">{m.homework_pt}</p></>)}
      </>)}

      {record.kind === 'journey' && (<>
        {typeof m.promise_pt === 'string' && m.promise_pt && <p className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm print:bg-white print:p-0"><span className="font-black">Promessa do dia 90: </span>{m.promise_pt}</p>}
        <SectionTitle>As 12 semanas</SectionTitle>
        <ol className="mt-3 space-y-3">
          {(Array.isArray(m.weeks) ? m.weeks.filter(isRecord) : []).map((week) => (
            <li key={String(week.week)} className="break-inside-avoid rounded-2xl border border-brand-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-tenant-primary print:text-black">Semana {String(week.week)} · {String(week.grammar_point)}</p>
                  <p className="mt-1 text-base font-black">{String(week.theme)}</p>
                  {typeof week.outcome_pt === 'string' && week.outcome_pt && <p className="mt-1 text-sm text-slate-600">{week.outcome_pt}</p>}
                </div>
                {onGenerateWeek && (
                  <button type="button" onClick={() => onGenerateWeek({ week: Number(week.week), theme: String(week.theme), material_kind: String(week.material_kind) as HubMaterialKind })} className="shrink-0 rounded-xl border border-tenant-primary/40 px-3 py-1.5 text-xs font-black text-tenant-primary print:hidden">Gerar {kindLabel(String(week.material_kind)).toLowerCase()} desta semana</button>
                )}
              </div>
              {strList(week.class_plan_pt).length > 0 && <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm">{strList(week.class_plan_pt).map((step, index) => <li key={index}>{step}</li>)}</ol>}
              {typeof week.homework_pt === 'string' && week.homework_pt && <p className="mt-2 text-xs text-slate-500">Lição: {week.homework_pt}</p>}
            </li>
          ))}
        </ol>
        {Array.isArray(m.milestones) && m.milestones.filter(isRecord).length > 0 && (<>
          <SectionTitle>Checkpoints</SectionTitle>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{m.milestones.filter(isRecord).map((item, index) => <li key={index}><span className="font-black">Semana {String(item.week)}:</span> {String(item.checkpoint_pt)}</li>)}</ul>
        </>)}
        {teacher && Array.isArray(m.retention_moves_pt) && m.retention_moves_pt.filter(isRecord).length > 0 && (<>
          <SectionTitle>Ações de retenção (para o professor)</SectionTitle>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{m.retention_moves_pt.filter(isRecord).map((item, index) => <li key={index}><span className="font-black">Semana {String(item.week)}:</span> {String(item.move_pt)}</li>)}</ul>
        </>)}
      </>)}

      {record.kind === 'conversation' && (<>
        <p className="mt-4 text-sm"><span className="font-black">Situação:</span> {String(m.situation_pt)}</p>
        {pairList(m.roles, 'name', 'description_pt').length > 0 && (<><SectionTitle>Papéis</SectionTitle><PairTable pairs={pairList(m.roles, 'name', 'description_pt')} left="Papel" right="Quem é" /></>)}
        <SectionTitle>Frases úteis</SectionTitle>
        <PairTable pairs={pairList(m.useful_phrases, 'en', 'pt')} left="Inglês" right="Português" />
        <SectionTitle>Diálogo-modelo</SectionTitle>
        <div className="mt-2 space-y-1.5 text-sm">
          {pairList(m.dialogue, 'speaker', 'line').map((turn, index) => <p key={index}><span className="font-black">{turn.en}:</span> {turn.pt}</p>)}
        </div>
        {isRecord(m.shadowing) && strList(m.shadowing.lines).length > 0 && (<>
          <SectionTitle>Shadowing</SectionTitle>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm italic">{strList(m.shadowing.lines).map((line, index) => <li key={index}>{line}</li>)}</ul>
          {typeof m.shadowing.focus_pt === 'string' && m.shadowing.focus_pt && <p className="mt-1 text-xs text-slate-500">Foco: {m.shadowing.focus_pt}</p>}
        </>)}
        {strList(m.practice_questions).length > 0 && (<><SectionTitle>Agora sem roteiro</SectionTitle><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{strList(m.practice_questions).map((item, index) => <li key={index}>{item}</li>)}</ul></>)}
        {teacher && typeof m.teacher_notes_pt === 'string' && m.teacher_notes_pt && (<><SectionTitle>Notas para o professor</SectionTitle><p className="mt-2 rounded-2xl bg-amber-50 p-4 text-sm print:bg-white print:p-0">{m.teacher_notes_pt}</p></>)}
      </>)}

      {Array.isArray(m.ai_homework) && m.ai_homework.filter(isRecord).length > 0 && (
        <section className="mt-6 rounded-2xl border border-dashed border-brand-border p-4 print:break-inside-avoid">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary print:text-black">Homework com IA</p>
          <p className="mt-1 text-xs text-slate-500">Cole o prompt no ChatGPT ou no Wolfie e siga a conversa. Traga o resultado para a próxima aula.</p>
          <ol className="mt-3 space-y-3 text-sm">
            {m.ai_homework.filter(isRecord).map((item, index) => (
              <li key={index}>
                <p className="font-bold">{index + 1}. {String(item.task_pt || '')}</p>
                <pre className="mt-1 whitespace-pre-wrap rounded-xl bg-slate-50 p-3 font-mono text-xs print:bg-white print:p-0">{String(item.prompt_en || '')}</pre>
                {teacher && item.tip_pt ? <p className="mt-1 text-xs italic text-slate-500">Dica: {String(item.tip_pt)}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer className="mt-8 border-t border-brand-border pt-3 text-[10px] uppercase tracking-widest text-slate-400">Gerado no Wise Wolf Hub · Educador IA</footer>
    </article>
  );
};

// ─── Componente principal ───────────────────────────────────────────────────

const HubMaterialGenerator: React.FC<HubMaterialGeneratorProps> = ({ bootstrap, onRefresh, onUpgrade }) => {
  const entitlement = bootstrap.entitlements['educator_ai.generate'];
  const [kind, setKind] = useState<HubMaterialKind>('worksheet');
  const [niche, setNiche] = useState('GENERAL');
  const [level, setLevel] = useState('A2');
  const [topic, setTopic] = useState('');
  const [goal, setGoal] = useState('');
  const [audience, setAudience] = useState<HubMaterialAudience>('adults');
  const [count, setCount] = useState(8);
  const [bilingual, setBilingual] = useState(true);
  const [extra, setExtra] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState<HubMaterialRecord | null>(null);
  const [teacherVersion, setTeacherVersion] = useState(true);
  const [history, setHistory] = useState<HubMaterialRecord[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [copied, setCopied] = useState(false);

  const remaining = useMemo(() => {
    if (!entitlement) return 0;
    if (entitlement.limit == null) return null;
    return Math.max(entitlement.limit - (entitlement.used || 0), 0);
  }, [entitlement]);
  const blocked = !entitlement || entitlement.limit === 0;

  const loadHistory = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from('hub_educator_materials')
      .select('id,kind,niche,level_tag,topic,goal,audience,title,created_at,dropped_items,material')
      .eq('account_id', bootstrap.account.id)
      .order('created_at', { ascending: false })
      .limit(30);
    if (loadError) {
      setHistoryError('Não foi possível carregar seus materiais anteriores.');
      return;
    }
    setHistoryError('');
    setHistory(((data || []) as unknown[]).flatMap((row) => isRecord(row) && typeof row.id === 'string' && isRecord(row.material)
      ? [{
        id: row.id,
        kind: String(row.kind) as HubMaterialKind,
        niche: String(row.niche || 'GENERAL'),
        level_tag: String(row.level_tag || ''),
        topic: String(row.topic || ''),
        goal: typeof row.goal === 'string' ? row.goal : '',
        audience: (['kids', 'teens', 'adults'].includes(String(row.audience)) ? String(row.audience) : 'adults') as HubMaterialAudience,
        title: String(row.title || ''),
        created_at: String(row.created_at || ''),
        dropped_items: Number(row.dropped_items || 0),
        material: row.material,
      }]
      : []));
  }, [bootstrap.account.id]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  // "Gerar material desta semana": a jornada vira o material da semana com um
  // clique — o mesmo objetivo, nível e faixa; tema e tipo vêm da semana.
  const [weekNote, setWeekNote] = useState('');
  const prefillFromWeek = (week: { week: number; theme: string; material_kind: HubMaterialKind }) => {
    setKind(week.material_kind);
    setTopic(week.theme);
    setWeekNote(`Semana ${week.week} da jornada`);
    setExtra((current) => current || `Material da semana ${week.week} da jornada de 90 dias.`);
    document.getElementById('hub-material-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const generate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (topic.trim().length < 3) {
      setError(ERROR_MESSAGES.MATERIAL_TOPIC_REQUIRED);
      return;
    }
    setGenerating(true);
    setError('');
    try {
      const { data, error: invokeError } = await supabase.functions.invoke<unknown>('pedagogical-content', {
        body: {
          hubMode: true,
          action: 'material',
          accountId: bootstrap.account.id,
          requestKey: crypto.randomUUID(),
          kind,
          niche,
          level,
          topic: topic.trim(),
          goal: goal.trim(),
          audience,
          count: kind === 'journey' ? 12 : count,
          bilingual,
          extra: extra.trim(),
        },
      });
      let payload = data as Record<string, unknown> | null;
      if (invokeError) {
        const response = (invokeError as { context?: Response }).context;
        if (response && typeof response.json === 'function') {
          payload = await response.json().catch(() => null);
        }
        if (!payload || (!payload.error && !payload.code)) throw invokeError;
      }
      if (!payload || payload.error || payload.code) throw payload || new Error('EMPTY');
      if (typeof payload.material_id !== 'string' || !isRecord(payload.material)) throw new Error('EMPTY');
      const record: HubMaterialRecord = {
        id: payload.material_id,
        kind,
        niche,
        level_tag: level,
        topic: String(payload.topic || topic.trim()),
        goal: goal.trim(),
        audience,
        title: String(payload.title || topic.trim()),
        created_at: String(payload.created_at || new Date().toISOString()),
        dropped_items: Number(payload.dropped || 0),
        material: payload.material,
      };
      setCurrent(record);
      setTeacherVersion(true);
      setWeekNote('');
      await Promise.all([loadHistory(), onRefresh()]);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setGenerating(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Apagar este material? A geração já foi contada no seu plano.')) return;
    const { error: deleteError } = await supabase.from('hub_educator_materials').delete().eq('id', id);
    if (deleteError) {
      setHistoryError('Não foi possível apagar o material.');
      return;
    }
    if (current?.id === id) setCurrent(null);
    await loadHistory();
  };

  const copyText = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(materialAsText(current));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Não foi possível copiar. Selecione o texto na tela.');
    }
  };

  if (blocked) {
    return (
      <section className="mx-auto max-w-2xl rounded-[2.5rem] border border-brand-border bg-brand-surface p-8 text-center shadow-sm sm:p-12">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-tenant-primary/10 text-tenant-primary"><Sparkles size={24} /></div>
        <h1 className="mt-5 text-3xl font-black tracking-tight text-brand-text">Gerador de material não incluído neste plano</h1>
        <p className="mx-auto mt-3 max-w-lg leading-7 text-brand-muted">Worksheets, quizzes, cards, drills, leituras e roteiros por nicho e nível entram a partir do Professor Essencial (3 por mês) e do Professor Pro (40 por mês).</p>
        <button type="button" onClick={onUpgrade} className="mt-7 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white">Ver planos com Educador IA</button>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <style>{`@media print { body * { visibility: hidden; } #hub-material-print, #hub-material-print * { visibility: visible; } #hub-material-print { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>

      <form id="hub-material-form" onSubmit={generate} className="rounded-[2rem] border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-7 print:hidden">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">Educador IA · Gerador de material</p>
            <h1 className="mt-1 text-2xl font-black tracking-tight text-brand-text">Material pronto por nicho e nível</h1>
            {weekNote && <p className="mt-1 inline-flex rounded-full bg-tenant-primary/10 px-3 py-1 text-xs font-black text-tenant-primary">{weekNote} · tema e tipo preenchidos</p>}
            <p className="mt-1 text-sm text-brand-muted">Escolha o tipo, o objetivo do aluno, o nível e o tema. Todo material abre com o foco gramatical do nível, mostra a porta que o inglês abre no objetivo dele e fecha com homework para praticar com IA. O gabarito passa por verificação antes de chegar aqui.</p>
          </div>
          <p className="shrink-0 rounded-2xl bg-brand-surface-2 px-4 py-2 text-xs font-bold text-brand-text" data-testid="hub-material-quota">
            {remaining === null ? `${entitlement?.used || 0} gerações usadas · ilimitado` : `${remaining} de ${entitlement?.limit} gerações restantes`}
          </p>
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          {HUB_MATERIAL_KIND_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setKind(option.value)}
              aria-pressed={kind === option.value}
              className={`flex items-start gap-3 rounded-2xl border p-3 text-left transition ${kind === option.value ? 'border-tenant-primary bg-tenant-primary/10' : 'border-brand-border bg-brand-surface-2 hover:border-tenant-primary/50'}`}
            >
              <span className="mt-0.5 text-tenant-primary">{option.icon}</span>
              <span><span className="block text-sm font-black text-brand-text">{option.label}</span><span className="block text-xs text-brand-muted">{option.hint}</span></span>
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-4">
          <label><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Nicho</span>
            <select value={niche} onChange={(event) => setNiche(event.target.value)} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none">
              {HUB_MATERIAL_NICHE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Nível CEFR</span>
            <select value={level} onChange={(event) => setLevel(event.target.value)} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none">
              {LEVELS.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <label><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">{kind === 'journey' ? 'Semanas' : 'Itens'}</span>
            {kind === 'journey'
              ? <input value="12 (90 dias)" readOnly className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-muted outline-none" />
              : <input type="number" min={4} max={15} value={count} onChange={(event) => setCount(Math.min(15, Math.max(4, Number(event.target.value) || 4)))} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none" />}
          </label>
          <label className="flex items-end gap-3 pb-3">
            <input type="checkbox" checked={bilingual} onChange={(event) => setBilingual(event.target.checked)} className="size-5 rounded" />
            <span className="text-sm font-bold text-brand-text">Traduções em pt-BR</span>
          </label>
          <label className="sm:col-span-3"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Objetivo do aluno</span>
            <input value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={200} placeholder="Ex.: logística numa multinacional, estudante de gastronomia, intercâmbio no Canadá, virar influencer, assistir filme sem legenda…" className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-none focus:ring-4 focus:ring-tenant-primary/10" />
          </label>
          <label><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Faixa etária</span>
            <select value={audience} onChange={(event) => setAudience(event.target.value as HubMaterialAudience)} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none">
              {HUB_MATERIAL_AUDIENCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="sm:col-span-4"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">{kind === 'journey' ? 'Ponto de partida / contexto da jornada' : 'Tema / situação do aluno'}</span>
            <input value={topic} onChange={(event) => setTopic(event.target.value)} maxLength={200} placeholder="Ex.: check-in no hotel, reunião de status com o time, consulta de rotina, primeiro dia na escola…" className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-none focus:ring-4 focus:ring-tenant-primary/10" />
          </label>
          <label className="sm:col-span-4"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Instruções extras (opcional)</span>
            <input value={extra} onChange={(event) => setExtra(event.target.value)} maxLength={600} placeholder="Ex.: focar em past simple; aluno adulto, engenheiro; evitar gírias" className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-none" />
          </label>
        </div>

        {error && <div role="alert" className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"><AlertCircle className="mt-0.5 shrink-0" size={17} />{error}</div>}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={generating || remaining === 0} className="inline-flex items-center gap-2 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white disabled:opacity-60">
            {generating ? <RefreshCw className="animate-spin" size={17} /> : <Sparkles size={17} />}
            {generating ? 'Gerando material (até 1 min)...' : 'Gerar material'}
          </button>
          {remaining === 0 && <button type="button" onClick={onUpgrade} className="text-sm font-black text-tenant-primary">Limite do período atingido — ver planos</button>}
          <span className="text-xs text-brand-muted">Cada material gerado consome 1 geração do plano.</span>
        </div>
      </form>

      {current && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setTeacherVersion((value) => !value)} className="inline-flex items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface px-4 py-2.5 text-xs font-black text-brand-text">
                {teacherVersion ? <EyeOff size={15} /> : <Eye size={15} />}{teacherVersion ? 'Ver versão do aluno' : 'Ver versão do professor (gabarito)'}
              </button>
              <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface px-4 py-2.5 text-xs font-black text-brand-text"><Printer size={15} />Imprimir / salvar PDF</button>
              <button type="button" onClick={() => void copyText()} className="inline-flex items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface px-4 py-2.5 text-xs font-black text-brand-text">{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copiado' : 'Copiar texto'}</button>
            </div>
            {current.dropped_items > 0 && <p className="text-xs text-brand-muted">{current.dropped_items} {current.dropped_items === 1 ? 'questão foi descartada' : 'questões foram descartadas'} na verificação do gabarito.</p>}
          </div>
          <HubMaterialView record={current} teacher={teacherVersion} onGenerateWeek={prefillFromWeek} />
        </section>
      )}

      <section className="rounded-[2rem] border border-brand-border bg-brand-surface p-5 print:hidden sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-black text-brand-text">Seus materiais</h2>
          <button type="button" onClick={() => void loadHistory()} className="inline-flex items-center gap-1.5 text-xs font-bold text-brand-muted"><RefreshCw size={13} />Atualizar</button>
        </div>
        {historyError && <p role="alert" className="mt-3 text-sm font-bold text-red-600">{historyError}</p>}
        {history.length === 0 ? (
          <p className="mt-3 text-sm text-brand-muted">Nenhum material gerado ainda. O primeiro fica guardado aqui para você reabrir e imprimir quando quiser.</p>
        ) : (
          <ul className="mt-3 divide-y divide-brand-border">
            {history.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2.5">
                <button type="button" onClick={() => { setCurrent(item); setTeacherVersion(true); }} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-tenant-primary/10 text-tenant-primary"><FileText size={16} /></span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-black text-brand-text">{item.title}</span>
                    <span className="block text-xs text-brand-muted">{kindLabel(item.kind)} · {item.level_tag} · {nicheLabel(item.niche)} · {new Date(item.created_at).toLocaleDateString('pt-BR')}</span>
                  </span>
                </button>
                <button type="button" onClick={() => void remove(item.id)} aria-label={`Apagar ${item.title}`} className="grid size-9 shrink-0 place-items-center rounded-xl text-brand-muted hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default HubMaterialGenerator;
