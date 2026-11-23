import React from 'react';
import { Check } from 'lucide-react';

// Tipos de material da Fase 2 do Hub (ferramentas por habilidade): como cada
// um aparece na tela/impressão e como vira texto. A versão do aluno nunca
// mostra resposta; a mesa do aluno já recebe o material sem gabarito do
// servidor (`private.hub_strip_answer_keys`), então aqui só escondemos.

export const FASE2_KIND_LABELS: Record<string, string> = {
  matching: 'Associação',
  gap_fill: 'Lacunas com banco de palavras',
  true_false: 'Verdadeiro ou falso',
  discussion: 'Perguntas de discussão',
  writing_prompt: 'Proposta de redação',
  error_correction: 'Correção de erros',
  sentence_transformation: 'Transformação de frases',
  text_questions: 'Perguntas sobre o texto',
};

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const s = (value: unknown): string => (typeof value === 'string' ? value : '');
const letter = (index: number) => String.fromCharCode(65 + index);

const Title: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="mt-6 text-[11px] font-black uppercase tracking-[0.18em] text-tenant-primary print:text-black">{children}</h3>
);
const Key: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="ml-2 rounded-lg bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-900 print:bg-white">→ {children}</span>
);
const Explain: React.FC<{ text: string }> = ({ text }) => (text ? <p className="mt-1 text-xs italic text-slate-500">{text}</p> : null);
const Line: React.FC = () => <div className="mt-2 h-8 border-b border-dashed border-slate-300" aria-hidden="true" />;
const Paragraphs: React.FC<{ text: string }> = ({ text }) => (
  <>{text.split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={index} className="mt-3 text-[15px] leading-7">{paragraph}</p>)}</>
);
const Pairs: React.FC<{ rows: Json[]; a: string; b: string; left: string; right: string }> = ({ rows, a, b, left, right }) => (
  <div className="mt-3 overflow-x-auto"><table className="w-full border-collapse text-sm">
    <thead><tr className="text-left text-[10px] font-black uppercase tracking-widest text-brand-muted print:text-black"><th className="border-b border-brand-border py-1.5 pr-3">{left}</th><th className="border-b border-brand-border py-1.5">{right}</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index} className="align-top"><td className="break-words border-b border-brand-border/60 py-1.5 pr-3 font-bold">{s(row[a])}</td><td className="break-words border-b border-brand-border/60 py-1.5">{s(row[b])}</td></tr>)}</tbody>
  </table></div>
);

const McQuestions: React.FC<{ rows: Json[]; teacher: boolean }> = ({ rows, teacher }) => (
  <ol className="mt-3 space-y-4">
    {rows.map((question, index) => (
      <li key={index} className="break-inside-avoid">
        <p className="font-bold">{index + 1}. {s(question.prompt)}</p>
        <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
          {strings(question.options).map((option, optionIndex) => {
            const isKey = teacher && Number(question.correct) === optionIndex;
            return (
              <li key={optionIndex} className={`rounded-xl border px-3 py-1.5 text-sm ${isKey ? 'border-emerald-400 bg-emerald-50 font-bold text-emerald-900 print:bg-white' : 'border-brand-border'}`}>
                <span className="mr-2 font-black">{letter(optionIndex)})</span>{option}{isKey && <Check className="ml-2 inline" size={14} aria-label="resposta correta" />}
              </li>
            );
          })}
        </ul>
        {teacher && <Explain text={s(question.explanation_pt)} />}
      </li>
    ))}
  </ol>
);

