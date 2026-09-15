import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Proposal {
  id: string;
  student_name: string;
  term_months: number;
  monthly_fee_cents: number;
  total_cents: number;
  classes_per_week: number;
  suggested_due_day: number;
  status: 'DRAFT';
  signature_status: 'NOT_REQUESTED';
  billing_status: 'NOT_AUTHORIZED';
}

function parseProposals(data: unknown): Proposal[] {
  const items = data && typeof data === 'object' ? (data as { items?: unknown }).items : null;
  if (!Array.isArray(items) || items.some(item =>
    !item || typeof item.id !== 'string' || typeof item.student_name !== 'string'
    || item.term_months !== 6 || item.status !== 'DRAFT'
    || item.signature_status !== 'NOT_REQUESTED' || item.billing_status !== 'NOT_AUTHORIZED'
    || !Number.isSafeInteger(item.monthly_fee_cents) || item.monthly_fee_cents <= 0
    || item.total_cents !== item.monthly_fee_cents * 6
    || !Number.isInteger(item.classes_per_week) || item.classes_per_week < 1 || item.classes_per_week > 7
    || !Number.isInteger(item.suggested_due_day) || item.suggested_due_day < 1 || item.suggested_due_day > 28
  )) throw new Error('invalid_renewal_conditions');
  return items;
}

const currency = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function CourseRenewalProposals({ tenantId }: { tenantId?: string }) {
  const [state, setState] = useState<{ tenant?: string; rows: Proposal[]; error: boolean; loaded: boolean }>({ rows: [], error: false, loaded: false });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ tenant: tenantId, rows: [], error: false, loaded: false });
    void (async () => {
      try {
        const result = await supabase.rpc('list_student_course_renewal_proposals', { p_tenant: tenantId ?? null });
        if (result.error) throw result.error;
        const rows = parseProposals(result.data);
        if (!cancelled) setState({ tenant: tenantId, rows, error: false, loaded: true });
      } catch {
        if (!cancelled) setState({ tenant: tenantId, rows: [], error: true, loaded: true });
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, retry]);

  if (state.tenant !== tenantId || !state.loaded) return null;
  if (state.error) return <div role="alert" className="rounded-2xl border border-brand-border p-4 text-sm">
    Não foi possível consultar as condições de renovação.
    <button type="button" onClick={() => setRetry(value => value + 1)} className="ml-3 underline">Tentar novamente</button>
  </div>;
  if (!state.rows.length) return null;
  return <section aria-labelledby="renewal-conditions-heading" className="rounded-3xl border border-brand-border bg-brand-surface p-5">
    <h2 id="renewal-conditions-heading" className="text-lg font-bold text-brand-text">Condições de renovação — 6 meses</h2>
    <p className="mt-2 text-sm text-brand-muted">Propostas comerciais registradas. Ainda não há contrato reassinado, link enviado ou cobrança autorizada por estas propostas.</p>
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead><tr>{['Aluna', 'Mensalidade', 'Aulas por semana', 'Total em 6 meses', 'Dia sugerido'].map(label => <th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead>
        <tbody>{state.rows.map(row => <tr key={row.id} className="border-t border-brand-border">
          <th scope="row" className="p-2 font-medium">{row.student_name}</th>
          <td className="p-2">{currency(row.monthly_fee_cents)}</td>
          <td className="p-2">{row.classes_per_week}</td>
          <td className="p-2">{currency(row.total_cents)}</td>
          <td className="p-2">{row.suggested_due_day}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="mt-3 text-xs text-brand-muted">As datas do novo período e a situação no Asaas precisam ser validadas antes do aceite. Parcelas existentes e períodos já pagos não são alterados aqui.</p>
  </section>;
}
