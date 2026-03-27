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
import { User as UserType } from '../types';

interface StudentBillingProps {
  user: UserType;
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
    try {
      const { data: paymentsData, error: paymentsError } = await supabase
        .from('student_payments')
        .select('*')
        .eq('student_id', user.id)
        .order('due_date', { ascending: false });

      if (paymentsError) throw paymentsError;
      setPayments(paymentsData || []);
    } catch (err) {
      console.error('Error fetching payment history:', err);
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    if (user?.id) fetchPaymentHistory();
  }, [user?.id]);

  if (contextLoading || loadingHistory) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
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
    <div className="space-y-8 animate-in fade-in duration-500 pb-20 relative font-sans">
      <header className="bg-gradient-to-r from-tenant-primary to-purple-600 text-white p-8 rounded-[2.5rem] shadow-lg mb-8">
        <h2 className="text-4xl font-black tracking-tighter">Meu Financeiro</h2>
        <p className="text-white/80 text-sm mt-1">Acompanhe seus planos, pagamentos e histórico de mensalidades.</p>
      </header>

      {/* ALERT STATUS CARDS */}

      {/* 1. BLOCKED STATUS (> 7 days late) */}
      {alertStatus === 'BLOCKED' && (
        <div className="bg-slate-900 text-white rounded-2xl p-8 flex items-start gap-6 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 p-12 opacity-10">
            <ShieldCheck size={180} />
          </div>
          <div className="p-4 bg-white/10 rounded-2xl backdrop-blur-sm">
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
              <div className="flex items-center justify-between">
                <span className="text-white font-black text-lg">
                  {oldestOverduePayment && formatDate(oldestOverduePayment.due_date)}
                </span>
                {oldestOverduePayment?.invoice_url && (
                  <a
                    href={oldestOverduePayment.invoice_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-white text-slate-900 px-6 py-2 rounded-lg font-black text-xs uppercase tracking-widest hover:bg-red-50 transition-colors"
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
                <div key={payment.id} className="flex flex-col sm:flex-row items-center justify-between bg-white dark:bg-slate-900 p-4 rounded-xl border border-red-100 dark:border-red-900/50 shadow-sm gap-4">
                  <div>
                    <p className="text-xs font-black text-slate-400 uppercase tracking-widest">
                      Vencimento {formatDate(payment.due_date)}
                    </p>
                    <p className="text-lg font-black text-slate-800 dark:text-white">
                      R$ {Number(payment.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                  {payment.invoice_url && (
                    <a
                      href={payment.invoice_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bg-red-600 text-white px-6 py-2 rounded-lg font-black text-xs uppercase tracking-widest hover:bg-red-700 transition-colors shadow-lg shadow-red-600/20"
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
                <div key={payment.id} className="flex flex-col sm:flex-row items-center justify-between bg-white dark:bg-slate-900 p-4 rounded-xl border border-amber-100 dark:border-amber-900/50 shadow-sm gap-4">
                  <div>
                    <p className="text-xs font-black text-slate-400 uppercase tracking-widest">
                      Vencimento {formatDate(payment.due_date)}
                    </p>
                    <p className="text-lg font-black text-slate-800 dark:text-white">
                      R$ {Number(payment.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                  {payment.invoice_url && (
                    <a
                      href={payment.invoice_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bg-amber-500 text-white px-6 py-2 rounded-lg font-black text-xs uppercase tracking-widest hover:bg-amber-600 transition-colors shadow-lg shadow-amber-500/20"
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
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-8 shadow-xl shadow-slate-200/50 dark:shadow-none relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-500">
            <ShieldCheck size={120} className="text-tenant-primary" />
          </div>

          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-8">
              <div className="p-3 bg-tenant-primary/10 text-tenant-primary rounded-2xl">
                <CreditCard size={24} />
              </div>
              <div>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Status da Assinatura</span>
                <span className={`flex items-center gap-2 font-black text-sm uppercase tracking-wide ${derivedStatus === 'ACTIVE' ? 'text-emerald-500' : 'text-amber-500'}`}>
                  <CheckCircle size={14} /> {derivedStatus === 'ACTIVE' ? 'Ativo & Regular' : derivedStatus || 'Sem Plano'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
              <div>
                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Valor Mensal</h4>
                <div className="flex items-baseline gap-1">
                  <span className="text-lg font-bold text-slate-400">R$</span>
                  <span className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter">
                    {derivedMonthlyFee.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
              <div>
                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Dia de Vencimento</h4>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-slate-500">
                    <Calendar size={18} />
                  </div>
                  <span className="text-xl font-black text-slate-700 dark:text-slate-200 tracking-tight">Dia {derivedDueDay || '??'}</span>
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
        <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white shadow-2xl relative overflow-hidden group">
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

            <button className="w-full py-4 bg-white text-slate-900 rounded-2xl font-black text-xs uppercase tracking-widest hover:scale-105 active:scale-95 transition-all">
              Falar com Suporte
            </button>
          </div>
        </div>

      </div>

      {/* History Table */}
      <div className="bg-white dark:bg-slate-900 rounded-[3rem] border border-slate-100 dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none overflow-hidden">
        <div className="p-8 border-b dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/30">
          <h3 className="font-black text-slate-700 dark:text-slate-200 text-sm uppercase tracking-widest">Histórico de Mensalidades (Todos)</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] text-slate-400 uppercase font-black border-b dark:border-slate-700">
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
                <tr key={payment.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                  <td className="px-8 py-6 text-slate-500 dark:text-slate-400 font-bold text-xs">
                    {formatDate(payment.due_date)}
                  </td>
                  <td className="px-8 py-6 font-black text-slate-800 dark:text-white">
                    R$ {Number(payment.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-8 py-6 text-slate-500 dark:text-slate-400 text-xs font-bold uppercase">
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
                        className="inline-flex items-center gap-2 bg-tenant-primary text-white px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest hover:scale-105 transition-transform"
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
                  <td colSpan={5} className="px-10 py-8 text-center text-slate-400 text-sm font-bold">Nenhum pagamento registrado no histórico.</td>
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
