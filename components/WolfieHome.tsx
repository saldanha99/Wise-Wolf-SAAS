import React, { useState } from 'react';
import { User, Target, Play, Mic, Coffee, Briefcase, Plane, Zap } from 'lucide-react';
import WolfieLiveCallV2 from './WolfieLiveCallV2';

interface WolfieHomeProps {
    user: any;
    wolfieSettings: any;
}

const AVATARS = [
    {
        id: 'sam',
        name: 'Sam',
        role: 'Friendly Buddy',
        accent: 'US English',
        desc: 'Ideal para bate-papo casual, séries e dia a dia.',
        color: 'from-blue-500 to-cyan-500',
        image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Sam&backgroundColor=b6e3f4'
    },
    {
        id: 'rachel',
        name: 'Rachel',
        role: 'Business Mentor',
        accent: 'UK English',
        desc: 'Focada em reuniões, e-mails e negociações.',
        color: 'from-purple-500 to-pink-500',
        image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Rachel&backgroundColor=c0aede'
    },
    {
        id: 'liam',
        name: 'Liam',
        role: 'Immigration Officer',
        accent: 'US English',
        desc: 'Rigoroso. Treine para sua viagem internacional.',
        color: 'from-slate-600 to-slate-800',
        image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Liam&backgroundColor=e2e8f0'
    },
    {
        id: 'maya',
        name: 'Maya',
        role: 'Tech Interviewer',
        accent: 'US English',
        desc: 'Simulações de entrevistas para vagas na gringa.',
        color: 'from-emerald-500 to-teal-500',
        image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Maya&backgroundColor=bcf0da'
    }
];

const MISSIONS = [
    {
        id: 'freestyle_chat',
        title: 'Freestyle Chat',
        desc: 'Converse livremente sobre qualquer coisa.',
        icon: Coffee,
        level: 'All Levels',
        color: 'text-blue-400 bg-blue-400/10'
    },
    {
        id: 'airport_survival',
        title: 'Airport Survival',
        desc: 'Passe pela imigração e alfândega sem suar.',
        icon: Plane,
        level: 'A1 - B1',
        color: 'text-indigo-400 bg-indigo-400/10'
    },
    {
        id: 'tech_job_interview',
        title: 'Tech Job Interview',
        desc: 'Responda perguntas difíceis sobre sua carreira.',
        icon: Briefcase,
        level: 'B1 - C2',
        color: 'text-purple-400 bg-purple-400/10'
    },
    {
        id: 'grammar_workout',
        title: 'Grammar Workout',
        desc: 'Foque 100% em preposições e tempos verbais.',
        icon: Target,
        level: 'A2 - B2',
        color: 'text-emerald-400 bg-emerald-400/10'
    }
];

