import React, { useEffect, useRef, useState } from 'react';
import { CalendarOff } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { describeNationalHoliday, parseUpcomingNationalHoliday, type UpcomingNationalHoliday } from '../lib/nationalHolidays';

/**
 * Pop-up do feriado nacional: aparece na semana do feriado (até 7 dias antes e no
 * próprio dia) para quem entra na plataforma. Fechar vale para aquele feriado,
 * neste aparelho — o aviso oficial é o WhatsApp de 7 dias e de 1 dia antes.
 */
export default function NationalHolidayNotice({ userId, onActiveChange }: {
  userId: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const [holiday, setHoliday] = useState<UpcomingNationalHoliday | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let alive = true;
    void supabase.rpc('my_upcoming_national_holiday').then(({ data, error }) => {
      if (!alive || error) return;
      const next = parseUpcomingNationalHoliday(data);
      if (next && !wasDismissed(userId, next.date)) setHoliday(next);
    });
    return () => { alive = false; };
  }, [userId]);

  useEffect(() => { onActiveChange?.(holiday !== null); }, [holiday, onActiveChange]);
  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);
  useEffect(() => {
    const node = dialog.current;
    if (holiday && node && !node.open) node.showModal();
  }, [holiday]);

  if (!holiday) return null;
  const text = describeNationalHoliday(holiday);
  const close = () => {
    rememberDismissal(userId, holiday.date);
    dialog.current?.close();
    setHoliday(null);
  };

  return <dialog ref={dialog} onCancel={close} aria-labelledby="national-holiday-title"
    className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border-0 bg-white p-6 text-slate-900 shadow-2xl backdrop:bg-slate-950/60 dark:bg-slate-900 dark:text-white sm:p-8">
    <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-100 text-red-700"><CalendarOff size={26} /></div>
    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-red-600 dark:text-red-300">Feriado nacional · {text.when}</p>
    <h2 id="national-holiday-title" className="text-2xl font-bold">Não haverá aula {text.dayLabel}</h2>
    <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
      {text.dateLabel} é feriado nacional — <strong>{holiday.name}</strong>. Nenhuma aula da agenda acontece nesse dia,
      e as aulas seguem normalmente nos dias seguintes.
    </p>
    <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Ponto facultativo (como Carnaval e Corpus Christi) tem aula normal.</p>
    <button type="button" onClick={close} className="mt-6 w-full rounded-xl bg-blue-900 px-4 py-3 font-bold text-white">Entendi</button>
  </dialog>;
}

const storageKey = (userId: string, date: string) => `wisewolf.holidayNotice.${userId}.${date}`;

function wasDismissed(userId: string, date: string): boolean {
  try { return window.localStorage.getItem(storageKey(userId, date)) === '1'; } catch { return false; }
}

function rememberDismissal(userId: string, date: string) {
  try { window.localStorage.setItem(storageKey(userId, date), '1'); } catch { /* sem armazenamento: aparece de novo, sem prejuízo */ }
}
