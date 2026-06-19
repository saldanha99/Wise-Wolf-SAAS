import React, { useState, useEffect } from 'react';
import { Activity, TrendingUp, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Props {
    userId: string;
}

const SKILLS = [
    { id: 'speaking', label: 'Speaking', color: '#ec4899' },
    { id: 'pronunciation', label: 'Pronúncia', color: '#a855f7' },
    { id: 'listening', label: 'Listening', color: '#3b82f6' },
    { id: 'reading', label: 'Reading', color: '#06b6d4' },
    { id: 'writing', label: 'Writing', color: '#10b981' },
    { id: 'grammar', label: 'Grammar', color: '#f59e0b' },
    { id: 'vocabulary', label: 'Vocabulary', color: '#ef4444' },
];

const SkillsRadar: React.FC<Props> = ({ userId }) => {
    const [loading, setLoading] = useState(true);
    const [scores, setScores] = useState<Record<string, number>>({});
    const [totals, setTotals] = useState<Record<string, number>>({});
    const [pronAvg, setPronAvg] = useState<number | null>(null);

    useEffect(() => {
        if (userId) load();
    }, [userId]);

    const load = async () => {
        setLoading(true);
        try {
            // 1. Skill scores agregados (learning paths)
            const { data: skillsData } = await supabase
                .from('student_skill_scores')
                .select('skill, current_score, total_activities')
                .eq('student_id', userId);

            const scoreMap: Record<string, number> = {};
            const totalMap: Record<string, number> = {};
            (skillsData || []).forEach(s => {
                scoreMap[s.skill] = Number(s.current_score) || 0;
                totalMap[s.skill] = s.total_activities || 0;
            });

            // 2. Pronuncia: media dos ultimos scores das sessoes do Wolfie
            // (wolfie_corrections nao guarda score, mas se quisermos olhamos em wolfie_sessions ou wolfie_turns futuramente)
            // Por agora a pronuncia ja eh atualizada via student_skill_scores quando o aluno faz speaking_wolfie

            setScores(scoreMap);
            setTotals(totalMap);
            setPronAvg(scoreMap.pronunciation ?? null);
        } catch (err) {
            console.error('Skills load error:', err);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-12 flex flex-col items-center justify-center">
                <Loader2 className="animate-spin text-violet-500" size={24} />
            </div>
        );
    }

    const hasAnyData = Object.values(scores).some((s: number) => s > 0);

    // ── SVG geometry ──
    const size = 280;
    const center = size / 2;
    const maxRadius = 100;
    const levels = 5; // 5 rings (20/40/60/80/100)
    const angleStep = (Math.PI * 2) / SKILLS.length;

    // Polygon points for current scores
    const points = SKILLS.map((skill, i) => {
        const value = scores[skill.id] || 0;
        const r = (value / 100) * maxRadius;
        const angle = i * angleStep - Math.PI / 2; // start at top
        const x = center + r * Math.cos(angle);
        const y = center + r * Math.sin(angle);
        return `${x},${y}`;
    }).join(' ');

    // Average score
    const allScores = Object.values(scores).filter((s: number) => s > 0) as number[];
    const avgScore = allScores.length > 0 ? Math.round(allScores.reduce((a: number, b: number) => a + b, 0) / allScores.length) : 0;

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-pink-100 dark:bg-pink-900/30 rounded-xl flex items-center justify-center">
                        <Activity size={20} className="text-pink-600 dark:text-pink-400" />
                    </div>
                    <div>
                        <h3 className="font-black text-slate-800 dark:text-white text-sm">Mapa de Skills</h3>
                        <p className="text-[10px] text-slate-400 uppercase tracking-widest">Sua evolução por habilidade</p>
                    </div>
                </div>
                {hasAnyData && (
                    <div className="text-right">
                        <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Média geral</p>
                        <p className="text-2xl font-black text-violet-600 dark:text-violet-400">{avgScore}<span className="text-sm text-slate-400">/100</span></p>
                    </div>
                )}
            </div>

            <div className="p-6">
                {!hasAnyData ? (
                    <div className="text-center py-12 text-slate-400">
                        <TrendingUp size={32} className="mx-auto mb-3 opacity-40" />
                        <p className="text-sm font-bold">Sem dados ainda</p>
                        <p className="text-xs mt-1">Complete atividades das trilhas para ver sua evolução por skill.</p>
                    </div>
                ) : (
                    <div className="flex flex-col lg:flex-row items-center gap-8">
                        {/* SVG Radar */}
                        <div className="shrink-0 relative">
                            <svg viewBox={`-20 -10 ${size + 40} ${size + 20}`} className="w-full max-w-[280px] h-auto">
                                {/* Background rings */}
                                {Array.from({ length: levels }).map((_, lvl) => {
                                    const r = ((lvl + 1) / levels) * maxRadius;
                                    const ringPoints = SKILLS.map((_, i) => {
                                        const angle = i * angleStep - Math.PI / 2;
                                        const x = center + r * Math.cos(angle);
                                        const y = center + r * Math.sin(angle);
                                        return `${x},${y}`;
                                    }).join(' ');
                                    return (
                                        <polygon
                                            key={lvl}
                                            points={ringPoints}
                                            fill="none"
                                            stroke="currentColor"
                                            className="text-slate-200 dark:text-slate-700"
                                            strokeWidth={lvl === levels - 1 ? 1.5 : 0.5}
                                        />
                                    );
                                })}

                                {/* Axis lines */}
                                {SKILLS.map((_, i) => {
                                    const angle = i * angleStep - Math.PI / 2;
                                    const x2 = center + maxRadius * Math.cos(angle);
                                    const y2 = center + maxRadius * Math.sin(angle);
                                    return (
                                        <line
                                            key={i}
                                            x1={center} y1={center}
                                            x2={x2} y2={y2}
                                            stroke="currentColor"
                                            className="text-slate-200 dark:text-slate-700"
                                            strokeWidth={0.5}
                                        />
                                    );
                                })}

                                {/* Score polygon */}
                                <polygon
                                    points={points}
                                    fill="url(#radarGradient)"
                                    fillOpacity={0.4}
                                    stroke="#a855f7"
                                    strokeWidth={2}
                                />
                                <defs>
                                    <radialGradient id="radarGradient">
                                        <stop offset="0%" stopColor="#ec4899" />
                                        <stop offset="100%" stopColor="#a855f7" />
                                    </radialGradient>
                                </defs>

                                {/* Score dots */}
                                {SKILLS.map((skill, i) => {
                                    const value = scores[skill.id] || 0;
                                    const r = (value / 100) * maxRadius;
                                    const angle = i * angleStep - Math.PI / 2;
                                    const x = center + r * Math.cos(angle);
                                    const y = center + r * Math.sin(angle);
                                    return <circle key={skill.id} cx={x} cy={y} r={3.5} fill={skill.color} />;
                                })}

                                {/* Labels */}
                                {SKILLS.map((skill, i) => {
                                    const angle = i * angleStep - Math.PI / 2;
                                    const labelR = maxRadius + 16;
                                    const x = center + labelR * Math.cos(angle);
                                    const y = center + labelR * Math.sin(angle);
                                    return (
                                        <text
                                            key={skill.id}
                                            x={x} y={y}
                                            textAnchor="middle"
                                            dominantBaseline="middle"
                                            className="text-[9px] font-bold fill-slate-500 dark:fill-slate-400 uppercase tracking-widest"
                                        >
                                            {skill.label}
                                        </text>
                                    );
                                })}
                            </svg>
                        </div>

                        {/* Score breakdown */}
                        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2 w-full">
                            {SKILLS.map(skill => {
                                const value = Math.round(scores[skill.id] || 0);
                                const total = totals[skill.id] || 0;
                                const hasData = total > 0;
                                return (
                                    <div key={skill.id} className="flex items-center gap-3 p-2 rounded-xl bg-slate-50 dark:bg-slate-800/50">
                                        <div className="w-2 h-10 rounded-full" style={{ background: hasData ? skill.color : '#cbd5e1' }} />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-black text-slate-800 dark:text-white">{skill.label}</p>
                                            <p className="text-[10px] text-slate-400">{hasData ? `${total} atividade${total > 1 ? 's' : ''}` : 'Sem dados'}</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-lg font-black" style={{ color: hasData ? skill.color : '#94a3b8' }}>{value}</p>
                                            <p className="text-[9px] text-slate-400">/100</p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SkillsRadar;
