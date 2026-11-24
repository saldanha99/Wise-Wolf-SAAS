import React, { useEffect, useRef, useState } from 'react';
import { Megaphone, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { parsePlatformNotices, type PlatformNoticeItem } from '../lib/platformNotices';

/**
 * Aviso da escola em pop-up (tabela `platform_notices`: escola, público, título,
 * texto e janela). Aparece até a pessoa clicar em "Entendi"; o clique fica gravado
 * no servidor (`acknowledge_platform_notice`: usuário, papel, escola, data e hora)
 * como prova do aviso e vale em qualquer aparelho. Falha ao gravar: o aviso fica
 * na tela com a mensagem de erro e "Tentar de novo" — nunca some sem prova.
 */
export default function PlatformNotice({ userId, onActiveChange }: {
  userId: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const [queue, setQueue] = useState<PlatformNoticeItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const current = queue[0] ?? null;

  useEffect(() => {
    let alive = true;
    void supabase.rpc('my_pending_platform_notices').then(({ data, error: rpcError }) => {
      if (!alive || rpcError) return;
      setQueue(parsePlatformNotices(data));
    });
    return () => { alive = false; };
  }, [userId]);

  useEffect(() => { onActiveChange?.(current !== null); }, [current, onActiveChange]);
  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);
  useEffect(() => {
    const node = dialog.current;
    if (current && node && !node.open) node.showModal();
  }, [current]);

  if (!current) return null;

  const acknowledge = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    const { data, error: rpcError } = await supabase.rpc('acknowledge_platform_notice', { p_notice_id: current.id });
    setSaving(false);
    const result = data as { ok?: boolean; error?: string } | null;
    const ok = !rpcError && result?.ok === true;
    // Janela encerrou com o aviso aberto: não há mais o que confirmar, fecha.
    const expired = !rpcError && result?.error === 'aviso_indisponivel';
    if (!ok && !expired) {
      setError('Não consegui registrar agora. Confira a internet e toque em "Tentar de novo".');
      return;
    }
    dialog.current?.close();
    setQueue(rest => rest.slice(1));
  };

  return <dialog ref={dialog} onCancel={event => event.preventDefault()} aria-labelledby="platform-notice-title"
    data-testid="platform-notice"
    className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border-0 bg-white p-6 text-slate-900 shadow-2xl backdrop:bg-slate-950/60 dark:bg-slate-900 dark:text-white sm:p-8">
    <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200"><Megaphone size={26} /></div>
    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-blue-800 dark:text-blue-300">Aviso da escola</p>
    <h2 id="platform-notice-title" className="text-2xl font-bold">{current.title}</h2>
    <p className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-600 dark:text-slate-300">{current.body}</p>
    {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-200">{error}</p>}
    <button type="button" onClick={() => void acknowledge()} disabled={saving} aria-busy={saving}
      className="mt-6 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-blue-900 px-4 py-3 font-bold text-white disabled:opacity-70">
      {saving ? <><Loader2 size={18} className="animate-spin" /> Registrando…</> : error ? 'Tentar de novo' : 'Entendi'}
    </button>
  </dialog>;
}
