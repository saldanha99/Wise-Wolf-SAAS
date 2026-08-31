
import React, { useState, useEffect, useRef } from 'react';
import {
  DollarSign,
  Target,
  TrendingUp,
  RefreshCw,
  Users,
  Wallet,
  AlertTriangle
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatLocalDateBr, localMonth, monthRange } from '../lib/dateUtils';
import { isSettledStudentPayment, isStudentPaymentAwaitingCredit } from '../lib/studentPaymentStatus';

interface FinancialReportProps {
  role?: string;
  tenantId?: string;
}

const FinancialReport: React.FC<FinancialReportProps> = ({ tenantId }) => {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalRevenue: 0,
    totalCosts: 0,
    forecastRevenue: 0,
    activeStudents: 0,
    activeTeachers: 0
  });
  const [teachersFinancials, setTeachersFinancials] = useState<any[]>([]);
  const [studentReceipts, setStudentReceipts] = useState<any[]>([]);
  const [selectedMonth, setSelectedMonth] = useState(localMonth());
  const [errorMessage, setErrorMessage] = useState('');
  const requestSequence = useRef(0);

  const fetchFinancialData = async () => {
    const sequence = ++requestSequence.current;
    if (!tenantId) {
      setLoading(false);
      setErrorMessage('Escola não identificada.');
      return;
    }
    setLoading(true);
    setErrorMessage('');
    setTeachersFinancials([]);
    setStudentReceipts([]);
    try {
      const { start: monthStart, endExclusive: nextMonthStart } = monthRange(selectedMonth);
      const startDateStr = new Date(`${monthStart}T00:00:00`).toISOString();
      const endDateStr = new Date(`${nextMonthStart}T00:00:00`).toISOString();

      // 1. REAL Revenue from FINANCIAL TRANSACTIONS (Official Ledger) - Matches Dashboard
      const { data: transactions, error: transactionsError } = await supabase
        .from('financial_transactions')
        .select('*')
        .eq('tenant_id', tenantId)
        .gte('occurred_at', startDateStr)
        .lt('occurred_at', endDateStr);
      if (transactionsError) throw transactionsError;

      const totalRevenue = (transactions || [])
        .filter(t => t.type === 'ENTRADA')
        .reduce((acc, t) => acc + (Number(t.amount) || Number(t.amount_cents) / 100 || 0), 0);

      // 2. Teacher Payroll — hourly_rate via RPC (coluna não é mais legível direto em profiles)
      const { data: teachersData, error: teachersError } = await supabase.rpc('get_tenant_teacher_pay');
      if (teachersError) throw teachersError;

      const teacherRates = new Map((teachersData as any[] || []).map((t: any) => [t.id, t.hourly_rate || 0]));

      const { data: logs, error: logsError } = await supabase
        .from('class_logs')
        .select('teacher_id, presence, subtype')
        .eq('tenant_id', tenantId)
        .gte('class_date', monthStart)
        .lt('class_date', nextMonthStart);
      if (logsError) throw logsError;

      // Calculate Payroll per Teacher
      const teacherStats = new Map<string, { lessons: number, owed: number }>();

      let estimatedPayroll = 0;
      logs?.forEach((log: any) => {
        const rate = teacherRates.get(log.teacher_id) || 0;
        const current = teacherStats.get(log.teacher_id) || { lessons: 0, owed: 0 };

        // Regra canônica de pagamento (idêntica a isLessonPaid / FinancialClosingModal):
        // não paga falta do professor, reposição (de aluno) nem teste oral.
        // Enums reais são em inglês (TEACHER_ABSENCE), não 'Falta do Professor'.
        const isTeacherAbsence = log.presence === 'TEACHER_ABSENCE' || log.presence === 'Falta do Professor';
        const isReplacement = log.subtype === 'REPOSIÇÃO';
        const isOralTest = log.subtype === 'Teste Oral';
        const shouldPay = !isTeacherAbsence && !isReplacement && !isOralTest;
        if (shouldPay) {
          estimatedPayroll += rate;
          current.owed += rate;
          current.lessons++;
        }
        teacherStats.set(log.teacher_id, current);
      });

      // 3. Student Receivables (List)
      const { data: payments, error: paymentsError } = await supabase
        .from('student_payments')
        .select(`
          id, student_id, tenant_id, value, amount_cents, status, due_date, payment_date,
          profiles (id, full_name, tenant_id)
        `)
        .eq('tenant_id', tenantId)
        .gte('due_date', monthStart)
        .lt('due_date', nextMonthStart)
        .order('due_date', { ascending: true });
      if (paymentsError) throw paymentsError;

      // 4. Forecast (Active Students)
      const { data: studentBilling, error: studentBillingError } = await supabase.rpc(
        'get_authorized_student_billing_summary',
        { p_tenant_id: tenantId },
      );
      if (studentBillingError) throw studentBillingError;
      if (sequence !== requestSequence.current) return;
      const studentsFee = (studentBilling || []).filter(
        (student: any) => student.status_financial === 'ACTIVE',
      );
      const activeStudentCount = studentsFee.length;

      const forecast = (studentsFee || []).reduce((acc, s) => acc + (Number(s.monthly_fee) || 0), 0);

      // Set State
      setStats({
        totalRevenue: totalRevenue,
        totalCosts: estimatedPayroll, // Use Estimated for "Custo Folha" to match Dashboard
        forecastRevenue: forecast,
        activeStudents: activeStudentCount || 0,
        activeTeachers: teachersData?.length || 0
      });

      // UI Mapping for Teachers (Combined Static Data + Dynamic Logs)
      const mappedTeachers = (teachersData || []).map((t: any) => {
        const stat = teacherStats.get(t.id) || { lessons: 0, owed: 0 };
        return {
          id: t.id,
          full_name: t.full_name,
          avatar_url: t.avatar_url,
          paidCount: stat.lessons,
          totalOwed: stat.owed,
          status: 'ESTIMATE'
        };
      });
      setTeachersFinancials(mappedTeachers);

      // UI Mapping for Receipts
      const mappedReceipts = (payments || []).map((p: any) => ({
        id: p.id,
        name: p.profiles?.full_name || 'Sem aluno vinculado',
        amount: (p.amount_cents ? p.amount_cents / 100 : p.value),
        status: p.status,
        dueDate: formatLocalDateBr(p.due_date),
        paymentDate: formatLocalDateBr(p.payment_date, 'data não informada'),
        isPaid: isSettledStudentPayment(p.status),
        isAwaitingCredit: isStudentPaymentAwaitingCredit(p.status),
        isUnlinked: !p.student_id,
        student_id: p.student_id || p.profiles?.id,
        tenant_id: p.tenant_id
      }));
      setStudentReceipts(mappedReceipts);

    } catch (error) {
      console.error('Error fetching admin financial data:', error);
      if (sequence === requestSequence.current) {
        setErrorMessage('Não foi possível carregar o financeiro. Os valores não foram zerados; tente novamente.');
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchFinancialData();
    return () => { requestSequence.current += 1; };
  }, [tenantId, selectedMonth]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <RefreshCw className="animate-spin text-tenant-primary" size={32} />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div role="alert" className="flex min-h-[260px] flex-col items-center justify-center gap-4 rounded-3xl border border-red-500/40 bg-red-500/5 p-8 text-center">
        <AlertTriangle className="text-red-500" size={28} />
        <p className="max-w-lg text-sm font-bold text-brand-text">{errorMessage}</p>
        <button type="button" onClick={fetchFinancialData} className="rounded-xl border border-brand-border bg-brand-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">
          Tentar novamente
        </button>
      </div>
    );
  }

  // Este número não consulta saldo bancário: é somente receita realizada menos
  // a folha reconstruída nesta tela. O nome explicita essa limitação para não
  // induzir decisão de saque ou conciliação com um valor estimado.
  const estimatedMarginAfterPayroll = stats.totalRevenue - stats.totalCosts;

  return (
    <div className="space-y-8 animate-in fade-in duration-700">
      {/* Header & Month Picker */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-3xl font-[family-name:var(--font-display)] font-extrabold text-brand-text tracking-tight flex items-center gap-3">
            <DollarSign className="text-brand-accent drop-shadow-[0_0_8px_rgba(var(--brand-accent),0.6)]" size={32} /> Financeiro Unidade
          </h2>
          <p className="text-brand-muted text-sm font-medium">Receitas realizadas e estimativas operacionais de repasse.</p>
        </div>
        <div className="flex bg-brand-surface p-1.5 rounded-2xl border border-brand-border shadow-sm">
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="bg-transparent text-sm font-bold text-brand-text px-4 py-2 outline-none"
          />
        </div>
      </header>

      {/* Main Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-brand-surface-2 p-10 rounded-[2.5rem] border border-brand-border shadow-[0_8px_30px_rgba(0,0,0,0.12)] relative overflow-hidden flex flex-col justify-between group">
          <div className="absolute -right-20 -top-20 w-80 h-80 bg-brand-accent/20 blur-[100px] rounded-full group-hover:bg-brand-accent/30 transition-all duration-1000" />

          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-emerald-500/20 text-emerald-400 rounded-xl border border-emerald-500/30"><TrendingUp size={18} /></div>
              <p className="text-[10px] font-black text-brand-muted uppercase tracking-[0.2em]">Faturamento Total</p>
            </div>
            <div className="flex flex-col md:flex-row md:items-end gap-6 md:gap-12">
              <div>
                <p className="text-[10px] font-black text-emerald-400 uppercase tracking-widest mb-1">Realizado (Pago)</p>
                <h3 className="text-5xl font-[family-name:var(--font-display)] font-extrabold text-brand-text tracking-tighter">
                  R$ {stats.totalRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </h3>
              </div>

              <div className="md:border-l md:border-brand-border md:pl-12">
                <p className="text-[10px] font-black text-brand-muted uppercase tracking-widest mb-1">Previsão (Contratado)</p>
                <h3 className="text-4xl font-[family-name:var(--font-display)] font-bold text-brand-muted/70 tracking-tighter">
                  R$ {stats.forecastRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </h3>
              </div>

            </div>
            <div className="mt-4 flex gap-4">
              <span className="text-[10px] font-black bg-emerald-500/10 text-emerald-500 px-3 py-1 rounded-full uppercase tracking-widest border border-emerald-500/30 shadow-sm">
                Margem após folha estimada: R$ {estimatedMarginAfterPayroll.toLocaleString('pt-BR')}
              </span>
            </div>
          </div>

          <div className="mt-12 space-y-4 relative z-10">
            <div className="flex justify-between items-end">
              <div className="flex items-center gap-2 text-brand-muted">
                <Target size={14} className="text-brand-accent" />
                <span className="text-[10px] font-black uppercase tracking-widest">Meta de MRR</span>
              </div>
              <span className="text-xs font-black text-brand-text">R$ {stats.totalRevenue.toFixed(0)} / R$ 30.000</span>
            </div>
            <div className="w-full h-3 bg-brand-bg rounded-full border border-brand-border/50 p-0.5 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-brand-accent to-indigo-500 rounded-full transition-all duration-1000 shadow-[0_0_10px_rgba(var(--brand-accent),0.5)]"
                style={{ width: `${(stats.totalRevenue / 30000) * 100}%` }}
              />
            </div>
          </div>
        </div>

        <div className="bg-brand-surface p-8 rounded-[2.5rem] border border-brand-border flex flex-col justify-between shadow-sm relative overflow-hidden hover:border-blue-500/30 transition-colors group">
          <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-blue-500/10 rounded-full blur-3xl group-hover:bg-blue-500/20 transition-all duration-700" />

          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className="p-2 bg-blue-500/10 rounded-xl border border-blue-500/20">
                <Wallet size={18} className="text-blue-500 drop-shadow-[0_0_8px_rgba(59,130,246,0.6)]" />
              </div>
              <h4 className="font-black text-brand-text uppercase tracking-widest text-[10px]">Resultado operacional estimado</h4>
            </div>
            <div className="space-y-1">
              <p className="text-3xl font-[family-name:var(--font-display)] font-black text-brand-text tracking-tight">R$ {estimatedMarginAfterPayroll.toLocaleString('pt-BR')}</p>
              <p className="text-[10px] text-brand-muted font-bold uppercase">Receita realizada menos folha estimada</p>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-brand-border/50">
            <p className="rounded-2xl bg-brand-surface-2 px-4 py-3 text-[10px] font-bold uppercase leading-relaxed tracking-widest text-brand-muted">
              Não representa saldo bancário nem saldo disponível no Asaas.
            </p>
          </div>
        </div>
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[
          { label: 'Professores', value: stats.activeTeachers, icon: <Users size={20} />, color: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20' },
          { label: 'Alunos Ativos', value: stats.activeStudents, icon: <Target size={20} />, color: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' },
          { label: 'Folha estimada', value: `R$ ${stats.totalCosts.toLocaleString('pt-BR')}`, icon: <DollarSign size={20} />, color: 'bg-rose-500/10 text-rose-500 border-rose-500/20' },
        ].map((stat, i) => (
          <div key={i} className="bg-brand-surface p-6 rounded-[2rem] border border-brand-border shadow-sm flex items-center gap-4 hover:bg-brand-surface-2 transition-colors">
            <div className={`p-3 rounded-2xl border ${stat.color}`}>{stat.icon}</div>
            <div>
              <p className="text-[10px] font-black text-brand-muted uppercase tracking-widest">{stat.label}</p>
              <p className="text-lg font-[family-name:var(--font-display)] font-extrabold text-brand-text">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Student Receipts List */}
        <div className="bg-brand-surface rounded-[2.5rem] border border-brand-border overflow-hidden shadow-sm flex flex-col">
          <div className="p-8 border-b border-brand-border flex justify-between items-center bg-brand-surface-2/50">
            <div>
              <h3 className="font-black text-brand-text text-xs uppercase tracking-widest">Fluxo de Recebimentos</h3>
              <p className="text-[10px] text-brand-muted font-bold mt-1 uppercase tracking-tighter">Baixas conciliadas pelo Asaas ({selectedMonth})</p>
            </div>

            {/* Botão legado 'Corrigir Lançamentos' removido em 03/07/2026: criava linhas sem vínculo/data no caixa; o trigger + reconcile-ledger cobrem a conciliação. */}
          </div>
          <div className="max-h-[400px] overflow-auto custom-scrollbar">
            <table className="w-full min-w-[600px]">
              <thead className="bg-brand-surface-2 text-[10px] uppercase font-black text-brand-muted border-b border-brand-border">
                <tr>
                  <th className="px-8 py-4 text-left">Aluno</th>
                  <th className="px-8 py-4 text-left font-black">Lançamento</th>
                  <th className="px-8 py-4 text-right">Valor Bruto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border bg-brand-bg/30">
                {studentReceipts.map(receipt => (
                  <tr key={receipt.id} className="hover:bg-brand-surface-2 transition-colors group">
                    <td className="px-8 py-5">
                      <div className="flex flex-col">
                        <span className="text-sm font-bold text-brand-text">{receipt.name}</span>
                        <span className="text-[9px] font-black text-brand-muted uppercase tracking-tighter">
                          {receipt.isUnlinked ? 'Movimentação sem classificação' : 'Mensalidade'}
                        </span>
                      </div>
                    </td>
                    <td className="px-8 py-5">
                      {receipt.isPaid ? (
                        <span className="text-[10px] font-black bg-emerald-500/10 text-emerald-500 border border-emerald-500/30 px-3 py-1 rounded-full uppercase shadow-sm">
                          Recebido {receipt.paymentDate}
                        </span>
                      ) : receipt.isAwaitingCredit ? (
                        <span className="text-[10px] font-black bg-sky-500/10 text-sky-600 border border-sky-500/30 px-3 py-1 rounded-full uppercase shadow-sm">
                          Confirmado · aguardando crédito
                        </span>
                      ) : receipt.status === 'OVERDUE' ? (
                        <span className="text-[10px] font-black bg-rose-500/10 text-rose-500 border border-rose-500/30 px-3 py-1 rounded-full uppercase shadow-sm">
                          Atrasado {receipt.dueDate}
                        </span>
                      ) : (
                        <span className="text-[10px] font-black bg-amber-500/10 text-amber-600 px-3 py-1 rounded-full uppercase border border-amber-500/30 shadow-sm">
                          {receipt.status === 'PENDING' ? 'Fatura aberta' : `Status: ${String(receipt.status || 'indisponível').replaceAll('_', ' ')}`}
                        </span>
                      )}
                    </td>
                    <td className="px-8 py-5 text-right font-[family-name:var(--font-display)] font-extrabold text-brand-text">
                      R$ {receipt.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Teacher Payouts List */}
        <div className="bg-brand-surface rounded-[2.5rem] border border-brand-border overflow-hidden shadow-sm flex flex-col">
          <div className="p-8 border-b border-brand-border flex justify-between items-center bg-brand-surface-2/50">
            <div>
              <h3 className="font-black text-brand-text text-xs uppercase tracking-widest">Repasse Professores</h3>
              <p className="text-[10px] text-brand-muted font-bold mt-1 uppercase tracking-tighter">Estimativa local; confirme o valor no fechamento oficial</p>
            </div>
            <span className="rounded-lg border border-brand-border bg-brand-surface-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">
              Somente estimativa
            </span>
          </div>
          <div className="max-h-[400px] overflow-auto custom-scrollbar">
            <table className="w-full min-w-[600px]">
              <thead className="bg-brand-surface-2 text-[10px] uppercase font-black text-brand-muted border-b border-brand-border">
                <tr>
                  <th className="px-8 py-4 text-left">Professor</th>
                  <th className="px-8 py-4 text-left">Aulas</th>
                  <th className="px-8 py-4 text-left">Valor estimado</th>
                  <th className="px-8 py-4 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border bg-brand-bg/30">
                {teachersFinancials.map(teacher => (
                  <tr key={teacher.id} className="hover:bg-brand-surface-2 transition-colors group">
                    <td className="px-8 py-5">
                      <div className="flex items-center gap-3">
                        <img src={teacher.avatar_url || `https://ui-avatars.com/api/?name=${teacher.full_name}`} className="w-8 h-8 rounded-lg shadow-sm border border-brand-border" />
                        <span className="text-sm font-bold text-brand-text">{teacher.full_name}</span>
                      </div>
                    </td>
                    <td className="px-8 py-5 text-xs font-black text-brand-muted uppercase tracking-widest">
                      {teacher.paidCount} Aulas
                    </td>
                    <td className="px-8 py-5 text-xs font-black text-brand-accent uppercase tracking-widest">
                      R$ {teacher.totalOwed.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-8 py-5 text-right">
                      <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-[10px] font-black uppercase text-blue-600 shadow-sm">
                        {teacher.status === 'ESTIMATE' ? 'Estimativa' : 'Indisponível'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FinancialReport;
