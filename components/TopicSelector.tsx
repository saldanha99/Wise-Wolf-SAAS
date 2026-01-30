import React from 'react';
import { motion } from 'framer-motion';
import { Plane, Briefcase, Utensils, Zap, Lock, Star, ChevronRight } from 'lucide-react';

interface Topic {
    id: string;
    title: string;
    icon: React.ReactNode;
    level: 'Easy' | 'Hard' | 'Nightmare' | 'All Levels';
    context: string;
    description: string;
    color: string;
}

interface TopicSelectorProps {
    onSelectTopic: (topic: { topic: string; context: string }) => void;
}

const topics: Topic[] = [
    {
        id: 'airport',
        title: 'Airport Survival',
        icon: <Plane size={40} />,
        level: 'Easy',
        context: "You are an Immigration Officer at JFK Airport. The user has lost their passport and is trying to explain the situation. Be stern but helpful if they explain well.",
        description: "Navigating customs and immigration without a passport.",
        color: "from-blue-500 to-cyan-400"
    },
    {
        id: 'interview',
        title: 'Tech Job Interview',
        icon: <Briefcase size={40} />,
        level: 'Hard',
        context: "You are a Senior Engineering Manager at Google. You are interviewing the user for a Frontend role. Ask about React, performance, and soft skills. Be critical.",
        description: "Face a tough interviewer for your dream job.",
        color: "from-emerald-500 to-green-400"
    },
    {
        id: 'restaurant',
        title: 'New York Order',
        icon: <Utensils size={40} />,
        level: 'Hard',
        context: "You are a busy, impatient waiter at a popular NY diner. The user is taking too long to order. Rush them politely but firmly.",
        description: "Order lunch while dealing with a rushed waiter.",
        color: "from-orange-500 to-red-400"
    },
    {
        id: 'freestyle',
        title: 'Freestyle Chat',
        icon: <Zap size={40} />,
        level: 'All Levels',
        context: "You are Wolfie, a friendly and curious AI tutor. Keep the conversation flowing naturally about any topic the user wants.",
        description: "Talk about anything! No scripts, just flow.",
        color: "from-violet-500 to-purple-400"
    }
];

const containerVariants = {
    hidden: { opacity: 0 },
    show: {
        opacity: 1,
        transition: {
            staggerChildren: 0.1
        }
    }
};

const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0 }
};

export const TopicSelector: React.FC<TopicSelectorProps> = ({ onSelectTopic }) => {
    return (
        <div className="min-h-screen w-full bg-slate-950 flex flex-col items-center justify-center p-8 relative overflow-hidden font-sans">

            {/* Background Atmosphere */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,_#1e1b4b_0%,_#020617_60%)] pointer-events-none" />
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-500/10 rounded-full blur-[100px] animate-pulse" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 rounded-full blur-[100px] animate-pulse delay-1000" />
            </div>

            <div className="relative z-10 max-w-6xl w-full flex flex-col items-center">

                {/* Header */}
                <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                    className="text-center mb-16 space-y-4"
                >
                    <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-md mb-2">
                        <Star size={14} className="text-yellow-400 fill-yellow-400" />
                        <span className="text-xs font-bold text-slate-300 uppercase tracking-widest">Choose your Mission</span>
                    </div>
                    <h1 className="text-4xl md:text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white via-slate-200 to-slate-500 drop-shadow-2xl">
                        Where do you want to go?
                    </h1>
                    <p className="text-slate-400 text-lg max-w-2xl mx-auto font-light leading-relaxed">
                        Select a scenario to immerse yourself in. Wolfie will adapt its personality to challenge you.
                    </p>
                </motion.div>

                {/* Grid */}
                <motion.div
                    variants={containerVariants}
                    initial="hidden"
                    animate="show"
                    className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 w-full"
                >
                    {topics.map((topic) => (
                        <motion.div
                            key={topic.id}
                            variants={itemVariants}
                            whileHover={{ scale: 1.05, y: -5 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => onSelectTopic({ topic: topic.title, context: topic.context })}
                            className="group relative h-80 rounded-3xl cursor-pointer"
                        >
                            {/* Glass Card */}
                            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-xl border border-white/10 rounded-3xl transition-all duration-300 group-hover:bg-slate-800/60 group-hover:border-white/20 shadow-2xl">

                                {/* Neon Glow on Hover */}
                                <div className={`absolute inset-0 rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-gradient-to-br ${topic.color} blur-xl -z-10`} />
                                <div className={`absolute inset-0 rounded-3xl opacity-0 group-hover:opacity-20 transition-opacity duration-300 bg-gradient-to-br ${topic.color} z-0`} />

                                <div className="relative z-10 h-full flex flex-col p-6">

                                    {/* Icon Box */}
                                    <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${topic.color} flex items-center justify-center text-white shadow-lg mb-6 group-hover:scale-110 transition-transform duration-300`}>
                                        {topic.icon}
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1">
                                        <div className="flex justify-between items-start mb-2">
                                            <h3 className="text-xl font-bold text-white leading-tight">{topic.title}</h3>
                                        </div>
                                        <p className="text-sm text-slate-400 line-clamp-3 leading-relaxed">
                                            {topic.description}
                                        </p>
                                    </div>

                                    {/* Footer */}
                                    <div className="pt-4 border-t border-white/5 flex items-center justify-between mt-auto">
                                        <div className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border bg-white/5 ${topic.level === 'Easy' ? 'text-cyan-400 border-cyan-400/20' :
                                                topic.level === 'Hard' ? 'text-orange-400 border-orange-400/20' :
                                                    topic.level === 'Nightmare' ? 'text-red-500 border-red-500/20' :
                                                        'text-purple-400 border-purple-400/20'
                                            }`}>
                                            {topic.level}
                                        </div>
                                        <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-slate-400 group-hover:bg-white group-hover:text-slate-900 transition-colors duration-300">
                                            <ChevronRight size={16} />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </motion.div>
            </div>
        </div>
    );
};
