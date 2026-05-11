
import React, { useState } from 'react';
import { Users, LayoutGrid, Info } from 'lucide-react';

const DAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const TIMES = Array.from({ length: 14 }, (_, i) => {
  const hour = i + 8;
  return `${hour < 10 ? '0' + hour : hour}:00`;
});

const AvailabilityHeatmap: React.FC = () => {
  const [gridData] = useState(() => 
    Array.from({ length: TIMES.length }, () => 
      Array.from({ length: DAYS.length }, () => {
        const rand = Math.random();
        if (rand < 0.2) return -1; 
        return Math.floor(Math.random() * 6);
      })
    )
  );

  const getColorClass = (value: number) => {
    if (value === -1) return 'bg-gray-800 dark:bg-slate-700 ring-1 ring-white/10';
    if (value === 0) return 'bg-gray-100 dark:bg-slate-800';
    if (value === 1) return 'bg-emerald-50 dark:bg-emerald-950/20';
    if (value === 2) return 'bg-emerald-100 dark:bg-emerald-900/30';
    if (value === 3) return 'bg-emerald-200 dark:bg-emerald-800/40';
    if (value === 4) return 'bg-emerald-400 dark:bg-emerald-600/60';
    return 'bg-emerald-600 dark:bg-emerald-500';
  };

  return (
    <div className="bg-white dark:bg-slate-900 p-4 md:p-8 rounded-[2rem] md:rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-hidden">
      <div className="mb-8 flex flex-col xl:flex-row xl:items-center justify-between gap-6">
        <div>
          <h3 className="font-bold text-gray-800 dark:text-slate-100 flex items-center gap-2 text-lg">
            <LayoutGrid size={20} className="text-tenant-primary" /> 
            Smart Allocation Grid
          </h3>
          <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">Janelas de oportunidade para novos alunos.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 bg-gray-50 dark:bg-slate-800/50 p-3 rounded-2xl border dark:border-slate-700">
            <span className="text-[10px] text-gray-400 dark:text-slate-500 uppercase font-black">Legenda:</span>
            <div className="flex flex-wrap gap-3">
              <div className="flex items-center gap-1.5">
                 <div className="w-3 h-3 rounded-sm bg-gray-800 dark:bg-slate-600" />
                 <span className="text-[9px] text-gray-500 dark:text-slate-400 font-bold">PICO</span>
              </div>
              <div className="flex items-center gap-1.5">
                 <div className="w-3 h-3 rounded-sm bg-gray-100 dark:bg-slate-800" />
                 <span className="text-[9px] text-gray-500 dark:text-slate-400 font-bold">SEM VAGA</span>
              </div>
              <div className="flex items-center gap-1.5">
                 <div className="w-3 h-3 rounded-sm bg-emerald-500" />
                 <span className="text-[9px] text-gray-500 dark:text-slate-400 font-bold">LIVRE</span>
              </div>
            </div>
        </div>
      </div>

      <div className="overflow-x-auto -mx-4 px-4 scrollbar-hide">
        <table className="w-full border-separate border-spacing-1 min-w-[600px]">
          <thead>
            <tr>
              <th className="p-2 text-[10px] text-gray-400 dark:text-slate-500 font-black uppercase w-16">Hora</th>
              {DAYS.map(day => (
                <th key={day} className="p-2 text-[10px] text-gray-500 dark:text-slate-400 font-black uppercase tracking-widest">{day}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TIMES.map((time, rowIdx) => (
              <tr key={time}>
                <td className="p-2 text-[10px] text-gray-400 dark:text-slate-500 text-center font-bold">{time}</td>
                {gridData[rowIdx].map((val, colIdx) => (
                  <td key={colIdx} className="relative group">
                    <div 
                      className={`h-10 w-full rounded-lg ${getColorClass(val)} transition-all duration-300 group-hover:scale-105 cursor-pointer shadow-sm`}
                    />
                    {val > 3 && (
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
                         <Users size={14} className="text-white" />
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 flex items-start gap-3 p-4 bg-blue-50/50 dark:bg-blue-900/10 rounded-2xl border border-blue-100/50 dark:border-blue-900/20">
        <Info size={18} className="text-blue-500 shrink-0" />
        <p className="text-[10px] text-blue-700 dark:text-blue-400 font-medium leading-relaxed">
          O sistema sugere alocações automáticas priorizando blocos em <b>Verde Escuro</b> para otimizar o faturamento.
        </p>
      </div>
    </div>
  );
};

export default AvailabilityHeatmap;
