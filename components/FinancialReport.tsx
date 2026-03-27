
import React, { useState, useEffect } from 'react';
import {
  DollarSign,
  CheckCircle,
  FileText,
  Target,
  TrendingUp,
  RefreshCw,
  Users,
  Download,
  Wallet,
  ArrowUpRight,
  ChevronRight
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { UserRole, PresenceStatus } from '../types';

interface FinancialReportProps {
  role?: string;
  tenantId?: string;
}

const FinancialReport: React.FC<FinancialReportProps> = ({ role, tenantId }) => {
  const isAdmin = role === 'SCHOOL_ADMIN';
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalRevenue: 0,
    totalCosts: 0,
    forecastRevenue: 0,
    activeStudents: 0,
    activeTeachers: 0,
    pendingPayouts: 0
  });
  const [teachersFinancials, setTeachersFinancials] = useState<any[]>([]);
  const [studentReceipts, setStudentReceipts] = useState<any[]>([]);
  const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().substring(0, 7));

  const fetchFinancialData = async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const startOfMonth = `${selectedMonth}-01`;
      const startDate = new Date(`${startOfMonth}T00:00:00`);
      const nextMonth = new Date(startDate);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      const endDateStr = nextMonth.toISOString();
      const startDateStr = startDate.toISOString();

      // 1. REAL Revenue from FINANCIAL TRANSACTIONS (Official Ledger) - Matches Dashboard
      const { data: transactions } = await supabase
        .from('financial_transactions')
        .select('*')
        .eq('tenant_id', tenantId)
        .gte('created_at', startDateStr)
        .lt('created_at', endDateStr);

      const totalRevenue = (transactions || [])
        .filter(t => t.type === 'ENTRADA')
        .reduce((acc, t) => acc + (Number(t.amount) || Number(t.amount_cents) / 100 || 0), 0);

      const totalCostsFromTrans = (transactions || [])
        .filter(t => t.type === 'SAIDA')
        .reduce((acc, t) => acc + (Number(t.amount) || Number(t.amount_cents) / 100 || 0), 0);

      // 2. Teacher Payroll (Estimated from Class Logs) - Matches Dashboard logic
      const { data: teachersData } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url, hourly_rate')
        .eq('tenant_id', tenantId)
        .eq('role', 'TEACHER');

      const teacherRates = new Map(teachersData?.map((t: any) => [t.id, t.hourly_rate || 0]));

      const { data: logs } = await supabase
        .from('class_logs')
        .select('teacher_id, presence')
        .eq('tenant_id', tenantId)
        .gte('created_at', startDateStr)
        .lt('created_at', endDateStr);

      // Calculate Payroll per Teacher
      const teacherStats = new Map<string, { lessons: number, owed: number }>();

      let estimatedPayroll = 0;
      logs?.forEach((log: any) => {
        const rate = teacherRates.get(log.teacher_id) || 0;
        const current = teacherStats.get(log.teacher_id) || { lessons: 0, owed: 0 };

        // Logic from Dashboard: "Presente" counts as lesson, but "Falta do Professor" doesn't pay
        // Actually, usually we pay if it's NOT "Falta do Professor" (e.g. Presente, Falta Aluno)
        // Dashboard logic: 
        // if (log.presence === 'Presente') attendanceCount++;
        // if (log.presence !== 'Falta do Professor') payroll += rate;

        let shouldPay = log.presence !== 'Falta do Professor';
        if (shouldPay) {
          estimatedPayroll += rate;
          current.owed += rate;
        }
        if (log.presence === 'Presente') {
          current.lessons++;
        }
        teacherStats.set(log.teacher_id, current);
      });

      // 3. Student Receivables (List)
      const { data: payments } = await supabase
        .from('student_payments')
        .select(`
          id, value, amount_cents, status, due_date, payment_date,
          profiles!inner (id, full_name, tenant_id)
        `)
        .eq('profiles.tenant_id', tenantId)
        .gte('due_date', startDateStr)
        .lt('due_date', endDateStr)
        .order('due_date', { ascending: true });

      // 4. Forecast (Active Students)
      const { count: activeStudentCount, data: studentsFee } = await supabase
        .from('profiles')
        .select('monthly_fee', { count: 'exact' })
        .eq('tenant_id', tenantId)
        .eq('role', 'STUDENT')
        .eq('status_financial', 'ACTIVE');

      const forecast = (studentsFee || []).reduce((acc, s) => acc + (Number(s.monthly_fee) || 0), 0);

      // Set State
      setStats({
        totalRevenue: totalRevenue,
        totalCosts: estimatedPayroll, // Use Estimated for "Custo Folha" to match Dashboard
        forecastRevenue: forecast,
        activeStudents: activeStudentCount || 0,
        activeTeachers: teachersData?.length || 0,
        pendingPayouts: 0 // TODO: Check actual payouts if needed, or just use 0 for now
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
          status: 'PENDING' // Default to pending as we are calculating from logs
        };
      });
      setTeachersFinancials(mappedTeachers);

      // UI Mapping for Receipts
      const mappedReceipts = (payments || []).map((p: any) => ({
        id: p.id,
        name: p.profiles?.full_name,
        amount: (p.amount_cents ? p.amount_cents / 100 : p.value),
        status: p.status,
        date: new Date(p.due_date).toLocaleDateString('pt-BR'),
        isPaid: p.status === 'RECEIVED' || p.status === 'CONFIRMED',
        student_id: p.profiles?.id,
        tenant_id: p.profiles?.tenant_id
      }));
      setStudentReceipts(mappedReceipts);

    } catch (error) {
      console.error('Error fetching admin financial data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFinancialData();
  }, [tenantId, selectedMonth]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <RefreshCw className="animate-spin text-tenant-primary" size={32} />
      </div>
    );
  }

  const netBalance = stats.totalRevenue - stats.totalCosts;

  return (
    <div className="space-y-8 animate-in fade-in duration-700">
      {/* Header & Month Picker */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">Financeiro Unidade</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm">Gestão consolidada de receitas e repasses a professores.</p>
        </div>
        <div className="flex bg-white dark:bg-slate-900 p-1.5 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="bg-transparent text-sm font-bold text-slate-700 dark:text-slate-200 px-4 py-2 outline-none"
          />
        </div>
      </header>

      {/* Main Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-slate-900 p-10 rounded-[2.5rem] border border-slate-800 shadow-2xl relative overflow-hidden flex flex-col justify-between group">
          <div className="absolute -right-20 -top-20 w-80 h-80 bg-tenant-primary/10 blur-[100px] rounded-full group-hover:bg-tenant-primary/20 transition-all duration-1000" />

          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-emerald-500/20 text-emerald-400 rounded-xl"><TrendingUp size={18} /></div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Faturamento Total</p>
            </div>
            <div className="flex flex-col md:flex-row md:items-end gap-6 md:gap-12">
              <div>
                <p className="text-[10px] font-black text-emerald-400 uppercase tracking-widest mb-1">Realizado (Pago)</p>
                <h3 className="text-5xl font-black text-white tracking-tighter">
                  R$ {stats.totalRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </h3>
              </div>

              <div className="md:border-l md:border-slate-800 md:pl-12">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Previsão (Contratado)</p>
                <h3 className="text-4xl font-black text-slate-400 tracking-tighter">
                  R$ {stats.forecastRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </h3>
              </div>

            </div>
            <div className="mt-4 flex gap-4">
              <span className="text-[10px] font-black bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full uppercase tracking-widest border border-emerald-500/30">
                Líquido Real: R$ {netBalance.toLocaleString('pt-BR')}
              </span>
            </div>
          </div>

          <div className="mt-12 space-y-4 relative z-10">
            <div className="flex justify-between items-end">
              <div className="flex items-center gap-2 text-slate-400">
                <Target size={14} />
                <span className="text-[10px] font-black uppercase tracking-widest">Meta de MRR</span>
              </div>
              <span className="text-xs font-black text-white">R$ {stats.totalRevenue.toFixed(0)} / R$ 30.000</span>
            </div>
            <div className="w-full h-3 bg-slate-800 rounded-full border border-slate-700 p-0.5 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-tenant-primary to-blue-400 rounded-full transition-all duration-1000"
                style={{ width: `${(stats.totalRevenue / 30000) * 100}%` }}
              />
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 flex flex-col justify-between shadow-sm relative overflow-hidden">
          <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-blue-50 dark:bg-blue-900/10 rounded-full blur-3xl" />

          <div>
            <div className="flex items-center gap-2 mb-4">
              <Wallet size={18} className="text-tenant-primary" />
              <h4 className="font-black text-slate-800 dark:text-slate-100 uppercase tracking-widest text-[10px]">Conciliação Bancária</h4>
            </div>
            <div className="space-y-1">
              <p className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">R$ {netBalance.toLocaleString('pt-BR')}</p>
              <p className="text-[10px] text-slate-400 font-bold uppercase">Saldo em Conta Asaas</p>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-50 dark:border-slate-800">
            <button
              className="w-full py-4 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-tenant-primary hover:text-white transition-all shadow-sm flex items-center justify-center gap-2"
            >
              Solicitar Saque (Cash-out) <ArrowUpRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[
          { label: 'Professores', value: stats.activeTeachers, icon: <Users size={20} />, color: 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' },
          { label: 'Alunos Ativos', value: stats.activeStudents, icon: <Target size={20} />, color: 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600' },
          { label: 'Custo Folha', value: `R$ ${stats.totalCosts.toLocaleString('pt-BR')}`, icon: <DollarSign size={20} />, color: 'bg-rose-50 dark:bg-rose-900/20 text-rose-600' },
          { label: 'Pendentes', value: stats.pendingPayouts, icon: <RefreshCw size={20} />, color: 'bg-amber-50 dark:bg-amber-900/20 text-amber-600' },
        ].map((stat, i) => (
          <div key={i} className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
            <div className={`p-3 rounded-2xl ${stat.color}`}>{stat.icon}</div>
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{stat.label}</p>
              <p className="text-lg font-black text-slate-800 dark:text-white">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Student Receipts List */}
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm flex flex-col">
          <div className="p-8 border-b dark:border-slate-800 flex justify-between items-center">
            <div>
              <h3 className="font-black text-slate-800 dark:text-white text-xs uppercase tracking-widest">Fluxo de Recebimentos</h3>
              <p className="text-[10px] text-slate-400 font-bold mt-1 uppercase tracking-tighter">Últimos pagamentos de alunos ({selectedMonth})</p>
            </div>

            <button
              onClick={async () => {
                if (!confirm("Isso irá verificar e criar transações financeiras para pagamentos manuais que não foram registrados no caixa. Deseja continuar?")) return;
                setLoading(true);
                try {
                  // 1. Get all RECEIVED payments from this month
                  const startOfMonth = `${selectedMonth}-01T00:00:00Z`;
                  const nextMonth = new Date(selectedMonth);
                  nextMonth.setMonth(nextMonth.getMonth() + 1);
                  const endOfMonth = nextMonth.toISOString();

                  const { data: payments } = await supabase
                    .from('student_payments')
                    .select('id, value, payment_date, student_id, status, profiles(full_name, tenant_id)')
                    .eq('profiles.tenant_id', tenantId)
                    .eq('status', 'RECEIVED')
                    .gte('payment_date', startOfMonth)
                    .lt('payment_date', endOfMonth);

                  // 2. Get all Transactions
                  const { data: transactions } = await supabase
                    .from('financial_transactions')
                    .select('reference_id, amount')
                    .eq('tenant_id', tenantId)
                    .gte('created_at', startOfMonth)
                    .lt('created_at', endOfMonth);

                  let fixedCount = 0;
                  for (const p of (payments || [])) {
                    // Check if exists
                    const exists = transactions?.some(t =>
                      t.reference_id === p.student_id &&
                      Math.abs(t.amount - p.value) < 1.0 // Tolerance
                    );

                    if (!exists) {
                      // Create it
                      await supabase.from('financial_transactions').insert({
                        tenant_id: p.profiles?.tenant_id,
                        type: 'ENTRADA',
                        category: 'MENSALIDADE',
                        amount: p.value,
                        description: `Mensalidade (Manual Recuperado) - ${p.profiles?.full_name}`,
                        reference_id: p.student_id,
                        created_at: p.payment_date || new Date().toISOString()
                      });
                      fixedCount++;
                    }
                  }
                  alert(`Correção concluída! ${fixedCount} registros recuperados.`);
                  fetchFinancialData();

                } catch (err: any) {
                  alert("Erro ao corrigir: " + err.message);
                } finally {
                  setLoading(false);
                }
              }}
              className="p-2 bg-slate-50 dark:bg-slate-800 rounded-lg text-slate-400 hover:text-emerald-500 transition-colors ml-2"
              title="Corrigir Lançamentos de Caixa"
            >
              <RefreshCw size={18} />
            </button>
          </div>
          <div className="overflow-y-auto max-h-[400px] scrollbar-hide">
            <table className="w-full">
              <thead className="bg-slate-50/50 dark:bg-slate-800/50 text-[10px] uppercase font-black text-slate-400">
                <tr>
                  <th className="px-8 py-4 text-left">Aluno</th>
                  <th className="px-8 py-4 text-left font-black">Lançamento</th>
                  <th className="px-8 py-4 text-right">Valor Bruto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                {studentReceipts.map(receipt => (
                  <tr key={receipt.id} className="hover:bg-slate-50/30 dark:hover:bg-slate-800/30 transition-colors group">
                    <td className="px-8 py-5">
                      <div className="flex flex-col">
                        <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{receipt.name}</span>
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">Mensalidade</span>
                      </div>
                    </td>
                    <td className="px-8 py-5">
                      {receipt.isPaid ? (
                        <span className="text-[10px] font-black bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 px-3 py-1 rounded-full uppercase">
                          Recebido {receipt.date}
                        </span>
                      ) : receipt.status === 'OVERDUE' ? (
                        <span className="text-[10px] font-black bg-rose-50 dark:bg-rose-500/10 text-rose-600 px-3 py-1 rounded-full uppercase">
                          Atrasado {receipt.date}
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-black bg-amber-50 dark:bg-amber-500/10 text-amber-600 px-3 py-1 rounded-full uppercase border border-amber-100 dark:border-amber-900/50">
                            Fatura Aberta
                          </span>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!confirm(`Confirmar recebimento manual de R$ ${receipt.amount.toLocaleString('pt-BR')}?`)) return;
                              try {
                                // 1. Update Payment Status
                                const { error: updateError } = await supabase
                                  .from('student_payments')
                                  .update({
                                    status: 'RECEIVED',
                                    payment_date: new Date().toISOString()
                                  })
                                  .eq('id', receipt.id);

                                if (updateError) throw updateError;

                                // 2. Create Financial Transaction
                                const { error: transError } = await supabase
                                  .from('financial_transactions')
                                  .insert({
                                    tenant_id: receipt.tenant_id,
                                    type: 'ENTRADA',
                                    category: 'MENSALIDADE',
                                    amount: receipt.amount,
                                    description: `Mensalidade (Manual) - ${receipt.name}`,
                                    reference_id: receipt.student_id,
                                    created_at: new Date().toISOString()
                                  });

                                if (transError) console.error("Erro ao criar transação:", transError);
                              } catch (err: any) {
                                alert('Erro: ' + err.message);
                              }
                              fetchFinancialData(); // Refresh
                            }}
                            className="p-1 text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-full transition-colors"
                            title="Confirmar Pagamento Manual"
                          >
                            <CheckCircle size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-8 py-5 text-right font-black text-slate-800 dark:text-slate-100">
                      R$ {receipt.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Teacher Payouts List */}
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm flex flex-col">
          <div className="p-8 border-b dark:border-slate-800 flex justify-between items-center">
            <div>
              <h3 className="font-black text-slate-800 dark:text-white text-xs uppercase tracking-widest">Repasse Professores</h3>
              <p className="text-[10px] text-slate-400 font-bold mt-1 uppercase tracking-tighter">Custos operacionais de aula</p>
            </div>
            <button className="p-2 bg-slate-50 dark:bg-slate-800 rounded-lg text-slate-400 hover:text-tenant-primary transition-colors text-[10px] font-black uppercase tracking-widest flex items-center gap-2 px-4">
              Audit <FileText size={16} />
            </button>
          </div>
          <div className="overflow-y-auto max-h-[400px] scrollbar-hide">
            <table className="w-full">
              <thead className="bg-slate-50/50 dark:bg-slate-800/50 text-[10px] uppercase font-black text-slate-400">
                <tr>
                  <th className="px-8 py-4 text-left">Professor</th>
                  <th className="px-8 py-4 text-left">Aulas</th>
                  <th className="px-8 py-4 text-left">Fatura</th>
                  <th className="px-8 py-4 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                {teachersFinancials.map(teacher => (
                  <tr key={teacher.id} className="hover:bg-slate-50/30 dark:hover:bg-slate-800/30 transition-colors group">
                    <td className="px-8 py-5">
                      <div className="flex items-center gap-3">
                        <img src={teacher.avatar_url || `https://ui-avatars.com/api/?name=${teacher.full_name}`} className="w-8 h-8 rounded-lg" />
                        <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{teacher.full_name}</span>
                      </div>
                    </td>
                    <td className="px-8 py-5 text-xs font-black text-slate-400 uppercase tracking-widest">
                      {teacher.paidCount} Aulas
                    </td>
                    <td className="px-8 py-5 text-xs font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">
                      R$ {teacher.totalOwed.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-8 py-5 text-right">
                      {teacher.status === 'PAID' ? (
                        <span className="text-[10px] font-black bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 px-3 py-1 rounded-full uppercase">Pago</span>
                      ) : teacher.status === 'CONFIRMED_TEACHER' ? (
                        <button
                          onClick={async () => {
                            if (!confirm(`Confirmar pagamento de R$ ${teacher.totalOwed} para ${teacher.full_name}?`)) return;
                            try {
                              // 1. Create Transaction (Exit)
                              const { error: tErr } = await supabase.from('financial_transactions').insert({
                                tenant_id: tenantId,
                                type: 'SAIDA',
                                category: 'teacher_payout',
                                amount_cents: Math.round(teacher.totalOwed * 100),
                                description: `Pagamento Professor - ${teacher.full_name}`,
                                reference_id: teacher.id
                              });
                              if (tErr) throw tErr;

                              // 2. Update Closing
                              const { error: cErr } = await supabase.from('teacher_closings')
                                .update({ status: 'PAID', paid_at: new Date().toISOString() })
                                .eq('teacher_id', teacher.id)
                                .eq('period_start', `${selectedMonth}-01`);

                              if (cErr) throw cErr;

                              alert('Pagamento registrado!');
                              fetchFinancialData();
                            } catch (e: any) {
                              alert('Erro: ' + e.message);
                            }
                          }}
                          className="text-[10px] font-black bg-blue-500 text-white px-3 py-1 rounded-full uppercase hover:bg-blue-600 transition-colors shadow-lg shadow-blue-500/20"
                        >
                          Pagar
                        </button>
                      ) : (
                        <span className="text-[10px] font-black text-slate-400 uppercase">
                          {teacher.status || 'Pendente'}
                        </span>
                      )}
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
