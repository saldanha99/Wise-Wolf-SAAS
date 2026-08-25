
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
import { localMonth } from '../lib/dateUtils';
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
  const [selectedMonth, setSelectedMonth] = useState(localMonth());

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

      // 2. Teacher Payroll — hourly_rate via RPC (coluna não é mais legível direto em profiles)
      const { data: teachersData } = await supabase.rpc('get_tenant_teacher_pay');

      const teacherRates = new Map((teachersData as any[] || []).map((t: any) => [t.id, t.hourly_rate || 0]));

      const { data: logs } = await supabase
        .from('class_logs')
        .select('teacher_id, presence, subtype')
        .eq('tenant_id', tenantId)
        .gte('created_at', startDateStr)
        .lt('created_at', endDateStr);

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
      const { data: studentBilling } = await supabase.rpc(
        'get_authorized_student_billing_summary',
        { p_tenant_id: tenantId },
      );
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
          <h2 className="text-3xl font-[family-name:var(--font-display)] font-extrabold text-brand-text tracking-tight flex items-center gap-3">
            <DollarSign className="text-brand-accent drop-shadow-[0_0_8px_rgba(var(--brand-accent),0.6)]" size={32} /> Financeiro Unidade
          </h2>
          <p className="text-brand-muted text-sm font-medium">Gestão consolidada de receitas e repasses a professores.</p>
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
                Líquido Real: R$ {netBalance.toLocaleString('pt-BR')}
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
              <h4 className="font-black text-brand-text uppercase tracking-widest text-[10px]">Conciliação Bancária</h4>
            </div>
            <div className="space-y-1">
              <p className="text-3xl font-[family-name:var(--font-display)] font-black text-brand-text tracking-tight">R$ {netBalance.toLocaleString('pt-BR')}</p>
              <p className="text-[10px] text-brand-muted font-bold uppercase">Saldo em Conta Asaas</p>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-brand-border/50">
            <button
              className="w-full py-4 bg-brand-surface-2 text-brand-text rounded-2xl text-[10px] font-black uppercase tracking-widest border border-transparent hover:border-brand-accent hover:text-brand-accent transition-all shadow-sm flex items-center justify-center gap-2"
            >
              Solicitar Saque (Cash-out) <ArrowUpRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[
          { label: 'Professores', value: stats.activeTeachers, icon: <Users size={20} />, color: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20' },
          { label: 'Alunos Ativos', value: stats.activeStudents, icon: <Target size={20} />, color: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' },
          { label: 'Custo Folha', value: `R$ ${stats.totalCosts.toLocaleString('pt-BR')}`, icon: <DollarSign size={20} />, color: 'bg-rose-500/10 text-rose-500 border-rose-500/20' },
          { label: 'Pendentes', value: stats.pendingPayouts, icon: <RefreshCw size={20} />, color: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
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
              <p className="text-[10px] text-brand-muted font-bold mt-1 uppercase tracking-tighter">Últimos pagamentos de alunos ({selectedMonth})</p>
            </div>

            {/* Botão legado 'Corrigir Lançamentos' removido em 03/07/2026: criava linhas sem vínculo/data no caixa; o trigger + reconcile-ledger cobrem a conciliação. */}
          </div>
          <div className="overflow-y-auto max-h-[400px] custom-scrollbar">
            <table className="w-full">
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
                        <span className="text-[9px] font-black text-brand-muted uppercase tracking-tighter">Mensalidade</span>
                      </div>
                    </td>
                    <td className="px-8 py-5">
                      {receipt.isPaid ? (
                        <span className="text-[10px] font-black bg-emerald-500/10 text-emerald-500 border border-emerald-500/30 px-3 py-1 rounded-full uppercase shadow-sm">
                          Recebido {receipt.date}
                        </span>
                      ) : receipt.status === 'OVERDUE' ? (
                        <span className="text-[10px] font-black bg-rose-500/10 text-rose-500 border border-rose-500/30 px-3 py-1 rounded-full uppercase shadow-sm">
                          Atrasado {receipt.date}
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-black bg-amber-500/10 text-amber-500 px-3 py-1 rounded-full uppercase border border-amber-500/30 shadow-sm">
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

                                // O lançamento no caixa é criado pelo trigger ledger_on_payment_received
                                // (dispara no update de status acima). Insert manual removido em 03/07/2026.
                              } catch (err: any) {
                                alert('Erro: ' + err.message);
                              }
                              fetchFinancialData(); // Refresh
                            }}
                            className="p-1 text-emerald-500 hover:bg-emerald-500/20 rounded-full transition-colors"
                            title="Confirmar Pagamento Manual"
                          >
                            <CheckCircle size={14} />
                          </button>
                        </div>
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
              <p className="text-[10px] text-brand-muted font-bold mt-1 uppercase tracking-tighter">Custos operacionais de aula</p>
            </div>
            <button className="p-2 bg-brand-surface-2 border border-brand-border rounded-lg text-brand-muted hover:border-brand-accent hover:text-brand-accent transition-all text-[10px] font-black uppercase tracking-widest flex items-center gap-2 px-4 shadow-sm">
              Audit <FileText size={16} className="text-brand-accent" />
            </button>
          </div>
          <div className="overflow-y-auto max-h-[400px] custom-scrollbar">
            <table className="w-full">
              <thead className="bg-brand-surface-2 text-[10px] uppercase font-black text-brand-muted border-b border-brand-border">
                <tr>
                  <th className="px-8 py-4 text-left">Professor</th>
                  <th className="px-8 py-4 text-left">Aulas</th>
                  <th className="px-8 py-4 text-left">Fatura</th>
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
                      {teacher.status === 'PAID' ? (
                        <span className="text-[10px] font-black bg-emerald-500/10 text-emerald-500 border border-emerald-500/30 px-3 py-1 rounded-full uppercase shadow-sm">Pago</span>
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

                              // 2. Update Closing (schema unificado — month_year + status PAGO)
                              const { error: cErr } = await supabase.from('teacher_closings')
                                .update({ status: 'PAGO', paid_at: new Date().toISOString() })
                                .eq('teacher_id', teacher.id)
                                .eq('month_year', selectedMonth);

                              if (cErr) throw cErr;

                              alert('Pagamento registrado!');
                              fetchFinancialData();
                            } catch (e: any) {
                              alert('Erro: ' + e.message);
                            }
                          }}
                          className="text-[10px] font-black bg-brand-accent text-white px-3 py-1 rounded-full uppercase hover:bg-brand-accent-hover transition-colors shadow-[0_0_10px_rgba(var(--brand-accent),0.4)]"
                        >
                          Pagar
                        </button>
                      ) : (
                        <span className="text-[10px] font-black text-brand-muted uppercase">
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
