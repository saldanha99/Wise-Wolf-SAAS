import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  cardSuggestionDecideErrorMessage,
  cardSuggestionEffect,
  cardSuggestionFieldLabel,
  cardSuggestionGenerateMessage,
  cardSuggestionReasonText,
  cardSuggestionValueLabel,
  lessonDateLabel,
  readCardSuggestions,
  type CardSuggestionsView,
} from '../lib/studentCardSuggestions';

/**
 * Sugestões da IA para o cartão do aluno, no dossiê, logo abaixo do cartão.
 *
 * Depois que um resumo de aula é aprovado, a IA lê a aula e propõe itens para
 * o cartão, cada um com a frase da aula que o sustenta. O professor aceita
 * (grava no cartão pela RPC do cartão, com a versão carregada) ou descarta.
 * Quem vê, o que a IA pode sugerir e o que é descartado são regras do servidor;
 * sem permissão, o painel nem aparece.
 */
interface Props {
  studentId: string;
  /** Versão do cartão que o dossiê mostra — o aceite não sobrescreve versão nova. */
  cardVersion: number;
  /** Cartão cru que o servidor gravou (mesmo formato do dossiê). */
  onCardSaved: (raw: unknown) => void;
  /** Relê o dossiê (e a versão do cartão) — o aceite sobre versão velha não fica preso. */
  onReload?: () => void;
}

