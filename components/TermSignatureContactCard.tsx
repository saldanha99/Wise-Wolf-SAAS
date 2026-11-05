import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// O link de assinatura da escola sai do número central. Se o destino for esse
// mesmo número, a mensagem vai para si mesma e ninguém recebe aviso (10 links, 0
// abertos até 05/11/2026). Por isso a direção cadastra aqui um celular pessoal.
// O telefone fica neste formulário, nunca no código.

interface Contact {
  phone: string | null;
  needs_number: boolean;
}

const ERROR_TEXT: Record<string, string> = {
  numero_invalido: 'Confira o número, com DDD.',
  numero_da_escola: 'Esse é o número da escola, o mesmo que envia as mensagens. Use um celular pessoal.',
};

const formatPhone = (digits: string) => {
  const national = digits.replace(/^55/, '');
  return `(${national.slice(0, 2)}) ${national.slice(2, -4)}-${national.slice(-4)}`;
};

export default function TermSignatureContactCard() {
  const [contact, setContact] = useState<Contact | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const { data, error: rpcError } = await supabase.rpc('my_term_signature_contact');
      // Quem não é da direção recebe ok:false: o cartão simplesmente não aparece.
      if (rpcError || data?.ok !== true || typeof data.needs_number !== 'boolean') return;
      setContact({ phone: data.phone ?? null, needs_number: data.needs_number });
    } catch {
      // Falha na leitura não pode atrapalhar a lista de termos logo abaixo.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!contact) return null;

  const showForm = editing || contact.needs_number;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data, error: rpcError } = await supabase.rpc('set_my_term_signature_contact', { p_phone: draft });
      if (rpcError) throw rpcError;
      if (data?.ok !== true) {
        setError(ERROR_TEXT[data?.error] || 'Não foi possível salvar o número. Tente de novo.');
        return;
      }
      setContact({ phone: data.phone, needs_number: false });
      setEditing(false);
      setDraft('');
      const sent = Number(data.links_sent) || 0;
      setNotice(sent > 0
        ? `Número salvo. ${sent === 1 ? '1 link de assinatura foi enviado' : `${sent} links de assinatura foram enviados`} para ele. Entre 21h e 8h, a mensagem espera as 8h.`
        : 'Número salvo. Os próximos links de assinatura chegam nele.');
    } catch {
      setError('Não foi possível salvar o número. Tente de novo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-tour="term-signature-phone"
      className={`rounded-xl border p-4 ${contact.needs_number ? 'border-amber-500/40 bg-amber-500/10' : 'border-brand-border bg-brand-surface'}`}
    >
      <p className="text-sm font-bold text-brand-text">WhatsApp para assinar pela escola</p>
      {contact.needs_number ? (
        <p className="mt-1 text-sm text-brand-text">
          O link de assinatura ainda não chega a ninguém: o número cadastrado na direção é o mesmo que envia as mensagens.
          Cadastre um celular seu. Enquanto isso, os termos pendentes podem ser assinados aqui nesta tela.
        </p>
      ) : (
        <p className="mt-1 text-sm text-brand-text">
          Os links de assinatura da escola chegam em <span className="font-bold">{contact.phone ? formatPhone(contact.phone) : 'seu telefone cadastrado'}</span>.
          {!editing && (
            <button type="button" onClick={() => { setEditing(true); setNotice(''); }} className="ml-2 underline">
              Trocar número
            </button>
          )}
        </p>
      )}
      {showForm && (
        <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-56 flex-1 text-sm font-semibold text-brand-text">
            Celular com DDD
            <input
              required
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              className="mt-1 w-full rounded-lg border bg-brand-surface p-2 font-normal"
            />
          </label>
          <button type="submit" disabled={busy} className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-bold text-white">
            {busy ? 'Salvando…' : 'Salvar número'}
          </button>
          {editing && !contact.needs_number && (
            <button type="button" disabled={busy} onClick={() => { setEditing(false); setError(''); }} className="rounded-lg border px-4 py-2 text-sm">
              Cancelar
            </button>
          )}
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-sm font-semibold text-red-700 dark:text-red-300">{error}</p>}
      {notice && <p role="status" className="mt-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">{notice}</p>}
    </div>
  );
}
