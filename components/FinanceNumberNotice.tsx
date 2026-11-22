import React, { useEffect, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';

/** O que o servidor manda para o aviso do número do financeiro. */
export interface FinanceWhatsAppNotice {
  noticeId: string;
  phone: string;
  displayName: string;
}

export function parseFinanceWhatsAppNotice(raw: unknown): FinanceWhatsAppNotice | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const phone = typeof r.phone === 'string' ? r.phone.replace(/\D/g, '') : '';
  const noticeId = typeof r.notice_id === 'string' ? r.notice_id.trim() : '';
  const displayName = typeof r.display_name === 'string' && r.display_name.trim()
    ? r.display_name.trim()
    : 'Wise Wolf Financeiro';
  if (!/^55\d{10,11}$/.test(phone) || !noticeId) return null;
  return { noticeId, phone, displayName };
}

/** 5511912345678 → +55 (11) 91234-5678 */
export function formatBrazilPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  const ddd = d.slice(2, 4);
  const rest = d.slice(4);
  const cut = rest.length - 4;
  return `+55 (${ddd}) ${rest.slice(0, cut)}-${rest.slice(cut)}`;
}

/**
 * Pop-up de UMA vez para o aluno: as cobranças passaram a vir só do WhatsApp
 * do financeiro (22/11/2026). O número vem do servidor (não fica no código);
 * "Entendi" grava em `feature_tour_views` e vale em qualquer aparelho.
 */
export default function FinanceNumberNotice({ userId, onActiveChange }: {
  userId: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const [notice, setNotice] = useState<FinanceWhatsAppNotice | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let alive = true;
    void supabase.rpc('my_finance_whatsapp_notice').then(({ data, error }) => {
      if (!alive || error) return;
      setNotice(parseFinanceWhatsAppNotice(data));
    });
    return () => { alive = false; };
  }, [userId]);

  useEffect(() => { onActiveChange?.(notice !== null); }, [notice, onActiveChange]);
  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);
  useEffect(() => {
    const node = dialog.current;
    if (notice && node && !node.open) node.showModal();
  }, [notice]);

  if (!notice) return null;
  const close = () => {
    // Falha ao gravar só faz o aviso voltar no próximo acesso: sem prejuízo.
    void supabase.from('feature_tour_views').upsert(
      { user_id: userId, tour_id: notice.noticeId },
      { onConflict: 'user_id,tour_id', ignoreDuplicates: true },
    );
    dialog.current?.close();
    setNotice(null);
  };
  const waText = encodeURIComponent('Olá! Salvei o contato do financeiro da Wise Wolf.');

  return <dialog ref={dialog} onCancel={close} aria-labelledby="finance-number-title"
    className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border-0 bg-white p-6 text-slate-900 shadow-2xl backdrop:bg-slate-950/60 dark:bg-slate-900 dark:text-white sm:p-8">
    <img src="/assets/brand/wise-wolf-financeiro-20261122.png" alt="Foto do WhatsApp Wise Wolf Financeiro: logo da Wise Wolf, a palavra Financeiro e pagamentos via Asaas"
      className="mx-auto mb-5 h-36 w-36 rounded-full border border-slate-200 shadow-sm dark:border-slate-700" />
    <p className="mb-2 text-center text-xs font-bold uppercase tracking-wide text-red-600 dark:text-red-300">Novo WhatsApp do financeiro</p>
    <h2 id="finance-number-title" className="text-center text-2xl font-bold">Suas cobranças agora vêm deste número</h2>
    <p className="mt-3 text-center text-2xl font-bold tracking-wide text-blue-900 dark:text-blue-200">{formatBrazilPhone(notice.phone)}</p>
    <p className="text-center text-sm font-semibold text-slate-500 dark:text-slate-400">{notice.displayName}</p>
    <p className="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
      Lembretes de mensalidade, boletos, Pix e confirmações de pagamento passam a chegar <strong>só</strong> por
      este WhatsApp, com a foto acima. Os pagamentos continuam pelo Asaas. O número da escola segue para aulas e
      atendimento, mas não envia mais cobranças.
    </p>
    <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      Salve o contato. Se receber cobrança da Wise Wolf vinda de outro número, não pague e fale com a escola.
    </p>
    <a href={`https://wa.me/${notice.phone}?text=${waText}`} target="_blank" rel="noopener noreferrer"
      className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white">
      <MessageCircle size={20} /> Abrir no WhatsApp e salvar
    </a>
    <button type="button" onClick={close} className="mt-3 w-full rounded-xl bg-blue-900 px-4 py-3 font-bold text-white">Entendi</button>
  </dialog>;
}