export const WolfieHome: React.FC<WolfieHomeProps> = ({ user, wolfieSettings }) => {
    const [selectedAvatar, setSelectedAvatar] = useState(AVATARS[0].id);
    const [isLive, setIsLive] = useState(false);
    const [selectedMission, setSelectedMission] = useState(MISSIONS[0].id);

    if (isLive) {
        return (
            <WolfieLiveCallV2
                user={user}
                wolfieConfig={wolfieSettings}
                avatarId={selectedAvatar}
                scenarioId={selectedMission}
                onClose={() => setIsLive(false)}
            />
        );
    }

    const currentAvatar = AVATARS.find(a => a.id === selectedAvatar)!;

    return (
        <div className="w-full flex justify-center py-6 md:py-10 px-4">
            <div className="w-full max-w-5xl animate-in fade-in zoom-in-95 duration-500">

                {/* Hub Header */}
                <div className="mb-10 text-center md:text-left flex flex-col md:flex-row md:items-end justify-between gap-6">
                    <div>
                        <h1 className="text-3xl md:text-5xl font-black text-white tracking-tight mb-2">Wolfie Tutor</h1>
                        <p className="text-slate-400 text-lg font-medium">Practice real conversations with your AI coach.</p>
                    </div>

                    {/* User Stats/Config Badge */}
                    <div className="inline-flex items-center gap-4 px-5 py-2.5 rounded-full bg-slate-900 border border-white/10 shadow-lg">
                        <div className="flex items-center gap-2">
                            <Target className="w-4 h-4 text-indigo-400" />
                            <span className="text-sm font-bold text-slate-200 uppercase tracking-widest">{wolfieSettings?.goal || 'Fluency'}</span>
                        </div>
                        <div className="w-px h-4 bg-slate-700"></div>
                        <div className="flex items-center gap-2">
                            <User className="w-4 h-4 text-emerald-400" />
                            <span className="text-sm font-bold text-slate-200 uppercase tracking-widest">Lvl {wolfieSettings?.level || 'A1'}</span>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

                    {/* AVATAR SELECTION (Left / Top) */}
                    <div className="lg:col-span-8 space-y-8">
                        <div>
                            <div className="flex items-center justify-between mb-4">
                                <h2 className="text-xl font-bold text-white">Choose a Partner</h2>
                                <span className="text-sm font-medium text-slate-500 uppercase tracking-wider">{AVATARS.length} Available</span>
                            </div>

                            {/* Horizontal Scroll / Grid */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                {AVATARS.map(avatar => (
                                    <button
                                        key={avatar.id}
                                        onClick={() => setSelectedAvatar(avatar.id)}
                                        className={`relative flex flex-col items-center p-4 rounded-3xl border transition-all duration-300 ${selectedAvatar === avatar.id
                                                ? 'bg-slate-900 border-indigo-500 shadow-[0_10px_30px_rgba(99,102,241,0.2)] scale-105 z-10'
                                                : 'bg-slate-900/50 border-white/5 hover:bg-slate-800 scale-100 hover:scale-[1.02]'
                                            }`}
                                    >
                                        <div className={`w-20 h-20 rounded-full bg-gradient-to-br ${avatar.color} p-[2px] mb-3`}>
                                            <div className="w-full h-full bg-slate-900 rounded-full overflow-hidden">
                                                <img src={avatar.image} alt={avatar.name} className="w-full h-full object-cover" />
                                            </div>
                                        </div>
                                        <h3 className="text-white font-bold text-base">{avatar.name}</h3>
                                        <div className="bg-slate-800 px-2 py-0.5 rounded text-[10px] font-bold text-slate-300 uppercase tracking-wider mt-1">{avatar.accent}</div>

                                        {selectedAvatar === avatar.id && (
                                            <div className="absolute -top-2 -right-2 w-6 h-6 bg-indigo-500 rounded-full border-4 border-slate-950 flex items-center justify-center">
                                                <div className="w-2 h-2 bg-white rounded-full"></div>
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* MISSIONS/SCENARIOS */}
                        <div>
                            <div className="flex items-center justify-between mb-4">
                                <h2 className="text-xl font-bold text-white">Select a Mission</h2>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {MISSIONS.map(mission => {
                                    const Icon = mission.icon;
                                    const isSelected = selectedMission === mission.id;
                                    return (
                                        <button
                                            key={mission.id}
                                            onClick={() => setSelectedMission(mission.id)}
                                            className={`flex items-start gap-4 p-5 rounded-3xl border transition-all duration-300 text-left ${isSelected
                                                    ? 'bg-indigo-500/10 border-indigo-500 shadow-[0_10px_30px_rgba(99,102,241,0.15)] ring-1 ring-indigo-500/50'
                                                    : 'bg-slate-900 border-white/5 hover:bg-slate-800 hover:border-white/10'
                                                }`}
                                        >
                                            <div className={`p-3 rounded-2xl ${mission.color} shrink-0`}>
                                                <Icon size={24} />
                                            </div>
                                            <div>
                                                <h3 className="text-white font-bold text-lg">{mission.title}</h3>
                                                <p className="text-slate-400 text-sm mt-1 mb-3 line-clamp-2">{mission.desc}</p>
                                                <span className="inline-flex px-2 py-1 bg-slate-800 rounded border border-slate-700 text-[10px] font-bold text-slate-300 uppercase tracking-wider">
                                                    {mission.level}
                                                </span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    {/* RIGHT SIDEBAR: ACTION PANEL */}
                    <div className="lg:col-span-4">
                        <div className="sticky top-24 bg-slate-900/60 backdrop-blur-xl border border-white/10 p-6 rounded-[2rem] shadow-2xl">
                            {/* Selected Avatar Info */}
                            <div className="flex items-center gap-4 mb-6 pb-6 border-b border-white/5">
                                <div className={`w-16 h-16 rounded-full bg-gradient-to-br ${currentAvatar.color} p-[2px] shrink-0`}>
                                    <div className="w-full h-full bg-slate-900 rounded-full overflow-hidden">
                                        <img src={currentAvatar.image} alt={currentAvatar.name} className="w-full h-full object-cover" />
                                    </div>
                                </div>
                                <div>
                                    <h3 className="text-2xl font-black text-white">{currentAvatar.name}</h3>
                                    <p className="text-indigo-400 font-medium text-sm">{currentAvatar.role}</p>
                                </div>
                            </div>

                            <p className="text-slate-400 leading-relaxed mb-8">
                                "Hi there! I'm {currentAvatar.name}. {currentAvatar.desc} Let's practice!"
                            </p>

                            <div className="space-y-4 mb-8">
                                <div className="flex items-center justify-between text-sm">
                                    <span className="text-slate-500 font-medium">Mission</span>
                                    <span className="text-slate-200 font-bold">{MISSIONS.find(m => m.id === selectedMission)?.title}</span>
                                </div>
                                <div className="flex items-center justify-between text-sm">
                                    <span className="text-slate-500 font-medium">Correction Mode</span>
                                    <span className="text-slate-200 font-bold">
                                        {wolfieSettings?.correctionStrictness === 1 ? 'Chill (Few)' : wolfieSettings?.correctionStrictness === 3 ? 'Tough (Many)' : 'Balanced'}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between text-sm">
                                    <span className="text-slate-500 font-medium">Est. Time</span>
                                    <span className="text-slate-200 font-bold">~10 min</span>
                                </div>
                            </div>

                            <button
                                onClick={() => setIsLive(true)}
                                className="w-full group relative overflow-hidden flex items-center justify-center gap-3 py-5 bg-indigo-600 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-indigo-500 transition-all shadow-[0_10px_40px_rgba(79,70,229,0.4)] hover:shadow-[0_10px_50px_rgba(79,70,229,0.6)]"
                            >
                                <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:animate-shimmer" />
                                <Mic className="w-6 h-6 animate-pulse" />
                                Start Call
                            </button>

                            <p className="text-center text-[10px] text-slate-500 mt-4 uppercase tracking-widest font-mono">
                                Powered by Wolfie AI
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
