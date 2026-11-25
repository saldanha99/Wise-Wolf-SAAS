import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileSignature, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import TeacherContractAccept from './TeacherContractAccept';

/**
 * Contrato geral obrigatório do professor novo (decisão da direção, 25/11/2026).
 * Conta criada a partir de 25/11 sem contrato aceito e sem dispensa abre este
 * pop-up e só navega depois de assinar. Quem não tem CNPJ escolhe "Sou autônomo"
 * dentro do contrato. Antes, os dados pessoais que o contrato imprime.
 * Falha na consulta não prende ninguém (a assinatura de termo por aluno segue
 * exigindo o contrato no servidor).
 */
type Gate = { required: boolean; missing?: string[] };

const ERRORS: Record<string, string> = {
  cpf_invalido: 'Confira o CPF.',
  rg_invalido: 'Confira o RG.',
  nascimento_invalido: 'Confira a data de nascimento.',
  endereco_invalido: 'Informe o endereço completo.',
  cpf_em_uso: 'Este CPF já está em outro cadastro de professor. Fale com a direção.',
  contrato_ja_assinado: 'Seu contrato já está assinado.',
};

export default function TeacherContractGate({ userId, blocked, onActiveChange, onLogout }: {
  userId: string;
  blocked: boolean;
  onActiveChange: (active: boolean) => void;
  onLogout: () => void;
}) {
  const [gate, setGate] = useState<Gate | null>(null);
  const [form, setForm] = useState({ cpf: '', rg: '', birthDate: '', address: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  const check = useCallback(async () => {
    try {
      const { data, error: rpcError } = await supabase.rpc('my_teacher_contract_gate');
      if (rpcError || !data || typeof data !== 'object') return;
      setGate(data as Gate);
    } catch { /* falha de leitura não prende ninguém */ }
  }, []);

  useEffect(() => { void check(); }, [check]);

  const active = !blocked && gate?.required === true;
  const needsIdentity = active && (gate?.missing?.length ?? 0) > 0;
  useEffect(() => { onActiveChange(active); }, [active, onActiveChange]);
  useEffect(() => () => onActiveChange(false), [onActiveChange]);
  useEffect(() => {
    if (!needsIdentity) return;
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { if (node?.open) node.close(); };
  }, [needsIdentity]);

  if (!active) return null;

  if (!needsIdentity) {
    return <TeacherContractAccept userId={userId} mandatory onLogout={onLogout}
      onAccepted={() => { setGate({ required: false }); void check(); }} />;
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true); setError('');
    try {
      const { data, error: rpcError } = await supabase.rpc('save_my_teacher_contract_identity', {
        p_cpf: form.cpf, p_rg: form.rg, p_birth_date: form.birthDate || null, p_address: form.address,
      });
      if (rpcError || data?.ok !== true) {
        setError(ERRORS[data?.error as string] || 'Não foi possível salvar. Tente novamente.');
        return;
      }
      await check();
    } catch {
      setError('Não foi possível salvar. Tente novamente.');
    } finally {
      setSaving(false);
    }
  };

  const field = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white';
  return <dialog ref={dialog} onCancel={event => event.preventDefault()} aria-labelledby="teacher-contract-gate-title"
    className="m-auto w-[calc(100%-2rem)] max-w-lg max-h-[92dvh] overflow-y-auto rounded-3xl border-0 bg-white p-6 text-slate-900 shadow-2xl backdrop:bg-slate-950/70 dark:bg-slate-900 dark:text-white sm:p-8">
    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><FileSignature size={26} /></div>
    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Pendência obrigatória · Contrato</p>
    <h2 id="teacher-contract-gate-title" className="text-2xl font-bold">Assine seu contrato com a escola</h2>
    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
      Antes de continuar, informe seus dados pessoais. Eles entram no contrato. Na próxima tela, se você ainda não tem CNPJ, escolha <strong>“Sou autônomo, sem CNPJ”</strong>.
    </p>
    <form onSubmit={save} className="mt-5 space-y-3">
      <label className="block text-sm font-semibold">CPF
        <input className={field} inputMode="numeric" autoComplete="off" required value={form.cpf}
          onChange={e => setForm({ ...form, cpf: e.target.value })} disabled={saving} /></label>
      <label className="block text-sm font-semibold">RG
        <input className={field} required value={form.rg} onChange={e => setForm({ ...form, rg: e.target.value })} disabled={saving} /></label>
      <label className="block text-sm font-semibold">Data de nascimento
        <input className={field} type="date" required value={form.birthDate}
          onChange={e => setForm({ ...form, birthDate: e.target.value })} disabled={saving} /></label>
      <label className="block text-sm font-semibold">Endereço completo (rua, número, bairro, cidade, UF)
        <input className={field} autoComplete="street-address" required value={form.address}
          onChange={e => setForm({ ...form, address: e.target.value })} disabled={saving} /></label>
      {error && <p role="alert" className="text-sm font-semibold text-red-600">{error}</p>}
      <button type="submit" disabled={saving}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white disabled:opacity-60">
        {saving && <Loader2 className="animate-spin" size={16} />} Continuar para o contrato
      </button>
    </form>
    <button type="button" onClick={onLogout} className="mt-4 w-full py-2 text-sm text-slate-500 dark:text-slate-400">Sair da conta do portal</button>
  </dialog>;
}
