import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  CORRECTION_STYLE_OPTIONS,
  draftFromCard,
  draftHasChanges,
  learningCardFieldLabel,
  learningCardHistoryActor,
  learningCardMinorMessage,
  learningCardSaveArgs,
  learningCardSaveErrorMessage,
  parseTopicList,
  readLearningCard,
  validateLearningCardDraft,
  type LearningCardDraft,
  type StudentLearningCard as Card,
} from '../lib/studentLearningCard';

/**
 * Cartão do aluno — o que o professor sabe e a IA não inventa: objetivo real,
 * temas que engajam, como prefere ser corrigido, o que evitar e observações.
 * No Planner ele vale mais do que o que o Wolfie deduziu das conversas.
 *
 * Quem edita (professor vinculado, coordenação, direção) e a regra de menor de
 * idade são decididos no servidor (`save_student_learning_card`); a tela só
 * avisa antes.
 */

const fmtDateTime = (iso: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

const Chips = ({ items, empty }: { items: string[]; empty: string }) => items.length
  ? <ul className="flex flex-wrap gap-1.5">{items.map(item => <li key={item} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs dark:bg-slate-800">{item}</li>)}</ul>
  : <span className="text-slate-500">{empty}</span>;

const Counter = ({ id, used, max }: { id: string; used: number; max: number }) =>
  <span id={id} className={`text-xs ${used > max ? 'font-semibold text-red-600' : 'text-slate-500'}`}>{used}/{max}</span>;

interface Props {
  studentId: string;
  card: Card;
  /** Devolve o cartão cru que o servidor gravou (mesmo formato do dossiê). */
  onSaved: (raw: unknown) => void;
  onReload: () => void;
}

export default function StudentLearningCard({ studentId, card, onSaved, onReload }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LearningCardDraft>(() => draftFromCard(card));
  // Versão sobre a qual o rascunho foi escrito — é ela que vai ao servidor.
  // Só avança quando a pessoa VÊ a versão nova (ou não tinha nada digitado).
  const [baseVersion, setBaseVersion] = useState(card.version);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const shownRef = useRef({ studentId, card });

  const restart = (from: Card) => {
    setDraft(draftFromCard(from));
    setBaseVersion(from.version);
    setError('');
    setConflict(false);
  };

  // Cartão novo do servidor (salvou, recarregou, alguém mudou, trocou de aluno).
  // Outro aluno ou sem edição aberta: recomeça do servidor. Com edição aberta,
  // o que a pessoa digitou NUNCA some — se não havia nada digitado, só avança a
  // versão; se havia, o rascunho fica e a versão nova aparece ao lado.
  useEffect(() => {
    const previous = shownRef.current;
    shownRef.current = { studentId, card };
    if (previous.studentId !== studentId || !editingRef.current) {
      restart(card);
      setEditing(false);
      return;
    }
    if (!draftHasChanges(draftRef.current, previous.card)) {
      restart(card);
      return;
    }
    // O aviso "outra pessoa atualizou" já cumpriu o papel: agora o painel de
    // comparação mostra a versão nova e a decisão é de quem está editando.
    setError('');
    setConflict(false);
  }, [studentId, card.version, card.is_minor]);

  const limits = card.limits;
  const minor = card.is_minor;
  const stale = editing && card.version !== baseVersion;
  const style = CORRECTION_STYLE_OPTIONS.find(option => option.value === card.correction_style);
  const topicsCount = parseTopicList(draft.engaging_topics).length;
  const avoidCount = parseTopicList(draft.avoid_topics).length;
  const set = (patch: Partial<LearningCardDraft>) => setDraft(current => ({ ...current, ...patch }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = validateLearningCardDraft(draft, limits, minor);
    if (problem) { setError(problem); return; }
    setSaving(true); setError(''); setConflict(false);
    try {
      const { data, error: rpcError } = await supabase.rpc(
        'save_student_learning_card', learningCardSaveArgs(studentId, draft, minor, baseVersion),
      );
      if (rpcError) {
        setError(learningCardSaveErrorMessage(rpcError.message));
        setConflict(rpcError.message.includes('cartao_alterado_por_outra_pessoa'));
        return;
      }
      // Salvar igual não muda a versão: fecha a edição aqui, sem esperar o efeito.
      const saved = readLearningCard(data);
      onSaved(data);
      if (saved) restart(saved);
      setEditing(false);
    } catch {
      setError(learningCardSaveErrorMessage(null));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-tour="student-learning-card" aria-labelledby="student-learning-card-title" className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 id="student-learning-card-title" className="font-semibold">Cartão do aluno</h4>
          <p className="text-xs text-slate-500">Preenchido pelo professor, sem IA. No Planner, vale mais do que o que o Wolfie deduziu das conversas.</p>
        </div>
        {card.can_edit && !editing && (
          <button type="button" onClick={() => setEditing(true)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">
            {card.exists ? 'Editar' : 'Preencher'}
          </button>
        )}
      </header>

      {minor && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {learningCardMinorMessage(card.minor_reason)}
          {card.hidden_for_minor && ' Havia observações pessoais de antes: estão ocultas e são apagadas automaticamente.'}
        </p>
      )}

      {!editing && (
        card.exists ? (
          <dl className="space-y-2 text-sm">
            <div><dt className="font-medium">Objetivo real</dt><dd>{card.real_goal || <span className="text-slate-500">Não registrado</span>}</dd></div>
            <div><dt className="font-medium">Temas que engajam</dt><dd><Chips items={card.engaging_topics} empty="Não registrados" /></dd></div>
            {!minor && <>
              <div><dt className="font-medium">Como prefere ser corrigido</dt><dd>{style ? `${style.label} — ${style.hint}` : <span className="text-slate-500">Não registrado</span>}</dd></div>
              <div><dt className="font-medium">O que evitar</dt><dd><Chips items={card.avoid_topics} empty="Nada registrado" /></dd></div>
              <div><dt className="font-medium">Observações</dt><dd className="whitespace-pre-line">{card.notes || <span className="text-slate-500">Nenhuma</span>}</dd></div>
            </>}
          </dl>
        ) : (
          <p className="text-sm text-slate-500">
            Ainda não preenchido.{card.can_edit ? ' Leva um minuto, deixa o Planner mais certeiro e ajuda quem assumir o aluno depois.' : ''}
          </p>
        )
      )}

      {editing && (
        <form onSubmit={save} className="space-y-3 text-sm" noValidate>
          <p role="note" className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs dark:border-slate-600 dark:bg-slate-900">
            <strong>Não registre</strong> saúde, religião, política, família ou dinheiro. Escreva só o que ajuda a dar aula — o cartão é lido pelos professores do aluno, pela coordenação e pela direção, e entra no Planner.
          </p>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label htmlFor="card-goal" className="font-medium">Objetivo real</label>
              <Counter id="card-goal-count" used={draft.real_goal.trim().length} max={limits.real_goal} />
            </div>
            <textarea id="card-goal" aria-describedby="card-goal-count" rows={2} value={draft.real_goal}
              onChange={e => set({ real_goal: e.target.value })}
              placeholder="Ex.: apresentar resultados em reuniões com o time dos EUA"
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-600" />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label htmlFor="card-topics" className="font-medium">Temas que engajam</label>
              <Counter id="card-topics-count" used={topicsCount} max={limits.engaging_topics} />
            </div>
            <input id="card-topics" aria-describedby="card-topics-count card-topics-hint" value={draft.engaging_topics}
              onChange={e => set({ engaging_topics: e.target.value })}
              placeholder="futebol, séries de ficção, viagens"
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-600" />
            <p id="card-topics-hint" className="text-xs text-slate-500">Separe por vírgula. Até {limits.topic} caracteres cada.</p>
          </div>

          {!minor && <>
            <fieldset className="space-y-1">
              <legend className="font-medium">Como prefere ser corrigido</legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {CORRECTION_STYLE_OPTIONS.map(option => (
                  <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                    <input type="radio" name="card-correction" value={option.value}
                      checked={draft.correction_style === option.value}
                      onChange={() => set({ correction_style: option.value })} className="mt-0.5" />
                    <span><span className="font-medium">{option.label}</span><span className="block text-xs text-slate-500">{option.hint}</span></span>
                  </label>
                ))}
              </div>
              {draft.correction_style && (
                <button type="button" onClick={() => set({ correction_style: '' })} className="text-xs text-slate-500 underline">Não sei ainda</button>
              )}
            </fieldset>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor="card-avoid" className="font-medium">O que evitar na aula</label>
                <Counter id="card-avoid-count" used={avoidCount} max={limits.avoid_topics} />
              </div>
              <input id="card-avoid" aria-describedby="card-avoid-count" value={draft.avoid_topics}
                onChange={e => set({ avoid_topics: e.target.value })}
                placeholder="spoilers, falar de trabalho no começo"
                className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-600" />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor="card-notes" className="font-medium">Observações para quem der a aula</label>
                <Counter id="card-notes-count" used={draft.notes.trim().length} max={limits.notes} />
              </div>
              <textarea id="card-notes" aria-describedby="card-notes-count" rows={3} value={draft.notes}
                onChange={e => set({ notes: e.target.value })}
                placeholder="Ex.: rende mais com roleplay; gosta de começar com conversa livre"
                className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-600" />
            </div>
          </>}

          {stale && (
            <div role="status" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
              <p>
                <strong>Versão nova salva{card.updated_by_name ? ` por ${card.updated_by_name}` : ''}{card.updated_at ? ` em ${fmtDateTime(card.updated_at)}` : ''}.</strong>{' '}
                O que você escreveu continua no formulário. Compare e decida:
              </p>
              <dl className="space-y-1">
                <div><dt className="inline font-medium">Objetivo: </dt><dd className="inline">{card.real_goal || '—'}</dd></div>
                <div><dt className="inline font-medium">Temas: </dt><dd className="inline">{card.engaging_topics.join(', ') || '—'}</dd></div>
                {!minor && <>
                  <div><dt className="inline font-medium">Correção: </dt><dd className="inline">{CORRECTION_STYLE_OPTIONS.find(option => option.value === card.correction_style)?.label ?? '—'}</dd></div>
                  <div><dt className="inline font-medium">Evitar: </dt><dd className="inline">{card.avoid_topics.join(', ') || '—'}</dd></div>
                  <div><dt className="inline font-medium">Observações: </dt><dd className="inline whitespace-pre-line">{card.notes || '—'}</dd></div>
                </>}
              </dl>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => { setBaseVersion(card.version); setError(''); setConflict(false); }}
                  className="rounded-lg bg-amber-700 px-3 py-1.5 font-semibold text-white">
                  Manter o meu texto
                </button>
                <button type="button" onClick={() => restart(card)}
                  className="rounded-lg border border-amber-700 px-3 py-1.5 font-semibold">
                  Usar a versão nova
                </button>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-red-600">
              {error}{' '}
              {conflict && !stale && <button type="button" onClick={onReload} className="font-semibold underline">Recarregar</button>}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={saving || stale} className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white disabled:opacity-50">
              {saving ? 'Salvando…' : 'Salvar cartão'}
            </button>
            <button type="button" disabled={saving} onClick={() => { restart(card); setEditing(false); }}
              className="rounded-lg border border-slate-300 px-4 py-2 font-semibold dark:border-slate-600">
              Cancelar
            </button>
          </div>
        </form>
      )}

      {card.updated_at && (
        <p className="text-xs text-slate-500">
          Atualizado{card.updated_by_name ? ` por ${card.updated_by_name}` : ''} em {fmtDateTime(card.updated_at)}.
        </p>
      )}

      {card.history.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-600 dark:text-slate-300">Histórico de alterações</summary>
          <p className="mt-1 text-slate-500">Guarda quem mudou, quando e quais campos — nunca o texto.</p>
          <ul className="mt-1 space-y-1">
            {card.history.map(entry => (
              <li key={`${entry.version}-${entry.created_at}`}>
                {fmtDateTime(entry.created_at)} · {learningCardHistoryActor(entry)}
                {' · '}{entry.changed_fields.map(learningCardFieldLabel).join(', ') || 'sem mudança de conteúdo'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
