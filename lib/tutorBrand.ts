/**
 * White label: nome do tutor de IA mostrado ao aluno. Wise Wolf = "Wolfie";
 * escola cliente com branding.tutorName = o nome dela (ex.: "Luna").
 * Um valor por aba, definido pelo App ao resolver a escola.
 */
import { useSyncExternalStore } from 'react';

export const DEFAULT_TUTOR_NAME = 'Wolfie';
let tutorName = DEFAULT_TUTOR_NAME;
const listeners = new Set<() => void>();

const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/[<>"`\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';

export function setTutorName(value: unknown): void {
  const next = clean(value) || DEFAULT_TUTOR_NAME;
  if (next === tutorName) return;
  tutorName = next;
  listeners.forEach((listener) => listener());
}

export const getTutorName = (): string => tutorName;

let schoolName = '';
/** Nome da escola cliente (vazio = Wise Wolf). Troca "Wise Wolf" nos textos embrulhados. */
export function setSchoolName(value: unknown): void {
  const next = clean(value).slice(0, 60);
  if (next === schoolName) return;
  schoolName = next;
  listeners.forEach((listener) => listener());
}

/** Troca a palavra "Wolfie" (só a palavra inteira) pelo nome do tutor da escola. */
const ARTICLE: Record<string, string> = { o: '', no: 'em ', do: 'de ', ao: 'a ', pelo: 'por ' };

export function brandText(text: string): string {
  if (schoolName) text = text.replace(/\bWise Wolf\b/g, schoolName);
  if (tutorName === DEFAULT_TUTOR_NAME) return text;
  // Nome próprio de escola cliente vai sem artigo ("com o Wolfie" → "com Luna").
  return text
    .replace(/\b(o|no|do|ao|pelo|O|No|Do|Ao|Pelo) Wolfie\b/g, (_, article: string) => {
      const replacement = ARTICLE[article.toLowerCase()];
      const capital = article[0] === article[0].toUpperCase();
      const prefix = capital && replacement ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
      return `${prefix}${tutorName}`;
    })
    .replace(/\bWolfie\b/g, tutorName);
}

export function useTutorName(): string {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getTutorName,
    getTutorName,
  );
}