export const Fase2MaterialSections: React.FC<{ kind: string; material: Json; teacher: boolean }> = ({ kind, material: m, teacher }) => {
  const instructions = s(m.instructions_pt) && <p className="mt-4 text-sm">{s(m.instructions_pt)}</p>;
  switch (kind) {
    case 'matching': {
      const left = strings(m.left_items);
      const right = strings(m.right_items);
      const key = Array.isArray(m.answer_key) ? m.answer_key.map(Number) : [];
      return (<>
        {instructions}
        <div className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 print:grid-cols-2">
          <ol className="min-w-0 space-y-2">{left.map((item, index) => <li key={index} className="break-words rounded-xl border border-brand-border px-3 py-2 font-bold">{index + 1}. {item}{teacher && Number.isInteger(key[index]) && <Key>{letter(key[index])}</Key>}</li>)}</ol>
          <ol className="min-w-0 space-y-2">{right.map((item, index) => <li key={index} className="break-words rounded-xl border border-brand-border px-3 py-2"><span className="mr-2 font-black">{letter(index)})</span>{item}</li>)}</ol>
        </div>
      </>);
    }
    case 'gap_fill':
      return (<>
        {instructions}
        {strings(m.word_bank).length > 0 && <p className="mt-4 rounded-2xl border border-brand-border p-3 text-sm"><span className="font-black">Banco de palavras: </span>{strings(m.word_bank).join(' · ')}</p>}
        <Title>Complete</Title>
        <ol className="mt-2 space-y-2 text-sm">
          {records(m.gaps).map((gap, index) => <li key={index} className="break-inside-avoid">{index + 1}. {s(gap.prompt)}{teacher && s(gap.answer) && <Key>{s(gap.answer)}</Key>}{teacher && <Explain text={s(gap.explanation_pt)} />}</li>)}
        </ol>
      </>);
    case 'true_false':
      return (<>
        <Title>Texto</Title>
        <Paragraphs text={s(m.text)} />
        <Title>Verdadeiro (T) ou falso (F)?</Title>
        <ol className="mt-2 space-y-2 text-sm">
          {records(m.statements).map((item, index) => (
            <li key={index} className="break-inside-avoid">
              {index + 1}. {s(item.statement)} <span className="ml-1 font-black text-slate-400">( T / F )</span>
              {teacher && typeof item.correct === 'boolean' && <Key>{item.correct ? 'Verdadeiro' : 'Falso'}</Key>}
              {teacher && <Explain text={s(item.explanation_pt)} />}
            </li>
          ))}
        </ol>
      </>);
    case 'discussion':
      return (<>
        {s(m.warm_up_pt) && <p className="mt-4 rounded-2xl bg-slate-50 p-3 text-sm print:bg-white print:p-0"><span className="font-black">Para começar: </span>{s(m.warm_up_pt)}</p>}
        {records(m.useful_phrases).length > 0 && (<><Title>Frases úteis</Title><Pairs rows={records(m.useful_phrases)} a="en" b="pt" left="Inglês" right="Português" /></>)}
        <Title>Perguntas</Title>
        <ol className="mt-2 space-y-2 text-sm">{records(m.questions).map((item, index) => <li key={index}><span className="font-bold">{index + 1}. {s(item.question)}</span>{s(item.follow_up) && <span className="block text-slate-500">↳ {s(item.follow_up)}</span>}</li>)}</ol>
        {records(m.situation_cards).length > 0 && (<>
          <Title>Cartões de situação</Title>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">{records(m.situation_cards).map((card, index) => <div key={index} className="break-inside-avoid rounded-2xl border border-brand-border p-3 text-sm"><p className="font-bold">{s(card.situation)}</p><p className="mt-1 text-slate-600">{s(card.task_pt)}</p></div>)}</div>
        </>)}
        {teacher && s(m.teacher_notes_pt) && (<><Title>Notas para o professor</Title><p className="mt-2 rounded-2xl bg-amber-50 p-4 text-sm print:bg-white print:p-0">{s(m.teacher_notes_pt)}</p></>)}
      </>);
    case 'writing_prompt':
      return (<>
        <Title>Tarefa</Title>
        <p className="mt-2 text-[15px] font-bold leading-7">{s(m.task)}</p>
        {s(m.task_pt) && <p className="mt-1 text-sm text-slate-600">{s(m.task_pt)}</p>}
        {Number(m.word_count) > 0 && <p className="mt-1 text-xs font-bold text-slate-500">Tamanho: cerca de {Number(m.word_count)} palavras</p>}
        {strings(m.requirements_pt).length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">{strings(m.requirements_pt).map((item, index) => <li key={index}>{item}</li>)}</ul>}
        {records(m.useful_language).length > 0 && (<><Title>Expressões úteis</Title><Pairs rows={records(m.useful_language)} a="en" b="pt" left="Inglês" right="Português" /></>)}
        {records(m.rubric).length > 0 && (<><Title>Critérios de correção</Title><Pairs rows={records(m.rubric)} a="criterion_pt" b="descriptor_pt" left="Critério" right="Um bom texto…" /></>)}
        {teacher
          ? s(m.model_answer) && (<><Title>Texto-modelo</Title><Paragraphs text={s(m.model_answer)} /></>)
          : (<><Title>Seu texto</Title>{Array.from({ length: 8 }, (_, index) => <Line key={index} />)}</>)}
      </>);
    case 'error_correction':
      return (<>
        {instructions}
        <Title>Corrija as frases</Title>
        <ol className="mt-2 space-y-3 text-sm">
          {records(m.sentences).map((item, index) => (
            <li key={index} className="break-inside-avoid">
              <p>{index + 1}. {s(item.sentence)}</p>
              {teacher ? (<><p className="mt-1 font-bold text-emerald-800 print:text-black">✓ {s(item.answer)}</p><Explain text={s(item.explanation_pt)} /></>) : <Line />}
            </li>
          ))}
        </ol>
      </>);
    case 'sentence_transformation':
      return (<>
        {instructions}
        <Title>Reescreva</Title>
        <ol className="mt-2 space-y-3 text-sm">
          {records(m.items).map((item, index) => (
            <li key={index} className="break-inside-avoid">
              <p>{index + 1}. {s(item.original)} <span className="ml-1 rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-black print:bg-white">{s(item.instruction)}</span></p>
              {teacher ? (<><p className="mt-1 font-bold text-emerald-800 print:text-black">✓ {s(item.answer)}</p><Explain text={s(item.explanation_pt)} /></>) : <Line />}
            </li>
          ))}
        </ol>
      </>);
    case 'text_questions':
      return (<>
        {instructions}
        <Title>Texto</Title>
        <Paragraphs text={s(m.text)} />
        {records(m.glossary).length > 0 && (<><Title>Glossário</Title><Pairs rows={records(m.glossary)} a="term" b="translation_pt" left="Termo" right="Tradução" /></>)}
        <Title>Compreensão</Title>
        <McQuestions rows={records(m.questions)} teacher={teacher} />
        {records(m.open_questions).length > 0 && (<>
          <Title>Perguntas abertas</Title>
          <ol className="mt-2 space-y-3 text-sm">{records(m.open_questions).map((item, index) => <li key={index} className="break-inside-avoid"><p>{index + 1}. {s(item.prompt)}</p>{teacher ? <Explain text={`Resposta-modelo: ${s(item.model_answer)}`} /> : <Line />}</li>)}</ol>
        </>)}
      </>);
    default:
      return null;
  }
};

