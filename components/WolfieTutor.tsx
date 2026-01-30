import React, { useState, useRef, useEffect } from 'react';
import { Mic, Send, Volume2, Sparkles, Loader2, Square, Zap, Globe, Cpu, StopCircle, RefreshCw, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import WolfieLiveCall from './WolfieLiveCall';
import { TopicSelector } from './TopicSelector';

interface WolfieTutorProps {
    user: any;
}

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

// Type definition for Web Speech API
declare global {
    interface Window {
        webkitSpeechRecognition: any;
    }
}

const WolfieTutor: React.FC<WolfieTutorProps> = ({ user }) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [inputText, setInputText] = useState('');
    const [isListening, setIsListening] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [topic, setTopic] = useState<string>(''); // Empty initially
    const [showLiveCall, setShowLiveCall] = useState(false);
    const [hasSelectedTopic, setHasSelectedTopic] = useState(false);
    const [context, setContext] = useState<string>('');

    const recognitionRef = useRef<any>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // --- LOGIC: SAME AS BEFORE ---
    useEffect(() => {
        if ('webkitSpeechRecognition' in window) {
            const recognition = new window.webkitSpeechRecognition();
            recognition.continuous = false;
            recognition.interimResults = true;
            recognition.lang = 'en-US';

            recognition.onstart = () => setIsListening(true);

            recognition.onresult = (event: any) => {
                const transcript = Array.from(event.results)
                    .map((result: any) => result[0])
                    .map((result) => result.transcript)
                    .join('');
                setInputText(transcript);
            };

            recognition.onerror = (event: any) => {
                console.error("Speech error", event.error);
                setIsListening(false);
            };

            recognition.onend = () => setIsListening(false);
            recognitionRef.current = recognition;
        }

        return () => {
            if (recognitionRef.current) recognitionRef.current.stop();
            stopSpeaking();
        };
    }, []);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isProcessing]);

    const toggleListening = () => {
        if (!recognitionRef.current) return alert("Browser not supported.");
        if (isListening) {
            recognitionRef.current.stop();
        } else {
            setInputText('');
            stopSpeaking();
            recognitionRef.current.start();
        }
    };

    const speak = (text: string) => {
        stopSpeaking();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'en-US';
        utterance.rate = 1.0;

        const voices = window.speechSynthesis.getVoices();
        const preferredVoice = voices.find(v => v.name.includes('Google US English')) || voices.find(v => v.lang === 'en-US');
        if (preferredVoice) utterance.voice = preferredVoice;

        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => setIsSpeaking(false);
        utterance.onerror = () => setIsSpeaking(false);
        window.speechSynthesis.speak(utterance);
    };

    const stopSpeaking = () => {
        if (window.speechSynthesis.speaking) window.speechSynthesis.cancel();
        setIsSpeaking(false);
    };

    const sendMessage = async (text: string) => {
        if (!text.trim()) return;
        setIsProcessing(true);
        stopSpeaking();

        const newUserMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text, timestamp: new Date() };
        setMessages(prev => [...prev, newUserMsg]);
        setInputText('');

        try {
            // Build context including history and the selected MISSION CONTEXT
            const history = messages.slice(-6).map(m => `${m.role === 'user' ? 'Student' : 'Wolfie'}: ${m.content}`).join('\n');
            const fullContext = `MISSION CONTEXT: ${context}\n\nCONVERSATION HISTORY:\n${history}`;

            const { data, error } = await supabase.functions.invoke('wolfie-brain', {
                body: { message: text, studentLevel: user.levelBadge || 'A1', previousContext: fullContext, topic: topic }
            });

            if (error || data.error) throw new Error(data?.error || error?.message);

            const aiText = data.aiText;
            const aiMessage: Message = { id: crypto.randomUUID(), role: 'assistant', content: aiText, timestamp: new Date() };

            setMessages(prev => [...prev, aiMessage]);
            speak(aiText.replace(/\[Correction: .*?\]/, '')); // Don't speak correction metadata

        } catch (err: any) {
            console.error(err);
            setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: "System Error: Connection disrupted. Please retry.", timestamp: new Date() }]);
        } finally {
            setIsProcessing(false);
        }
    };

    // --- RENDER HELPERS ---
    const renderMessageContent = (content: string) => {
        const correctionMatch = content.match(/\[Correction: (.*?)\]/);

        if (correctionMatch) {
            const mainText = content.replace(correctionMatch[0], '').trim();
            const correction = correctionMatch[1];
            return (
                <div className="flex flex-col gap-3">
                    <span className="leading-relaxed">{mainText}</span>
                    <div className="relative overflow-hidden rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3 mt-1 group">
                        {/* Scanline effect for card */}
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-yellow-400/5 to-transparent -translate-x-full group-hover:animate-shimmer" />

                        <div className="flex items-start gap-3 relative z-10">
                            <div className="p-1.5 rounded-md bg-yellow-500/20 text-yellow-400 shrink-0">
                                <Zap size={14} />
                            </div>
                            <div className="space-y-1">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-yellow-500/80 block">Tactical Correction</span>
                                <p className="text-sm font-medium text-yellow-100">{correction}</p>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }
        return <span className="leading-relaxed">{content}</span>;
    };

    // --- VISUAL STATE ---
    const getCoreColor = () => {
        if (isSpeaking) return 'text-cyan-400 shadow-cyan-500/50';
        if (isListening) return 'text-red-500 shadow-red-500/50';
        if (isProcessing) return 'text-purple-500 shadow-purple-500/50';
        return 'text-blue-500 shadow-blue-500/20'; // Idle
    };

    const handleTopicSelection = (selection: { topic: string; context: string }) => {
        setTopic(selection.topic);
        setContext(selection.context);
        setHasSelectedTopic(true);
    };

    if (!hasSelectedTopic) {
        return <TopicSelector onSelectTopic={handleTopicSelection} />;
    }

    return (
        <div className="relative flex flex-col h-[calc(100vh-120px)] w-full rounded-2xl overflow-hidden bg-slate-950 font-sans border border-slate-800 shadow-2xl">

            {/* BACKGROUND EFFECTS */}
            <div className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-950 to-slate-950 pointer-events-none"></div>
            <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-indigo-500/5 rounded-full blur-3xl pointer-events-none transition-opacity duration-1000 ${isProcessing || showLiveCall ? 'opacity-50' : 'opacity-10'}`}></div>

            {/* HEADER HUD */}
            <div className="absolute top-0 left-0 right-0 z-30 p-4">
                <div className="mx-auto max-w-4xl bg-slate-900/60 backdrop-blur-md border border-white/5 rounded-2xl p-3 flex justify-between items-center shadow-lg">

                    {/* Status Badge */}
                    <div className="flex items-center gap-3 pl-2">
                        <div className="relative">
                            <div className={`w-2.5 h-2.5 rounded-full ${isListening ? 'bg-red-500 animate-ping' : isProcessing ? 'bg-purple-500 animate-pulse' : 'bg-emerald-500'}`}></div>
                            <div className={`absolute inset-0 w-2.5 h-2.5 rounded-full ${isListening ? 'bg-red-500' : isProcessing ? 'bg-purple-500' : 'bg-emerald-500'} opacity-50`}></div>
                        </div>
                        <div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-0.5">Systems</div>
                            <div className="text-xs font-bold text-slate-200">
                                {isListening ? 'AUDIO INPUT ACTIVE' : isProcessing ? 'PROCESSING NEURAL NET' : isSpeaking ? 'DATA TRANSMISSION' : 'ONLINE'}
                            </div>
                        </div>
                    </div>

                    {/* Level / Topic */}
                    <div className="flex items-center gap-3">

                        {/* LIVE CALL BUTTON - ADDED HERE */}
                        <button
                            onClick={() => setShowLiveCall(true)}
                            className="hidden md:flex items-center gap-2 px-4 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 transition-all group shadow-[0_0_15px_rgba(239,68,68,0.2)] hover:shadow-[0_0_20px_rgba(239,68,68,0.4)] cursor-pointer"
                        >
                            <div className="relative">
                                <span className="absolute inset-0 rounded-full bg-red-400 animate-ping opacity-75"></span>
                                <div className="relative w-2 h-2 rounded-full bg-red-500"></div>
                            </div>
                            <span className="text-xs font-bold text-red-400 uppercase tracking-wide group-hover:text-red-300">LIVE CALL</span>
                        </button>

                        <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                            <Cpu size={14} className="text-indigo-400" />
                            <span className="text-[10px] font-bold text-indigo-300 uppercase tracking-wide">
                                Level: {user.levelBadge || 'A1'}
                            </span>
                        </div>
                        <select
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                            className="bg-slate-800 border-none text-xs font-bold rounded-lg px-3 py-1.5 text-slate-300 focus:ring-1 focus:ring-cyan-500 outline-none cursor-pointer hover:bg-slate-700 transition-colors"
                        >
                            <option>Free Conversation</option>
                            <option>Business Tech</option>
                            <option>Space Travel</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* LIVE CALL OVERLAY COMPONENT */}
            {showLiveCall && (
                <WolfieLiveCall user={user} topic={topic} onClose={() => setShowLiveCall(false)} />
            )}

            {/* CHAT AREA */}
            <div className="flex-1 z-10 overflow-y-auto p-4 pt-24 pb-32 space-y-6 custom-scrollbar scroll-smooth">

                {/* IDLE STATE - THE CORE */}
                {messages.length === 0 && (
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center gap-8 pointer-events-none opacity-80">
                        {/* The Living Core */}
                        <div className={`relative w-48 h-48 rounded-full flex items-center justify-center transition-all duration-700 ${getCoreColor().split(' ')[0]} ${isSpeaking ? 'scale-110' : 'scale-100'}`}>
                            {/* Outer Rings */}
                            <div className={`absolute inset-0 border border-current opacity-20 rounded-full ${isListening ? 'animate-ping' : 'animate-[spin_10s_linear_infinite]'}`}></div>
                            <div className="absolute inset-4 border border-current opacity-30 rounded-full animate-[spin_15s_linear_infinite_reverse]"></div>

                            {/* Inner Glow */}
                            <div className={`w-32 h-32 rounded-full bg-current opacity-10 blur-xl animate-pulse`}></div>

                            {/* Icon */}
                            <div className={`relative z-10 transition-transform duration-300 ${isListening ? 'scale-125' : ''}`}>
                                {isListening ? <Mic size={48} /> : isProcessing ? <Loader2 size={48} className="animate-spin" /> : <Square size={40} className="rotate-45" />}
                            </div>
                        </div>
                        <p className="text-slate-500 font-mono text-xs uppercase tracking-[0.2em] animate-pulse">Awaiting Audio Input Signal</p>
                    </div>
                )}

                {messages.map((msg, idx) => (
                    <div key={msg.id} className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-4 duration-500`}>
                        <div className={`max-w-[85%] md:max-w-[70%] relative group`}>
                            {/* Label */}
                            <div className={`text-[10px] font-bold tracking-widest mb-1 opacity-60 ${msg.role === 'user' ? 'text-right text-indigo-300' : 'text-left text-cyan-300'}`}>
                                {msg.role === 'user' ? 'PILOT' : 'WOLFIE AI'} • {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>

                            {/* Bubble */}
                            <div className={`
                                p-5 rounded-2xl backdrop-blur-md shadow-lg transition-all
                                ${msg.role === 'user'
                                    ? 'bg-gradient-to-br from-indigo-600 to-blue-700 text-white rounded-tr-sm border border-indigo-400/30'
                                    : 'bg-slate-900/60 text-slate-100 rounded-tl-sm border-l-4 border-cyan-500 border-y border-r border-white/5'
                                }
                            `}>
                                {renderMessageContent(msg.content)}
                            </div>

                            {/* Actions */}
                            {msg.role === 'assistant' && (
                                <button
                                    onClick={() => speak(msg.content.replace(/\[Correction: .*?\]/, ''))}
                                    className="absolute -right-8 top-1/2 -translate-y-1/2 p-2 text-slate-500 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                    <Volume2 size={16} />
                                </button>
                            )}
                        </div>
                    </div>
                ))}

                {isProcessing && messages.length > 0 && (
                    <div className="flex justify-start animate-in fade-in">
                        <div className="bg-slate-900/40 border border-white/5 rounded-2xl rounded-tl-sm p-4 flex items-center gap-3">
                            <Loader2 size={16} className="text-cyan-500 animate-spin" />
                            <div className="h-1.5 w-1.5 bg-cyan-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                            <div className="h-1.5 w-1.5 bg-cyan-500 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                            <div className="h-1.5 w-1.5 bg-cyan-500 rounded-full animate-bounce"></div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* COMMAND BAR (FOOTER) */}
            <div className="absolute bottom-0 left-0 right-0 z-30 p-4 bg-gradient-to-t from-slate-950 via-slate-950/90 to-transparent">
                <div className="mx-auto max-w-3xl relative">

                    {/* Floating Mic Button */}
                    <div className="absolute left-1/2 -translate-x-1/2 -top-20">
                        <button
                            onClick={toggleListening}
                            className={`
                                relative w-20 h-20 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300
                                ${isListening
                                    ? 'bg-red-500 text-white shadow-[0_0_50px_rgba(239,68,68,0.5)] scale-110'
                                    : 'bg-slate-800 text-cyan-400 border border-cyan-500/30 hover:bg-slate-700 hover:text-cyan-300 hover:border-cyan-400'
                                }
                            `}
                        >
                            {isListening ? (
                                <>
                                    <span className="absolute inset-0 rounded-full border border-white/30 animate-[ping_1.5s_ease-out_infinite]"></span>
                                    <span className="absolute inset-0 rounded-full border border-white/20 animate-[ping_2s_ease-out_infinite_0.5s]"></span>
                                    <Square size={24} fill="currentColor" />
                                </>
                            ) : (
                                <Mic size={32} />
                            )}
                        </button>
                    </div>

                    {/* Text Input */}
                    <div className="mt-8 flex items-center gap-2 bg-slate-900/80 backdrop-blur-xl border border-white/10 rounded-full p-2 pl-6 shadow-2xl ring-1 ring-white/5 focus-within:ring-cyan-500/50 transition-all">
                        <input
                            type="text"
                            value={inputText}
                            onChange={(e) => setInputText(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && sendMessage(inputText)}
                            placeholder={isListening ? "Listening to audio stream..." : "Type transmission here..."}
                            disabled={isProcessing}
                            className="flex-1 bg-transparent border-none text-slate-200 placeholder:text-slate-600 focus:ring-0 text-sm font-medium"
                        />
                        <button
                            onClick={() => sendMessage(inputText)}
                            disabled={!inputText.trim() || isProcessing}
                            className="p-3 rounded-full bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-0 disabled:scale-50 transition-all"
                        >
                            <Send size={18} />
                        </button>
                    </div>
                    <p className="text-center text-[10px] text-slate-600 mt-2 font-mono">SECURE CONNECTION ESTABLISHED • WOLFIE OS v2.0</p>
                </div>
            </div>

        </div>
    );
};

export default WolfieTutor;
