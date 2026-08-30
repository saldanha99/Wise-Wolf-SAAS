import React, { useState, useEffect } from 'react';
import {
  CreditCard,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  DollarSign,
  Calendar,
  ShieldCheck,
  Download,
  Info,
  Copy,
  ExternalLink,
  QrCode
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { User as UserType } from '../types';
import { getSchoolInfo } from '../lib/schoolInfo';
import { buildSchoolSupportContact, type SupportContact } from '../lib/supportContact';
import BillingMethodManager from './BillingMethodManager';

interface StudentBillingProps {
  user: Pick<UserType, 'id' | 'tenantId'>;
}

interface Payment {
  id: string;
  asaas_payment_id: string;
  value: number;
  status: string; // 'PENDING', 'RECEIVED', 'CONFIRMED', 'OVERDUE'
  due_date: string;
  payment_date?: string;
  invoice_url?: string;
  pix_code?: string;
  billing_type?: string;
  description?: string;
}

import { useStudentContext } from './contexts/StudentContext';

const StudentBilling: React.FC<StudentBillingProps> = ({ user }) => {
  const { data: studentContext, loading: contextLoading } = useStudentContext();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [supportContact, setSupportContact] = useState<SupportContact | null>(null);

  // Derived from Context
  const billingInfo = studentContext?.profile; // Contains monthly_fee, due_day, status_financial
  // const contextBillingStatus = studentContext?.billing?.status; // OK, OVERDUE, SUSPENDED

  // Fallback: derive billing summary from actual payments if profile data is empty
  const derivedMonthlyFee = (() => {
    if (billingInfo?.monthly_fee && Number(billingInfo.monthly_fee) > 0) return Number(billingInfo.monthly_fee);
    // Compute from most recent payment
    if (payments.length > 0) {
      const latestPayment = [...payments].sort((a, b) => new Date(b.due_date).getTime() - new Date(a.due_date).getTime())[0];
      return Number(latestPayment.value) || 0;
    }
    return 0;
  })();

  const derivedDueDay = (() => {
    if (billingInfo?.due_day) return billingInfo.due_day;
    // Compute from most recent payment
    if (payments.length > 0) {
      const latestPayment = [...payments].sort((a, b) => new Date(b.due_date).getTime() - new Date(a.due_date).getTime())[0];
      const dueDate = new Date(latestPayment.due_date);
      return dueDate.getUTCDate();
    }
    return null;
  })();

  const derivedStatus = billingInfo?.status_financial || (payments.length > 0 ? 'ACTIVE' : 'PENDING');

  const fetchPaymentHistory = async () => {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const { data: paymentsData, error: paymentsError } = await supabase
        .from('student_payments')
        .select('*')
        .eq('student_id', user.id)
        .eq('tenant_id', user.tenantId)
        .order('due_date', { ascending: false });

      if (paymentsError) throw paymentsError;
      setPayments(paymentsData || []);
    } catch (err) {
      console.error('Error fetching payment history:', err);
      setPayments([]);
      setHistoryError('Não foi possível carregar suas cobranças agora. Tente novamente antes de concluir que não há valores em aberto.');
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    if (user?.id && user?.tenantId) fetchPaymentHistory();
  }, [user?.id, user?.tenantId]);

  useEffect(() => {
    let active = true;
    const tenantId = studentContext?.profile?.tenant_id || user.tenantId;

    void getSchoolInfo(tenantId)
      .then((school) => {
        if (active) {
          setSupportContact(buildSchoolSupportContact(
            school,
            'Olá! Preciso de ajuda com uma cobrança ou forma de pagamento.',
          ));
        }
      })
      .catch(() => {
        if (active) setSupportContact(null);
      });

    return () => {
      active = false;
    };
  }, [studentContext?.profile?.tenant_id, user.tenantId]);

  if (contextLoading || loadingHistory) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-brand-muted">
        <RefreshCw className="animate-spin mb-4" size={32} />
        <p className="text-xs font-black uppercase tracking-widest">Carregando dados financeiros...</p>
      </div>
    );
  }

  // Helper functions
  const formatDate = (dateString: string) => {
    if (!dateString) return '-';
    // Fix Timezone issue by splitting the string YYYY-MM-DD
    const dateParts = dateString.split('-');
    return `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
  };

  // Logic for Alert Status
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let alertStatus = 'NORMAL'; // NORMAL, OVERDUE, BLOCKED
  let daysLate = 0;
  let oldestOverduePayment: Payment | null = null;

  const overduePayments = payments.filter(p => p.status === 'OVERDUE');

  if (overduePayments.length > 0) {
    // Find oldest due date to calculate block status
    const sortedOverdue = [...overduePayments].sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
    oldestOverduePayment = sortedOverdue[0];

    const dueDate = new Date(oldestOverduePayment.due_date);
    // Normalize due date to midnight for correct diff
    dueDate.setHours(0, 0, 0, 0); // Ensure we compare dates only

    // If dueDate is indeed in the past relative to today
    if (dueDate < today) {
      const diffTime = Math.abs(today.getTime() - dueDate.getTime());
      daysLate = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (daysLate > 7) {
        alertStatus = 'BLOCKED';
      } else {
        alertStatus = 'OVERDUE';
      }
    }
  }

  return (
    <div className="space-y-6 sm:space-y-8 animate-in fade-in duration-500 pb-20 relative font-sans">
      <header className="bg-indigo-950 bg-gradient-to-r from-tenant-primary to-purple-600 text-white p-6 sm:p-8 rounded-[2rem] sm:rounded-[2.5rem] shadow-lg mb-6 sm:mb-8">
        <h2 className="text-2xl sm:text-4xl font-black tracking-tighter">Meu Financeiro</h2>
        <p className="text-white/80 text-sm mt-1">Acompanhe seus planos, pagamentos e histórico de mensalidades.</p>
      </header>

      {historyError && (
        <div className="flex flex-col gap-4 rounded-2xl border border-red-200 bg-red-50 p-5 text-left dark:border-red-900/40 dark:bg-red-950/20 sm:flex-row sm:items-center" role="alert">
          <AlertCircle className="shrink-0 text-red-600" size={28} />
          <div className="flex-1">
            <p className="font-black text-red-800 dark:text-red-200">Cobranças indisponíveis</p>
            <p className="mt-1 text-sm font-medium text-red-700 dark:text-red-300">{historyError}</p>
          </div>
          <button
            type="button"
            onClick={() => void fetchPaymentHistory()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-xs font-black uppercase tracking-widest text-white sm:w-auto"
          >
            <RefreshCw size={15} /> Tentar novamente
          </button>
        </div>
      )}

      {/* SELO: PAGO ADIANTADO (6 meses / anual) */}
      {billingInfo?.paid_through && billingInfo.paid_through >= new Date().toISOString().split('T')[0] && (
        <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 rounded-2xl p-5 flex items-start sm:items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-emerald-500 text-white flex items-center justify-center shrink-0">
            <CheckCircle size={24} />
          </div>
          <div className="min-w-0">
            <p className="font-black text-emerald-700 dark:text-emerald-300 text-sm uppercase tracking-wide">Plano quitado — pago adiantado</p>
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              Você está em dia{billingInfo.prepaid_months ? ` (${billingInfo.prepaid_months} meses pagos de uma vez)` : ''} até <b>{new Date(billingInfo.paid_through + 'T00:00:00').toLocaleDateString('pt-BR')}</b>. Nenhuma mensalidade a pagar nesse período. 🎉
            </p>
          </div>
        </div>
      )}

      {/* ALERT STATUS CARDS */}

      {/* 1. BLOCKED STATUS (> 7 days late) */}
      {alertStatus === 'BLOCKED' && (
        <div className="bg-slate-950 text-white rounded-2xl p-5 sm:p-8 flex flex-col sm:flex-row items-start gap-4 sm:gap-6 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 p-12 opacity-10">
            <ShieldCheck size={180} />
          </div>
          <div className="p-4 bg-white/10 rounded-2xl backdrop-blur-sm shrink-0">
            <AlertCircle size={32} className="text-red-400" />
          </div>
          <div className="flex-1 relative z-10">
            <h3 className="text-2xl font-black uppercase tracking-tight text-white mb-2">ACESSO BLOQUEADO</h3>
            <p className="text-slate-300 font-medium text-sm leading-relaxed mb-6">
              Consta uma pendência financeira superior a 7 dias ({daysLate} dias de atraso).
              Seu acesso às aulas e materiais foi suspenso temporariamente.
            </p>
            <div className="bg-red-500/10 border border-red-500/30 p-4 rounded-xl">
              <p className="text-red-300 text-xs font-bold uppercase tracking-widest mb-2">Fatura Crítica</p>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <span className="text-white font-black text-lg">
                  {oldestOverduePayment && formatDate(oldestOverduePayment.due_date)}
                </span>
                {oldestOverduePayment?.invoice_url && (
                  <a
                    href={oldestOverduePayment.invoice_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full sm:w-auto bg-white text-slate-950 px-6 py-2.5 rounded-lg font-black text-xs uppercase tracking-widest text-center hover:bg-red-50 transition-colors whitespace-nowrap"
                  >
                    Regularizar Agora
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. OVERDUE STATUS (1-7 days late) */}
      {alertStatus === 'OVERDUE' && (
        <div className="bg-red-50 dark:bg-red-900/20 border-2 border-red-100 dark:border-red-900 rounded-2xl p-6 flex items-start gap-4 shadow-xl shadow-red-100/50 animate-pulse">
          <div className="p-3 bg-red-100 dark:bg-red-800 text-red-600 dark:text-red-200 rounded-xl">
            <AlertCircle size={24} />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-black text-red-800 dark:text-red-200 uppercase tracking-tight">FATURA VENCIDA!</h3>
            <p className="text-sm text-red-700 dark:text-red-300 font-medium mt-1">
              Você tem <strong>{daysLate} dia(s)</strong> de atraso. Evite o bloqueio do seu acesso regularizando antes de 7 dias.
            </p>

            <div className="mt-4 flex flex-col gap-3">
              {overduePayments.map(payment => (
                <div key={payment.id} className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between bg-brand-surface p-4 rounded-xl border border-red-100 dark:border-red-900/50 shadow-sm gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-black text-brand-muted uppercase tracking-widest">
                      Vencimento {formatDate(payment.due_date)}
                    </p>
                    <p className="text-lg font-black text-brand-text">
                      R$ {Number(payment.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                  {payment.invoice_url && (
                    <a
                      href={payment.invoice_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full sm:w-auto text-center bg-red-600 text-white px-6 py-2.5 rounded-lg font-black text-xs uppercase tracking-widest hover:bg-red-700 transition-colors shadow-lg shadow-red-600/20 whitespace-nowrap"
                    >
                      Pagar Agora
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 3. PENDING (Regular, just open) - Keep showing generic info if has pending but not overdue */}
      {alertStatus === 'NORMAL' && payments.some(p => p.status === 'PENDING') && (
        <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-800/30 rounded-2xl p-6 flex items-start gap-4 shadow-xl shadow-amber-100/50">
          <div className="p-3 bg-amber-100 dark:bg-amber-800 text-amber-600 dark:text-amber-200 rounded-xl">
            <Info size={24} />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-black text-amber-800 dark:text-amber-200 uppercase tracking-tight">Fatura Disponível</h3>
            <p className="text-sm text-amber-700 dark:text-amber-300 font-medium mt-1">
              Sua mensalidade deste mês já está disponível para pagamento.
            </p>
            <div className="mt-4 flex flex-col gap-3">
              {payments.filter(p => p.status === 'PENDING').map(payment => (
                <div key={payment.id} className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between bg-brand-surface p-4 rounded-xl border border-amber-100 dark:border-amber-900/50 shadow-sm gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-black text-brand-muted uppercase tracking-widest">
                      Vencimento {formatDate(payment.due_date)}
                    </p>
                    <p className="text-lg font-black text-brand-text">
                      R$ {Number(payment.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                  {payment.invoice_url && (
                    <a
                      href={payment.invoice_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full sm:w-auto text-center bg-amber-500 text-white px-6 py-2.5 rounded-lg font-black text-xs uppercase tracking-widest hover:bg-amber-600 transition-colors shadow-lg shadow-amber-500/20 whitespace-nowrap"
                    >
                      Pagar Agora
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Main Card: Current Plan */}
        <div className="lg:col-span-2 bg-brand-surface rounded-[2.5rem] border border-brand-border p-6 sm:p-8 shadow-xl shadow-slate-200/50 dark:shadow-none relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-500">
            <ShieldCheck size={120} className="text-tenant-primary" />
          </div>

          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-8">
              <div className="p-3 bg-tenant-primary/10 text-tenant-primary rounded-2xl">
                <CreditCard size={24} />
              </div>
              <div>
                <span className="text-[10px] font-black text-brand-muted uppercase tracking-widest block">Status da Assinatura</span>
                <span className={`flex items-center gap-2 font-black text-sm uppercase tracking-wide ${derivedStatus === 'ACTIVE' ? 'text-emerald-500' : 'text-amber-500'}`}>
                  <CheckCircle size={14} /> {derivedStatus === 'ACTIVE' ? 'Ativo & Regular' : derivedStatus || 'Sem Plano'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
              <div>
                <h4 className="text-[10px] font-black text-brand-muted uppercase tracking-widest mb-2">Valor Mensal</h4>
                <div className="flex items-baseline gap-1">
                  <span className="text-lg font-bold text-brand-muted">R$</span>
                  <span className="text-4xl font-black text-brand-text tracking-tighter">
                    {derivedMonthlyFee.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
              <div>
                <h4 className="text-[10px] font-black text-brand-muted uppercase tracking-widest mb-2">Dia de Vencimento</h4>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-brand-surface-2 dark:bg-brand-surface-2 rounded-lg text-brand-muted">
                    <Calendar size={18} />
                  </div>
                  <span className="text-xl font-black text-brand-text dark:text-slate-200 tracking-tight">Dia {derivedDueDay || '??'}</span>
                </div>
              </div>
            </div>

            <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-2xl flex items-center gap-4 text-blue-700 dark:text-blue-400 text-xs font-bold border border-blue-100 dark:border-blue-900/30">
              <Info size={20} className="shrink-0" />
              <p>Seu pagamento é processado mensalmente. Utilize os botões de "Pagar Agora" para acessar sua fatura ou código PIX atualizados.</p>
            </div>
          </div>
        </div>

        {/* Support/Info Card */}
        <div className="bg-slate-950 rounded-[2.5rem] p-6 sm:p-8 text-white shadow-2xl relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:rotate-12 transition-transform duration-500">
            <DollarSign size={100} />
          </div>

          <div className="relative z-10 h-full flex flex-col justify-between">
            <div>
              <h3 className="text-2xl font-black tracking-tight mb-4">Dúvidas com Pagamento?</h3>
              <p className="text-slate-300 text-sm leading-relaxed mb-6">
                Caso precise alterar sua forma de pagamento ou tenha dúvidas sobre cobranças, entre em contato direto com a secretaria da escola.
              </p>
            </div>

            {supportContact ? (
              <a
                href={supportContact.href}
                target={supportContact.href.startsWith('https://') ? '_blank' : undefined}
                rel={supportContact.href.startsWith('https://') ? 'noopener noreferrer' : undefined}
                className="w-full py-4 bg-white text-slate-950 rounded-2xl font-black text-xs uppercase tracking-widest hover:scale-[1.02] active:scale-95 transition-all text-center"
              >
                {supportContact.label}
              </a>
            ) : (
              <p className="w-full rounded-2xl border border-white/20 bg-white/10 px-4 py-3 text-center text-xs font-bold text-slate-200" role="status">
                Consulte os contatos da secretaria no seu contrato.
              </p>
            )}
          </div>
        </div>

      </div>

      <BillingMethodManager studentId={user.id} selfService />

      {/* History Table */}
      <div className="bg-brand-surface rounded-[3rem] border border-brand-border shadow-xl shadow-slate-200/50 dark:shadow-none overflow-hidden">
        <div className="p-5 sm:p-8 border-b dark:border-brand-border flex justify-between items-center bg-brand-surface-2/50 dark:bg-brand-surface-2/30">
          <h3 className="font-black text-brand-text dark:text-slate-200 text-sm uppercase tracking-widest">Histórico de Mensalidades (Todos)</h3>
        </div>
        <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
          {payments.length > 0 ? payments.map(payment => {
            const isPaid = payment.status === 'RECEIVED' || payment.status === 'CONFIRMED';
            const isOverdue = payment.status === 'OVERDUE';
            return (
              <article key={payment.id} className="p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-brand-muted mb-1">Vencimento</p>
                    <p className="text-sm font-bold text-brand-text">{formatDate(payment.due_date)}</p>
                  </div>
                  <span className={`shrink-0 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest whitespace-nowrap ${
                    isPaid
                      ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20'
                      : isOverdue
                        ? 'text-red-600 bg-red-50 dark:bg-red-900/20'
                        : 'text-amber-600 bg-amber-50 dark:bg-amber-900/20'
                  }`}>
                    {isPaid ? 'Pago' : isOverdue ? 'Vencido' : 'Em aberto'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-brand-surface-2/70 rounded-xl p-3">
                    <p className="text-[9px] font-black uppercase tracking-widest text-brand-muted mb-1">Valor</p>
                    <p className="font-black text-brand-text">
                      R$ {Number(payment.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div className="bg-brand-surface-2/70 rounded-xl p-3 min-w-0">
                    <p className="text-[9px] font-black uppercase tracking-widest text-brand-muted mb-1">Forma</p>
                    <p className="text-xs font-bold uppercase text-brand-text truncate">{payment.billing_type || '-'}</p>
                  </div>
                </div>

                {(payment.status === 'PENDING' || payment.status === 'OVERDUE') && payment.invoice_url ? (
                  <a
                    href={payment.invoice_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full inline-flex items-center justify-center gap-2 bg-[#002366] bg-tenant-primary text-white px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest"
                  >
                    Pagar Agora <ExternalLink size={12} />
                  </a>
                ) : isPaid ? (
                  <div className="w-full inline-flex items-center justify-center gap-2 text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 px-4 py-3 rounded-xl font-bold text-xs">
                    <CheckCircle size={16} /> Pagamento confirmado
                  </div>
                ) : (
                  <p className="text-center text-brand-muted text-xs">Nenhuma ação disponível.</p>
                )}
              </article>
            );
          }) : (
            <p className="px-6 py-10 text-center text-brand-muted text-sm font-bold">
              {historyError ? 'Histórico temporariamente indisponível.' : 'Nenhum pagamento registrado no histórico.'}
            </p>
          )}
        </div>

        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left min-w-[500px]">
            <thead className="bg-brand-surface-2/50 text-[10px] text-brand-muted uppercase font-black border-b dark:border-brand-border">
              <tr>
                <th className="px-8 py-5">Vencimento</th>
                <th className="px-8 py-5">Valor</th>
                <th className="px-8 py-5">Forma Pagto</th>
                <th className="px-8 py-5">Status</th>
                <th className="px-8 py-5 text-right">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
              {payments.length > 0 ? payments.map(payment => (
                <tr key={payment.id} className="hover:bg-brand-surface-2/50 dark:hover:bg-brand-surface-2/30 transition-colors">
                  <td className="px-8 py-6 text-brand-muted font-bold text-xs">
                    {formatDate(payment.due_date)}
                  </td>
                  <td className="px-8 py-6 font-black text-brand-text">
                    R$ {Number(payment.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-8 py-6 text-brand-muted text-xs font-bold uppercase">
                    {payment.billing_type || '-'}
                  </td>
                  <td className="px-8 py-6">
                    {payment.status === 'RECEIVED' || payment.status === 'CONFIRMED' ? (
                      <span className="text-emerald-500 font-black text-[10px] uppercase tracking-widest bg-emerald-50 dark:bg-emerald-900/20 px-3 py-1 rounded-full">PAGO</span>
                    ) : payment.status === 'OVERDUE' ? (
                      <span className="text-red-500 font-black text-[10px] uppercase tracking-widest bg-red-50 dark:bg-red-900/20 px-3 py-1 rounded-full">VENCIDO</span>
                    ) : (
                      <span className="text-amber-500 font-black text-[10px] uppercase tracking-widest bg-amber-50 dark:bg-amber-900/20 px-3 py-1 rounded-full">EM ABERTO</span>
                    )}
                  </td>
                  <td className="px-8 py-6 text-right">
                    {(payment.status === 'PENDING' || payment.status === 'OVERDUE') && payment.invoice_url ? (
                      <a
                        href={payment.invoice_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 bg-[#002366] bg-tenant-primary text-white px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest hover:scale-105 transition-transform"
                      >
                        Pagar Agora <ExternalLink size={12} />
                      </a>
                    ) : (payment.status === 'RECEIVED' || payment.status === 'CONFIRMED') ? (
                      <span className="inline-flex items-center gap-2 text-emerald-500 font-bold text-xs">
                        <CheckCircle size={16} /> Pago
                      </span>
                    ) : (
                      <span className="text-slate-300 text-xs">-</span>
                    )}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={5} className="px-10 py-8 text-center text-brand-muted text-sm font-bold">
                    {historyError ? 'Histórico temporariamente indisponível.' : 'Nenhum pagamento registrado no histórico.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default StudentBilling;
