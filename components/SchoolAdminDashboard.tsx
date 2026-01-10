import React, { useState } from 'react';
import { Users, BookOpen, Clock, Zap, ArrowUpRight, TrendingDown, Target, Award, AlertCircle, Search, MoreHorizontal, UserCheck, Calendar, RefreshCw, FileDown, UserPlus, MoreVertical } from 'lucide-react';
import AvailabilityHeatmap from './AvailabilityHeatmap';

import { Teacher } from '../types';

interface SchoolAdminDashboardProps {
  teachers: Teacher[];
  onViewTeacherSchedule?: (teacherName: string, action?: 'view' | 'allocate') => void;
}

const SchoolAdminDashboard: React.FC<SchoolAdminDashboardProps> = ({ teachers, onViewTeacherSchedule }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [isNotifying, setIsNotifying] = useState(false);

  // Filter teachers logic
  const filteredTeachers = teachers.filter(t =>
    t.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleExport = () => {
    setIsExporting(true);
    setTimeout(() => {
      setIsExporting(false);
      alert("Relatórios consolidados da unidade exportados com sucesso!");
    }, 1500);
  };

  const handleNotifyTeacher = (name: string) => {
    setIsNotifying(true);
    setTimeout(() => {
      setIsNotifying(false);
      alert(`O professor responsável por ${name} recebeu um alerta de intervenção imediata.`);
    }, 1200);
  };

  return (
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-500 font-sans">
      {/* Header Section */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 dark:text-white">Analytics da Unidade</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Monitoramento de hierarquias: Professores e Alunos.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            disabled={isExporting}
            className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all shadow-sm flex items-center gap-2 disabled:opacity-50"
          >
            {isExporting ? <RefreshCw className="animate-spin" size={14} /> : <FileDown size={14} />}
            {isExporting ? 'Exportando...' : 'Exportar Dados'}
          </button>
        </div>
      </header>

      {/* Stats Grid - "Glass/Clean" Style */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { label: 'Receita Recorrente', value: 'R$ 143,624', sub: 'Calculado sobre faturamento', icon: Zap, iconBg: 'bg-emerald-100 text-emerald-600' },
          { label: 'Inadimplência', value: '12', sub: 'Alunos em atraso', icon: TrendingDown, iconBg: 'bg-slate-100 text-slate-600' },
          { label: 'Ticket Médio', value: 'R$ 7.00', sub: 'Por aluno ativo', icon: Target, iconBg: 'bg-blue-100 text-blue-600' },
          { label: 'Folha Pagamento', value: 'R$ 3,287.49', sub: 'Total acumulado no mês', icon: Award, iconBg: 'bg-purple-100 text-purple-600' },
        ].map((stat, i) => (
          <div key={i} className="bg-white dark:bg-slate-900 p-6 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800 relative group transition-all hover:-translate-y-1 hover:shadow-lg">
            <div className="flex justify-between items-start mb-4">
              <div className={`p-3 rounded-2xl ${stat.iconBg} dark:bg-opacity-20`}>
                <stat.icon size={24} strokeWidth={1.5} />
              </div>
              <button className="text-slate-300 hover:text-slate-500 transition-colors">
                <MoreVertical size={20} />
              </button>
            </div>
            <h3 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">{stat.value}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">{stat.label}</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{stat.sub}</p>
          </div>
        ))}
      </div>

      {/* Main Content Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2/3) */}
        <div className="lg:col-span-2 space-y-6">

          {/* Main Chart Section - Mimicking "Average Sales" */}
          <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Fluxo Financeiro</h3>
                <p className="text-sm text-slate-500">Visão geral de todas as receitas</p>
              </div>
              <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 rounded-full px-4 py-2">
                <Calendar size={14} className="text-slate-500" />
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Mês Atual</span>
                <ArrowUpRight size={14} className="text-slate-500 ml-1" />
              </div>
            </div>

            <div className="flex items-center gap-8 mb-8">
              <div>
                <p className="text-xs text-slate-500 mb-1">Presencial</p>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold text-slate-900 dark:text-white">R$ 12.201,00</span>
                  <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">-11%</span>
                </div>
              </div>
              <div>
                <p className="text-xs text-slate-500 mb-1">Online</p>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold text-slate-900 dark:text-white">R$ 100.799,00</span>
                  <span className="bg-green-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">+6%</span>
                </div>
              </div>
            </div>

            {/* Existing Heatmap Logic Injected Here */}
            <div className="w-full">
              <AvailabilityHeatmap />
            </div>
          </div>

          {/* List Section - Mimicking "Recent Emails" / Staff List */}
          <div className="bg-white dark:bg-slate-900 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800 overflow-hidden">
            <div className="p-8 flex flex-col md:flex-row justify-between items-center gap-4">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">Performance da Equipe</h3>
              <div className="relative w-full md:w-64">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                <input
                  type="text"
                  placeholder="Buscar equipe..."
                  className="w-full pl-11 pr-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-purple-100 transition-all placeholder:text-slate-400"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-400 font-semibold border-b border-slate-100 dark:border-slate-800">
                  <tr>
                    <th className="px-8 py-4 font-medium">Professor</th>
                    <th className="px-8 py-4 font-medium">Status</th>
                    <th className="px-8 py-4 font-medium">Retenção</th>
                    <th className="px-8 py-4 font-medium">TPI</th>
                    <th className="px-8 py-4 text-right font-medium">Ação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                  {filteredTeachers.map((prof, i) => (
                    <tr key={i} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors group">
                      <td className="px-8 py-5">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-100 to-blue-100 dark:from-slate-700 dark:to-slate-600 flex items-center justify-center text-slate-600 dark:text-slate-200 font-bold text-xs">
                            {prof.avatar ? <img src={prof.avatar} className="w-full h-full rounded-full object-cover" /> : prof.name.split(' ').map(n => n[0]).join('')}
                          </div>
                          <div>
                            <p className="font-bold text-slate-800 dark:text-slate-200">{prof.name}</p>
                            <p className="text-xs text-slate-500">{prof.module}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-8 py-5">
                        <span className="px-3 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-xs font-bold">
                          {prof.studentsCount} Alunos Ativos
                        </span>
                      </td>
                      <td className="px-8 py-5 text-slate-600 dark:text-slate-300 font-semibold">
                        {prof.retention}
                      </td>
                      <td className="px-8 py-5">
                        <div className="w-24 h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full bg-purple-500" style={{ width: `${prof.tpi}%` }} />
                        </div>
                      </td>
                      <td className="px-8 py-5 text-right">
                        <button
                          onClick={() => onViewTeacherSchedule?.(prof.name, 'view')}
                          className="text-sm font-semibold text-purple-600 hover:text-purple-700 hover:bg-purple-50 px-3 py-1 rounded-lg transition-all"
                        >
                          Ver
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column (1/3) */}
        <div className="space-y-6">

          {/* Status Widget - Mimicking "Formation status" */}
          <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Status da Formação</h3>
                <p className="text-sm text-slate-500">Em andamento</p>
              </div>
              <button className="p-2 rounded-full bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-slate-600">
                <ArrowUpRight size={16} />
              </button>
            </div>

            <div className="w-full h-4 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mb-2">
              <div className="h-full w-2/3 bg-gradient-to-r from-purple-400 to-purple-500 rounded-full shadow-[0_0_15px_rgba(168,85,247,0.4)]" />
            </div>

            <div className="mt-8 mb-8">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">Conclusão Estimada</h3>
              <p className="text-sm text-slate-500">4-5 Dias Úteis</p>
            </div>

            <button className="w-full py-4 rounded-2xl bg-white border-2 border-slate-100 dark:border-slate-700 dark:bg-slate-800 text-slate-900 dark:text-white font-bold text-sm hover:shadow-md transition-all">
              Ver detalhes
            </button>
          </div>

          {/* Success Rate Widget */}
          <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
            <div className="flex justify-between items-start mb-2">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Taxa de Sucesso</h3>
                <p className="text-sm text-slate-500">Indice de aprovação geral</p>
              </div>
              <button className="p-2 rounded-full bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-slate-600">
                <ArrowUpRight size={16} />
              </button>
            </div>

            <div className="flex flex-col items-center justify-center my-8 relative">
              {/* Simplified Radial Chart Representation */}
              <div className="w-40 h-40 relative flex items-center justify-center">
                <svg className="w-full h-full -rotate-90">
                  <circle cx="80" cy="80" r="70" stroke="currentColor" strokeWidth="12" fill="transparent" className="text-slate-100 dark:text-slate-800" strokeLinecap="round" />
                  <circle cx="80" cy="80" r="70" stroke="currentColor" strokeWidth="12" fill="transparent" strokeDasharray="440" strokeDashoffset="200" className="text-purple-500" strokeLinecap="round" />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-3xl font-bold text-slate-900 dark:text-white">51.2%</span>
                  <span className="text-xs font-semibold text-green-500">+5%</span>
                </div>
              </div>
            </div>

            <p className="text-center text-sm text-slate-500 mb-6">
              Parabéns! Você atingiu todas as metas financeiras da semana.
            </p>

            <div className="flex justify-between items-center text-center">
              <div>
                <p className="text-xs text-slate-400 mb-1">Leads</p>
                <p className="text-xl font-bold text-slate-900 dark:text-white">15.110</p>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">Matrículas</p>
                <p className="text-xl font-bold text-slate-900 dark:text-white">91.130</p>
              </div>
            </div>

          </div>

          {/* Real-Time Monitor - Redesigned */}
          <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  Monitoramento ao Vivo
                </h3>
                <p className="text-sm text-slate-500">Status das salas de aula</p>
              </div>
              <div className="flex items-center gap-2 px-3 py-1 bg-emerald-50 dark:bg-emerald-900/20 rounded-full">
                <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
                <span className="text-xs font-bold text-emerald-600">AO VIVO</span>
              </div>
            </div>

            <div className="space-y-4">
              {teachers.slice(0, 3).map((t, i) => (
                <div key={i} className="group flex items-center justify-between p-4 rounded-2xl bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-xs font-bold text-purple-600 shadow-sm">
                      {i + 1}
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{t.name}</p>
                      <p className="text-xs text-slate-500">12:30 PM - 01:30 PM</p>
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-slate-400 group-hover:text-purple-500">Ver</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SchoolAdminDashboard;
