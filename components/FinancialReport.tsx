
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
      const startOfMonth = `${selectedMonth}-01T00:00:00Z`;
      const nextMonth = new Date(selectedMonth);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      const endOfMonth = nextMonth.toISOString();

      // 1. Fetch Students for Revenue
      const { data: students } = await supabase
        .from('profiles')
        .select('id, full_name, monthly_fee, created_at')
        .eq('tenant_id', tenantId)
        .eq('role', 'STUDENT');

      // 2. Fetch Teachers for Costs
      const { data: teachers } = await supabase
        .from('profiles')
        .select('id, full_name, hourly_rate, avatar_url')
        .eq('tenant_id', tenantId)
        .eq('role', 'TEACHER');

      // 3. Fetch Class Logs for calculating teacher pay
      const { data: logs } = await supabase
        .from('class_logs')
        .select('teacher_id, presence, subtype')
        .eq('tenant_id', tenantId)
        .gte('created_at', startOfMonth)
        .lt('created_at', endOfMonth);

      // 4. Fetch Closings
      const { data: closings } = await supabase
        .from('teacher_closings')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('month_year', selectedMonth);

      // Calculations
      const revenue = (students || []).reduce((acc, s) => acc + (s.monthly_fee || 0), 0);

      const teachersProcessed = (teachers || []).map(teacher => {
        const teacherLogs = (logs || []).filter(l => l.teacher_id === teacher.id);
        const paidCount = teacherLogs.filter(l =>
          l.presence !== 'Falta do Professor' && l.subtype !== 'REPOSIÇÃO'
        ).length;

        const rate = teacher.hourly_rate || 7.50;
        const totalOwed = paidCount * rate;

        const closing = (closings || []).find(c => c.teacher_id === teacher.id);

        return {
          ...teacher,
          totalOwed,
          paidCount,
          status: closing?.status || 'PENDENTE'
        };
      });

      const costs = teachersProcessed.reduce((acc, t) => acc + t.totalOwed, 0);

      setStats({
        totalRevenue: revenue,
        totalCosts: costs,
        activeStudents: (students || []).length,
        activeTeachers: (teachers || []).length,
        pendingPayouts: teachersProcessed.filter(t => t.status !== 'PAGO').length
      });

      setTeachersFinancials(teachersProcessed);
      setStudentReceipts((students || []).map(s => ({
        id: s.id,
        name: s.full_name,
        amount: s.monthly_fee || 0,
        status: 'PAGO', // Placeholder
        date: '10/' + selectedMonth.split('-')[1]
      })));

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
            <div className="flex flex-col md:flex-row md:items-end gap-2 md:gap-4">
              <h3 className="text-6xl font-black text-white tracking-tighter">
                R$ {stats.totalRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
              </h3>
              <div className="mb-2">
                <span className="text-[10px] font-black bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full uppercase tracking-widest border border-emerald-500/30">Líquido: R$ {netBalance.toLocaleString('pt-BR')}</span>
              </div>
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
            <button className="p-2 bg-slate-50 dark:bg-slate-800 rounded-lg text-slate-400 hover:text-tenant-primary transition-colors">
              <Download size={18} />
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
                      <span className="text-[10px] font-black bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 px-3 py-1 rounded-full uppercase">Recebido {receipt.date}</span>
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
                  <th className="px-8 py-4 text-right">Total Owed</th>
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
                    <td className="px-8 py-5 text-right font-black text-indigo-600 dark:text-indigo-400">
                      R$ {teacher.totalOwed.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-4 bg-slate-50 dark:bg-slate-800/50 text-center">
            <button className="text-[10px] font-black text-tenant-primary uppercase tracking-widest flex items-center gap-2 mx-auto hover:underline">
              Gerenciar Aprovações <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FinancialReport;