export default function StudentCardSuggestions({ studentId, cardVersion, onCardSaved, onReload }: Props) {
  const [view, setView] = useState<CardSuggestionsView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('get_student_card_suggestions', { p_student_id: studentId });
    if (rpcError) {
      // Quem não edita o cartão não vê sugestão (nem a frase da aula).
      if (rpcError.message?.includes('sem_permissao')) setHidden(true);
      else setError('Não foi possível ler as sugestões da IA.');
      return;
    }
    const parsed = readCardSuggestions(data);
    if (!parsed) { setError('Não foi possível ler as sugestões da IA.'); return; }
    setView(parsed);
  }, [studentId]);

  useEffect(() => {
    setView(null); setHidden(false); setError(''); setMessage('');
    void load();
  }, [load]);

  const decide = async (id: string, accept: boolean) => {
    setBusyId(id); setError(''); setMessage('');
    try {
      const { data, error: rpcError } = await supabase.rpc('decide_student_card_suggestion', {
        p_suggestion_id: id, p_accept: accept, p_expected_version: cardVersion,
      });
      if (rpcError) {
        setError(cardSuggestionDecideErrorMessage(rpcError.message));
        // Outra pessoa salvou o cartão depois que o dossiê abriu: relê o cartão
        // (versão nova) e a lista — senão todo "Aceitar" falharia igual.
        if (/cartao_alterado_por_outra_pessoa/.test(rpcError.message || '')) onReload?.();
        if (/sugestao_ja_decidida|sugestao_sem_aula_aprovada|cartao_alterado_por_outra_pessoa/.test(rpcError.message || '')) await load();
        return;
      }
      if (data?.learning_card) onCardSaved(data.learning_card);
      setMessage(accept ? 'Sugestão aceita: já está no cartão.' : 'Sugestão descartada. A IA não volta a sugeri-la nos próximos 90 dias.');
      await load();
    } catch {
      setError(cardSuggestionDecideErrorMessage(null));
    } finally {
      setBusyId('');
    }
  };

  const generate = async () => {
    setGenerating(true); setError(''); setMessage('');
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('student-card-suggestions', {
        body: { action: 'generate', student_id: studentId },
      });
      let payload: unknown = data;
      if (invokeError) {
        try { payload = await (invokeError as { context?: Response }).context?.json(); } catch { /* sem corpo */ }
      }
      const result = cardSuggestionGenerateMessage(payload);
      if (result.ok) setMessage(result.text); else setError(result.text);
      await load();
    } catch {
      setError(cardSuggestionGenerateMessage(null).text);
    } finally {
      setGenerating(false);
    }
  };

  if (hidden) return null;

  return (
    <section data-tour="learning-card-suggestions" aria-labelledby="card-suggestions-title"
      className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-900 dark:bg-indigo-950/30">
      <header>
        <h4 id="card-suggestions-title" className="font-semibold">Sugestões da IA para o cartão</h4>
        <p className="text-xs text-slate-600 dark:text-slate-300">
          A IA lê as aulas cujo resumo foi aprovado e sugere itens com a frase da aula que sustenta cada um. Nada entra no cartão sem você aceitar.
          Ela nunca sugere saúde, religião, política, família, dinheiro ou dados de outras pessoas — e o que escapar é descartado antes de chegar aqui.
        </p>
      </header>

      {view?.is_minor && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Aluno menor de idade, com responsável cadastrado ou sem idade comprovada: a IA só sugere objetivo e temas.
        </p>
      )}

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {message && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>}
      {!view && !error && <p className="text-sm text-slate-500">Lendo as sugestões…</p>}

      {view && (view.suggestions.length ? (
        <ul className="space-y-2">
          {view.suggestions.map(suggestion => {
            const label = cardSuggestionValueLabel(suggestion);
            return (
              <li key={suggestion.id} className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
                <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">{cardSuggestionFieldLabel(suggestion.field)}</p>
                <p className="font-medium">{label}</p>
                <figure className="border-l-2 border-indigo-300 pl-3">
                  <blockquote className="italic text-slate-700 dark:text-slate-200">“{suggestion.quote}”</blockquote>
                  <figcaption className="mt-1 text-xs text-slate-500">
                    Frase da aula{suggestion.class_date ? ` de ${lessonDateLabel(suggestion.class_date)}` : ''}{suggestion.teacher_name ? ` com ${suggestion.teacher_name}` : ''}.
                  </figcaption>
                </figure>
                <p className="text-xs text-slate-500">
                  {suggestion.already_in_card ? 'Já está no cartão — aceitar só fecha a sugestão.' : cardSuggestionEffect(suggestion.field)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={Boolean(busyId)} onClick={() => void decide(suggestion.id, true)}
                    aria-label={`Aceitar: ${label}`}
                    className="rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                    {busyId === suggestion.id ? 'Gravando…' : 'Aceitar'}
                  </button>
                  <button type="button" disabled={Boolean(busyId)} onClick={() => void decide(suggestion.id, false)}
                    aria-label={`Descartar: ${label}`}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-50 dark:border-slate-600">
                    Descartar
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">Nenhuma sugestão esperando você.</p>
      ))}

      {view && view.other_lessons_pending > 0 && (
        <p className="text-xs text-slate-500">
          {view.other_lessons_pending === 1 ? '1 sugestão' : `${view.other_lessons_pending} sugestões`} de aula dada por outro professor
          {view.other_lessons_pending === 1 ? ' espera' : ' esperam'} quem deu a aula, a coordenação ou a direção — a frase vem da transcrição daquela aula.
        </p>
      )}

      {view && (
        <div className="space-y-1 border-t border-indigo-100 pt-3 dark:border-indigo-900">
          {view.budget_reached ? (
            <p className="text-xs text-amber-800 dark:text-amber-200">{cardSuggestionReasonText('teto_atingido')}</p>
          ) : view.can_request ? (
            <button type="button" disabled={generating} onClick={() => void generate()}
              className="rounded-lg border border-indigo-400 px-3 py-1.5 text-sm font-semibold text-indigo-800 disabled:opacity-50 dark:text-indigo-200">
              {generating ? 'A IA está lendo a aula…' : `Sugerir a partir da aula de ${lessonDateLabel(view.request_class_date) || 'aprovada mais recente'}`}
            </button>
          ) : (
            <p className="text-xs text-slate-500">{cardSuggestionReasonText(view.request_reason)}</p>
          )}
          <p className="text-xs text-slate-500">
            A frase da aula fica guardada no máximo 90 dias depois da aula. Aceita ou descartada, a sugestão deixa de guardar o texto; fica só uma marca, para a IA não repetir a sugestão, apagada 90 dias depois.
          </p>
        </div>
      )}
    </section>
  );
}
