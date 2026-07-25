import React, { useState } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip } from 'recharts';
import { Target, ToggleLeft, ToggleRight } from 'lucide-react';

interface SkillData {
    subject: string;
    A: number; // Current Month
    B?: number; // Previous Month
    fullMark: number;
}

interface CompetencyRadarChartProps {
    currentData: { subject: string; score: number }[];
    previousData?: { subject: string; score: number }[];
}

const CompetencyRadarChart: React.FC<CompetencyRadarChartProps> = ({ currentData, previousData }) => {
    const [showComparison, setShowComparison] = useState(false);

    // Merge data
    const chartData: SkillData[] = currentData.map((item, index) => ({
        subject: item.subject,
        A: item.score,
        B: previousData ? previousData[index]?.score : 0,
        fullMark: 100
    }));

    const CustomTooltip = ({ active, payload, label }: any) => {
        if (active && payload && payload.length) {
            const current = payload[0].value;
            const previous = payload[1]?.value;
            const diff = previous !== undefined ? current - previous : 0;

            return (
                <div className="bg-brand-surface p-3 rounded-xl shadow-xl border border-brand-border text-xs">
                    <p className="font-black text-brand-text mb-2">{label}</p>
                    <div className="flex flex-col gap-1">
                        <p className="text-tenant-primary font-bold">Atual: {current}%</p>
                        {showComparison && previous !== undefined && (
                            <>
                                <p className="text-brand-muted font-bold">Anterior: {previous}%</p>
                                <p className={`font-black ${diff >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                    {diff >= 0 ? '+' : ''}{diff}%
                                </p>
                            </>
                        )}
                    </div>
                </div>
            );
        }
        return null;
    };

    return (
        <div className="bg-brand-surface p-4 sm:p-8 rounded-[2rem] sm:rounded-[2.5rem] border border-gray-100 dark:border-brand-border shadow-sm flex flex-col h-full min-w-0 overflow-hidden">

            <div className="flex flex-col sm:flex-row justify-between items-start gap-3 mb-5 sm:mb-8 min-w-0">
                <h3 className="text-xs font-black text-gray-800 dark:text-slate-200 uppercase tracking-widest flex items-center gap-2 min-w-0">
                    <Target size={18} className="text-tenant-primary" /> Matriz de Competências
                </h3>

                {previousData && (
                    <button
                        onClick={() => setShowComparison(!showComparison)}
                        className="w-full sm:w-auto flex items-center justify-center sm:justify-start gap-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-tenant-primary transition-colors border border-brand-border sm:border-0 rounded-xl sm:rounded-none px-3 sm:px-0 py-2 sm:py-0"
                    >
                        {showComparison ? <ToggleRight size={24} className="text-tenant-primary" /> : <ToggleLeft size={24} />}
                        Comparar Mês Anterior
                    </button>
                )}
            </div>

            <div className="h-72 sm:h-80 w-full min-w-0 relative z-10">
                <ResponsiveContainer
                    width="100%"
                    height="100%"
                    minWidth={0}
                    minHeight={0}
                    debounce={100}
                    initialDimension={{ width: 480, height: 288 }}
                >
                    <RadarChart cx="50%" cy="50%" outerRadius="62%" data={chartData} margin={{ top: 12, right: 20, bottom: 12, left: 20 }}>
                        <PolarGrid stroke="#e2e8f0" strokeDasharray="3 3" className="dark:opacity-10" />
                        <PolarAngleAxis dataKey="subject" tick={{ fill: '#64748b', fontSize: 10, fontWeight: 'bold' }} />
                        <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />

                        {/* Current Month */}
                        <Radar
                            name="Mês Atual"
                            dataKey="A"
                            stroke="#6366f1" // Indigo-500
                            strokeWidth={3}
                            fill="#6366f1"
                            fillOpacity={0.3}
                        />

                        {/* Previous Month - Comparison */}
                        {showComparison && (
                            <Radar
                                name="Mês Anterior"
                                dataKey="B"
                                stroke="#94a3b8" // Slate-400
                                strokeWidth={2}
                                strokeDasharray="4 4"
                                fill="#94a3b8"
                                fillOpacity={0.1}
                            />
                        )}

                        <Tooltip content={<CustomTooltip />} />
                    </RadarChart>
                </ResponsiveContainer>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3 mt-5 sm:mt-8">
                {chartData.map((s, i) => (
                    <div key={i} className="text-center min-w-0 rounded-xl bg-brand-surface-2/60 p-2 last:col-span-2 sm:last:col-span-1">
                        <p className="text-[9px] font-black text-gray-500 dark:text-slate-400 uppercase leading-tight break-normal">{s.subject}</p>
                        <div className="flex flex-col items-center">
                            <p className="text-sm font-black text-tenant-primary">{s.A}%</p>
                            {showComparison && s.B !== undefined && (
                                <p className={`text-[9px] font-bold ${s.A - s.B >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                    {s.A - s.B >= 0 ? '+' : ''}{s.A - s.B}%
                                </p>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default CompetencyRadarChart;