// Fonte do material adaptado (link ou print): aparece para professor e aluno.
export const MaterialSourceNote: React.FC<{ material: Json }> = ({ material }) => {
  const source = isRecord(material.source) ? material.source : null;
  if (!source) return null;
  const url = s(source.url);
  const title = s(source.title);
  const label = source.type === 'image' ? 'Adaptado de um print enviado pelo professor' : source.type === 'url' ? 'Adaptado de' : 'Adaptado de um texto enviado pelo professor';
  return (
    <p className="mt-3 text-xs text-slate-500">
      {label}{source.type === 'url' && url ? <> <a href={url} target="_blank" rel="noopener noreferrer" className="underline">{title || url}</a></> : null}
    </p>
  );
};

// Texto puro (versão do professor) dos tipos da Fase 2.
export function fase2MaterialText(kind: string, m: Json): string[] {
  const lines: string[] = [];
  const instructions = s(m.instructions_pt);
  if (instructions) lines.push(instructions, '');
  switch (kind) {
    case 'matching': {
      const right = strings(m.right_items);
      const key = Array.isArray(m.answer_key) ? m.answer_key.map(Number) : [];
      strings(m.left_items).forEach((item, index) => lines.push(`${index + 1}. ${item}`));
      lines.push('');
      right.forEach((item, index) => lines.push(`${letter(index)}) ${item}`));
      lines.push('', `Gabarito: ${key.map((value, index) => `${index + 1}-${letter(value)}`).join(' · ')}`);
      break;
    }
    case 'gap_fill': {
      if (strings(m.word_bank).length) lines.push(`Banco de palavras: ${strings(m.word_bank).join(' · ')}`, '');
      const gaps = records(m.gaps);
      gaps.forEach((gap, index) => lines.push(`${index + 1}. ${s(gap.prompt)}`));
      lines.push('', `Respostas: ${gaps.map((gap, index) => `${index + 1}-${s(gap.answer)}`).join(' · ')}`);
      break;
    }
    case 'true_false': {
      lines.push(s(m.text), '');
      const items = records(m.statements);
      items.forEach((item, index) => lines.push(`${index + 1}. ${s(item.statement)} (T/F)`));
      lines.push('', `Gabarito: ${items.map((item, index) => `${index + 1}-${item.correct ? 'T' : 'F'}`).join(' · ')}`);
      break;
    }
    case 'discussion':
      if (s(m.warm_up_pt)) lines.push(`Para começar: ${s(m.warm_up_pt)}`, '');
      records(m.useful_phrases).forEach((pair) => lines.push(`• ${s(pair.en)} — ${s(pair.pt)}`));
      lines.push('');
      records(m.questions).forEach((item, index) => lines.push(`${index + 1}. ${s(item.question)}${s(item.follow_up) ? `\n   ↳ ${s(item.follow_up)}` : ''}`));
      records(m.situation_cards).forEach((card, index) => lines.push(`Cartão ${index + 1}: ${s(card.situation)} — ${s(card.task_pt)}`));
      if (s(m.teacher_notes_pt)) lines.push('', `Notas para o professor: ${s(m.teacher_notes_pt)}`);
      break;
    case 'writing_prompt':
      lines.push(`Tarefa: ${s(m.task)}`, s(m.task_pt), `Tamanho: cerca de ${Number(m.word_count) || 120} palavras`, '');
      strings(m.requirements_pt).forEach((item) => lines.push(`• ${item}`));
      records(m.useful_language).forEach((pair) => lines.push(`• ${s(pair.en)} — ${s(pair.pt)}`));
      records(m.rubric).forEach((row) => lines.push(`Critério — ${s(row.criterion_pt)}: ${s(row.descriptor_pt)}`));
      if (s(m.model_answer)) lines.push('', 'Texto-modelo:', s(m.model_answer));
      break;
    case 'error_correction':
      records(m.sentences).forEach((item, index) => lines.push(`${index + 1}. ${s(item.sentence)}`, `   ✓ ${s(item.answer)} — ${s(item.explanation_pt)}`));
      break;
    case 'sentence_transformation':
      records(m.items).forEach((item, index) => lines.push(`${index + 1}. ${s(item.original)} [${s(item.instruction)}]`, `   ✓ ${s(item.answer)}`));
      break;
    case 'text_questions': {
      lines.push(s(m.text), '');
      const questions = records(m.questions);
      questions.forEach((question, index) => {
        lines.push(`${index + 1}. ${s(question.prompt)}`);
        strings(question.options).forEach((option, optionIndex) => lines.push(`   ${letter(optionIndex)}) ${option}`));
      });
      lines.push('', `Gabarito: ${questions.map((question, index) => `${index + 1}-${letter(Number(question.correct))}`).join(' · ')}`);
      records(m.open_questions).forEach((item, index) => lines.push(`Aberta ${index + 1}: ${s(item.prompt)}`, `   Resposta-modelo: ${s(item.model_answer)}`));
      break;
    }
  }
  const source = isRecord(m.source) ? m.source : null;
  if (source && s(source.url)) lines.push('', `Fonte: ${s(source.url)}`);
  return lines;
}
