import React, { useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Send, XCircle } from 'lucide-react';
import { submitHubSharedAnswers, type HubShareResult } from './hubService';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const MCQ_SECTIONS = [['questions', 'Questões'], ['exercises', 'Exercícios'], ['multiple_choice', 'Múltipla escolha']] as const;
const LETTERS = 'abcdefghij';

const ERRORS: Record<string, string> = {
  LINK_EXPIRED: 'Este link venceu. Peça um link novo ao seu professor.',
  LINK_INVALID: 'Este link não existe mais. Peça um link novo ao seu professor.',
  SUBMISSION_LIMIT_REACHED: 'Muitas respostas neste link hoje. Tente amanhã ou fale com seu professor.',
};

/** Respostas do aluno na atividade do link. O gabarito nunca vem ao navegador antes do envio. */
const HubShareAnswerForm: React.FC<{ token: string; material: Json }> = ({ token, material }) => {
  const mcq = useMemo(() => MCQ_SECTIONS.map(([key, label]) => ({
    key, label, items: (Array.isArray(material[key]) ? material[key] as unknown[] : []).filter(isObj),
  })).filter((s) => s.items.length > 0), [material]);
  const blanks = (Array.isArray(material.fill_blanks) ? material.fill_blanks as unknown[] : []).filter(isObj);
  const open = (Array.isArray(material.open_questions) ? material.open_questions as unknown[] : []).filter(isObj);
  const [name, setName] = useState('');
  const [answers, setAnswers] = useState<Record<string, Array<number | string | null>>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<HubShareResult | null>(null);

  if (!mcq.length && !blanks.length && !open.length) return null;
  const set = (key: string, index: number, value: number | string) =>
    setAnswers((prev) => { const list = [...(prev[key] ?? [])]; list[index] = value; return { ...prev, [key]: list }; });
  const resultFor = (section: string, index: number) => result?.items.find((it) => it.section === section && it.index === index);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError('');
    try {
      setResult(await submitHubSharedAnswers(token, name, answers));
    } catch (err) {
      setError(ERRORS[(err as Error).message] ?? 'Não consegui enviar agora. Tente de novo em instantes.');
    } finally {
      setSending(false);
    }
  };

  const Feedback: React.FC<{ section: string; index: number }> = ({ section, index }) => {
    const it = resultFor(section, index);
    if (!it) return null;
    return (
      <div className={`mt-2 rounded-xl p-3 text-xs ${it.correct === false || it.verdict === 'needs_work' ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}>
        {it.correct !== null && <p className="flex items-center gap-1 font-black">{it.correct ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{it.correct ? 'Certo' : 'Ainda não'}</p>}
        {it.expected && !it.correct && <p className="mt-1">Resposta: <b>{it.expected}</b></p>}
        {it.explanation_pt && <p className="mt-1">{it.explanation_pt}</p>}
        {it.feedback_pt && <p className="mt-1">{it.feedback_pt}</p>}
        {it.corrected_en && <p className="mt-1 italic">{it.corrected_en}</p>}
      </div>
    );
  };

  return (
    <form onSubmit={submit} className="space-y-5 rounded-4xl border border-brand-border bg-brand-surface p-5 print:hidden sm:p-7" aria-label="Responder a atividade">
      <h2 className="text-xl font-black">Responder e receber a correção</h2>
      <label className="block text-sm font-bold">Seu nome (opcional, para o professor saber quem respondeu)
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" className="mt-1 w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3" />
      </label>
      {mcq.map((section) => (
        <fieldset key={section.key} className="space-y-4">
          <legend className="text-sm font-black">{section.label}</legend>
          {section.items.map((q, index) => (
            <div key={index}>
              <p className="text-sm font-bold">{index + 1}. {String(q.prompt ?? '')}</p>
              <div className="mt-2 grid gap-2">
                {(Array.isArray(q.options) ? q.options : []).map((opt, o) => (
                  <label key={o} className="flex min-h-11 items-center gap-2 rounded-xl border border-brand-border px-3 text-sm">
                    <input type="radio" name={`${section.key}-${index}`} disabled={Boolean(result)} checked={answers[section.key]?.[index] === o} onChange={() => set(section.key, index, o)} />
                    {LETTERS[o]}) {String(opt)}
                  </label>
                ))}
              </div>
              <Feedback section={section.key} index={index} />
            </div>
          ))}
        </fieldset>
      ))}
      {blanks.length > 0 && (
        <fieldset className="space-y-4">
          <legend className="text-sm font-black">Complete as lacunas</legend>
          {blanks.map((b, index) => (
            <div key={index}>
              <label className="block text-sm font-bold">{index + 1}. {String(b.prompt ?? '')}
                <input disabled={Boolean(result)} value={String(answers.fill_blanks?.[index] ?? '')} onChange={(e) => set('fill_blanks', index, e.target.value)} maxLength={120} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2.5" />
              </label>
              <Feedback section="fill_blanks" index={index} />
            </div>
          ))}
        </fieldset>
      )}
      {open.length > 0 && (
        <fieldset className="space-y-4">
          <legend className="text-sm font-black">Perguntas abertas</legend>
          {open.map((q, index) => (
            <div key={index}>
              <label className="block text-sm font-bold">{index + 1}. {String(q.prompt ?? '')}
                <textarea disabled={Boolean(result)} value={String(answers.open_questions?.[index] ?? '')} onChange={(e) => set('open_questions', index, e.target.value)} maxLength={500} rows={3} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2.5" />
              </label>
              <Feedback section="open_questions" index={index} />
            </div>
          ))}
        </fieldset>
      )}
      {error && <p role="alert" className="text-sm font-bold text-red-700">{error}</p>}
      {result ? (
        <p role="status" className="rounded-2xl bg-brand-surface-2 p-4 text-sm font-black">Você acertou {result.right} de {result.total} {result.total === 1 ? 'questão fechada' : 'questões fechadas'}.{result.keyMode === 'never' ? ' Seu professor vai mostrar as respostas certas depois.' : ''}</p>
      ) : (
        <button type="submit" disabled={sending} className="inline-flex min-h-11 items-center gap-2 rounded-2xl bg-tenant-primary px-6 py-3 text-sm font-black text-white disabled:opacity-60">{sending ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}{sending ? 'Corrigindo...' : 'Enviar respostas'}</button>
      )}
    </form>
  );
};

export default HubShareAnswerForm;
