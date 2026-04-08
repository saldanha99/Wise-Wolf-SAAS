import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Zap, CheckCircle2, Languages, BookOpen, BrainCircuit, Volume2, VolumeX, Mic, Send, Loader2, RotateCcw, Clock, MessageSquare, ChevronUp, ChevronDown } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { VoicePoweredOrb } from './VoicePoweredOrb';

// ============================================================
// TYPES
// ============================================================
interface WolfieTutorProps {
    user: any;
    voiceMode?: boolean; // If true, starts directly in voice mode (used by WolfieLiveCall wrapper)
    topic?: string;
    onClose?: () => void;
}

interface CorrectionData {
    original: string;
    corrected: string;
    explanation_pt: string;
}

interface VocabTerm {
    term: string;
    definition: string;
    level: string;
    synonyms: string[];
    example: string;
}

interface VocabData {
    keyTerms: VocabTerm[];
    grammarNote: string;
}

interface QuizData {
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
}

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    correction?: CorrectionData | null;
    translation?: string | null;
    vocabulary?: VocabData | null;
    quiz?: QuizData | null;
}

type CallState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

declare global {
    interface Window {
        webkitSpeechRecognition: any;
    }
}

// ============================================================
// TTS SPEED CONFIG BY LEVEL (E-Bot style)
// ============================================================
function getTTSSpeed(level: string): number {
    switch (level) {
        case 'A1': return 0.80;
        case 'A2': return 0.85;
        case 'B1': return 0.92;
        case 'B2': return 0.95;
        default: return 1.0; // C1, C2
    }
}

// ============================================================
// INLINE QUIZ COMPONENT
// ============================================================
const InlineQuiz: React.FC<{ quiz: QuizData }> = ({ quiz }) => {
    const [answered, setAnswered] = useState<number | null>(null);

    return (
        <div className="bg-fuchsia-950/30 backdrop-blur-xl border border-fuchsia-500/20 p-4 rounded-2xl mt-3">
            <div className="flex items-center gap-2 mb-3 text-fuchsia-400">
                <BrainCircuit size={14} />
                <span className="text-[10px] uppercase font-bold tracking-wider">Mini Quiz</span>
            </div>
            <p className="text-sm font-bold text-white mb-3 leading-snug">{quiz.question}</p>
            <div className="space-y-2">
                {quiz.options.map((opt, idx) => {
                    const isCorrect = idx === quiz.correctIndex;
                    const isSelected = answered === idx;

                    let classes = 'w-full text-left text-xs p-3 rounded-xl border transition-all ';
                    if (answered === null) {
                        classes += 'bg-white/5 hover:bg-fuchsia-500/20 border-white/5 text-slate-200 cursor-pointer';
                    } else if (isSelected && isCorrect) {
                        classes += 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300';
                    } else if (isSelected && !isCorrect) {
                        classes += 'bg-red-500/20 border-red-500/30 text-red-300';
                    } else if (isCorrect) {
                        classes += 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
                    } else {
                        classes += 'bg-white/5 border-white/5 text-slate-500';
                    }

                    return (
                        <button
                            key={idx}
                            onClick={() => answered === null && setAnswered(idx)}
                            className={classes}
                            disabled={answered !== null}
                        >
                            {opt}
                        </button>
                    );
                })}
            </div>
            {answered !== null && (
                <p className="text-xs text-slate-300 mt-3 pt-3 border-t border-white/10 leading-relaxed">
                    {answered === quiz.correctIndex ? '✨ ' : '💡 '}
                    {quiz.explanation}
                </p>
            )}
        </div>
    );
};

// ============================================================
// MAIN COMPONENT — UNIFIED VOICE + TEXT
// ============================================================
const WolfieTutor: React.FC<WolfieTutorProps> = ({ user, voiceMode = false, topic: initialTopic, onClose }) => {
    // --- Core State ---
    const [state, setState] = useState<CallState>('IDLE');
    const [messages, setMessages] = useState<Message[]>([]);
    const [inputText, setInputText] = useState('');
    const [subtitle, setSubtitle] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [turnCount, setTurnCount] = useState(0);
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [isVoiceDetected, setIsVoiceDetected] = useState(false);

    // --- UI State ---
    const [topic, setTopic] = useState<string>(initialTopic || '');
    const [hasSelectedTopic, setHasSelectedTopic] = useState(!!initialTopic);
    const [context, setContext] = useState<string>('');
    const [translationEnabled, setTranslationEnabled] = useState(true);
    const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(true);
    const [showTextInput, setShowTextInput] = useState(!voiceMode);
    const [showTranscript, setShowTranscript] = useState(false);

    // --- Overlay Cards (from agents) ---
    const [correction, setCorrection] = useState<CorrectionData | null>(null);
    const [translation, setTranslation] = useState<string | null>(null);
    const [vocabulary, setVocabulary] = useState<VocabData | null>(null);
    const [quiz, setQuiz] = useState<QuizData | null>(null);

    // --- Session Timer ---
    const [sessionStart] = useState<Date>(new Date());
    const [elapsed, setElapsed] = useState(0);
    const MAX_SESSION_MINUTES = 30;

    // --- Refs ---
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const englishVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
    const lastSpokenTextRef = useRef<string>('');
    const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const studentLevel = user.levelBadge || 'A1';

    // ============================================================
    // EFFECTS
    // ============================================================

    // Pre-load English TTS voice on mount
    useEffect(() => {
        const findEnglishVoice = () => {
            const voices = window.speechSynthesis.getVoices();
            if (voices.length === 0) return;

            const preferredNames = [
                'Samantha', 'Serena', 'Karen', 'Daniel',
                'Google US English', 'Google UK English Female',
                'Google UK English Male', 'Microsoft Zira', 'Microsoft David'
            ];

            let found: SpeechSynthesisVoice | null = null;
            for (const name of preferredNames) {
                found = voices.find(v => v.name.includes(name)) || null;
                if (found) break;
            }
            if (!found) {
                found = voices.find(v => v.lang.startsWith('en-')) || null;
            }

            if (found) {
                englishVoiceRef.current = found;
                console.log('🎙️ TTS Voice Selected:', found.name, found.lang);
            }
        };

        findEnglishVoice();
        window.speechSynthesis.onvoiceschanged = findEnglishVoice;
        return () => { window.speechSynthesis.onvoiceschanged = null; };
    }, []);

    // Initialize audio (microphone + recorder)
    useEffect(() => {
        const initAudio = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                setAudioStream(stream);

                const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? { mimeType: 'audio/webm;codecs=opus' }
                    : { mimeType: 'audio/webm' };

                const mediaRecorder = new MediaRecorder(stream, options);
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) audioChunksRef.current.push(event.data);
                };
                mediaRecorderRef.current = mediaRecorder;
            } catch (err) {
                console.error("Microphone access denied:", err);
                // Don't block — user can still type
            }
        };

        initAudio();

        return () => {
            stopSpeaking();
            audioStream?.getTracks().forEach(t => t.stop());
        };
    }, []);

    // Session timer
    useEffect(() => {
        const timer = setInterval(() => {
            const diff = Math.floor((Date.now() - sessionStart.getTime()) / 1000);
            setElapsed(diff);
            if (diff >= MAX_SESSION_MINUTES * 60) {
                setError(`Sessão encerrada (${MAX_SESSION_MINUTES} min)`);
                clearInterval(timer);
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [sessionStart]);

    // Auto-scroll messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // ============================================================
    // TTS FUNCTIONS
    // ============================================================
    const speak = useCallback((text: string, speed?: number) => {
        setState('SPEAKING');
        setSubtitle(text);
        lastSpokenTextRef.current = text;

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = speed ?? getTTSSpeed(studentLevel);

        if (englishVoiceRef.current) {
            utterance.voice = englishVoiceRef.current;
            utterance.lang = englishVoiceRef.current.lang;
        } else {
            utterance.lang = 'en-US';
        }

        utterance.onend = () => { setState('IDLE'); setSubtitle(''); };
        utterance.onerror = () => { setState('IDLE'); setSubtitle(''); };

        window.speechSynthesis.speak(utterance);
    }, [studentLevel]);

    const stopSpeaking = () => {
        window.speechSynthesis.cancel();
        setState(prev => prev === 'SPEAKING' ? 'IDLE' : prev);
        setSubtitle('');
    };

    const slowReplay = () => {
        if (lastSpokenTextRef.current) {
            stopSpeaking();
            speak(lastSpokenTextRef.current, 0.7);
        }
    };

    // ============================================================
    // AUDIO RECORDING (Voice mode)
    // ============================================================
    const startRecording = () => {
        if (state !== 'IDLE' || !mediaRecorderRef.current) return;
        stopSpeaking();
        setCorrection(null);
        setTranslation(null);
        setVocabulary(null);
        setQuiz(null);
        setError(null);

        audioChunksRef.current = [];
        mediaRecorderRef.current.start(100);
        setState('LISTENING');
    };

    const stopRecordingAndSend = () => {
        if (state !== 'LISTENING' || !mediaRecorderRef.current) return;
        mediaRecorderRef.current.stop();
        setState('THINKING');

        setTimeout(() => {
            const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
            processAudio(audioBlob);
        }, 200);
    };

    // ============================================================
    // PROCESS AUDIO / TEXT → wolfie-brain
    // ============================================================
    const processAudio = async (audioBlob: Blob) => {
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
            const base64String = reader.result as string;
            await sendToWolfieBrain({ audioBase64: base64String });
        };
    };

    const sendMessage = async (text: string) => {
        if (!text.trim()) return;
        setInputText('');
        setState('THINKING');
        stopSpeaking();
        setCorrection(null); setTranslation(null); setVocabulary(null); setQuiz(null);

        // Add user message to chat
        const newUserMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text, timestamp: new Date() };
        setMessages(prev => [...prev, newUserMsg]);

        await sendToWolfieBrain({ message: text });
    };

    const [liveCall, setLiveCall] = useState(false);
    const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const speechStartTimeRef = useRef<number | null>(null);

    // ============================================================
    // VAD & INTERRUPTION LOGIC (Live Call Mode)
    // ============================================================
    const handleVoiceDetection = (detected: boolean) => {
        setIsVoiceDetected(detected);
        if (!liveCall) return;

        // 1. Interruption Logic: If AI is speaking and user talks -> Stop AI immediately
        if (state === 'SPEAKING' && detected) {
            if (!speechStartTimeRef.current) speechStartTimeRef.current = Date.now();
            
            // Requires 300ms of continuous speech to interrupt (avoid false positives from coughs)
            if (Date.now() - speechStartTimeRef.current > 300) {
                stopSpeaking();
                startRecording();
                speechStartTimeRef.current = null;
            }
            return;
        }

        // 2. Start Recording: If IDLE and user starts talking
        if (state === 'IDLE' && detected) {
            if (!speechStartTimeRef.current) speechStartTimeRef.current = Date.now();
            
            if (Date.now() - speechStartTimeRef.current > 400) {
                startRecording();
                speechStartTimeRef.current = null;
            }
        } 
        
        // 3. Auto-Submit: If LISTENING and silence persists
        if (state === 'LISTENING') {
            if (detected) {
                // User is still talking, clear silence timer
                if (silenceTimeoutRef.current) {
                    clearTimeout(silenceTimeoutRef.current);
                    silenceTimeoutRef.current = null;
                }
            } else {
                // User stopped talking, start silence timer (1.5s)
                if (!silenceTimeoutRef.current) {
                    silenceTimeoutRef.current = setTimeout(() => {
                        stopRecordingAndSend();
                        silenceTimeoutRef.current = null;
                    }, 1500); 
                }
            }
        }

        if (!detected) speechStartTimeRef.current = null;
    };

    const sendToWolfieBrain = async (input: { message?: string; audioBase64?: string }) => {
        try {
            const history = messages.slice(-6).map(m => `${m.role === 'user' ? 'Student' : 'Wolfie'}: ${m.content}`).join('\n');
            const fullContext = context ? `MISSION CONTEXT: ${context}\n\nCONVERSATION HISTORY:\n${history}` : history;

            const modeMap: Record<string, string> = {
                'interview': 'job_interview', 'job': 'job_interview',
                'exam': 'exam_prep', 'ielts': 'exam_prep', 'toefl': 'exam_prep',
                'grammar': 'grammar_focus'
            };
            const topicLower = topic.toLowerCase();
            const mode = Object.entries(modeMap).find(([k]) => topicLower.includes(k))?.[1] || 'fluency';

            const { data, error: supabaseError } = await supabase.functions.invoke('wolfie-brain', {
                body: {
                    ...input,
                    studentLevel,
                    topic,
                    previousContext: fullContext,
                    translationEnabled,
                    vocabularyEnabled: true,
                    mode,
                    correctionStrictness: mode === 'exam_prep' || mode === 'grammar_focus' ? 3 : 1,
                    allowPortuguese: true,
                    turnCount,
                    conversationId,
                }
            });

            if (supabaseError || data?.error) {
                throw new Error(data?.error || supabaseError?.message || 'Unknown error');
            }

            // Process multi-agent response
            const chatText = data.chatResponse || data.aiText || '';

            const aiMessage: Message = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: chatText,
                timestamp: new Date(),
                correction: data.correction || null,
                translation: data.translation || null,
                vocabulary: data.vocabulary || null,
                quiz: data.quiz || null,
            };

            setMessages(prev => [...prev, aiMessage]);
            setTurnCount(prev => prev + 1);
            if (data.conversationId) setConversationId(data.conversationId);

            // Set overlay cards
            if (data.correction) setCorrection(data.correction);
            if (data.translation) setTranslation(data.translation);
            if (data.vocabulary?.keyTerms?.length > 0) setVocabulary(data.vocabulary);
            if (data.quiz) setQuiz(data.quiz);

            // Auto-speak
            if (autoSpeakEnabled && chatText) {
                speak(chatText);
            } else {
                setState('IDLE');
            }

        } catch (err: any) {
            console.error('Wolfie Brain Error:', err);
            setError(err.message || 'Erro de conexão');
            setState('IDLE');
            setTimeout(() => setError(null), 5000);
        }
    };

    // Auto-start first turn when mode is selected
    useEffect(() => {
        if (hasSelectedTopic && messages.length === 0 && state === 'IDLE') {
            setState('THINKING');
            sendToWolfieBrain({});
        }
    }, [hasSelectedTopic, messages.length]);

    // ============================================================
    // VISUAL HELPERS
    // ============================================================
    const getOrbHue = () => {
        switch (state) {
            case 'IDLE': return 220;
            case 'LISTENING': return 0;
            case 'THINKING': return 280;
            case 'SPEAKING': return 180;
        }
    };

    const getStatusLabel = () => {
        switch (state) {
            case 'IDLE': return 'Pronto para Ouvir';
            case 'LISTENING': return 'Ouvindo...';
            case 'THINKING': return 'Wolfie Pensando...';
            case 'SPEAKING': return 'Wolfie Falando';
        }
    };

    const formatTime = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    };

    const handleModeSelection = (mode: 'voice' | 'text' | 'live') => {
        setTopic('Conversa Livre');
        setContext('');
        setShowTextInput(mode === 'text');
        setLiveCall(mode === 'live');
        
        // Ativar de propósito para começar a conversa
        setHasSelectedTopic(true);

        if (mode === 'live') {
            setAutoSpeakEnabled(true);
            setTranslationEnabled(false); // More immersive
            // Play a start-call sound effect if possible, or just start
        }
    };

    // ============================================================
    // ENTRY SCREEN — CHOOSE MODE
    // ============================================================
    if (!hasSelectedTopic) {
        return (
            <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col items-center justify-center p-8 relative overflow-hidden font-sans">
                {/* Background Atmosphere */}
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,_#1e1b4b_0%,_#020617_60%)] pointer-events-none" />
                <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
                    <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-500/10 rounded-full blur-[100px] animate-pulse" />
                    <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 rounded-full blur-[100px] animate-pulse delay-1000" />
                </div>

                {onClose && (
                    <button onClick={onClose} className="absolute top-6 right-6 p-3 rounded-full bg-white/5 text-white/50 hover:bg-white/10 hover:text-white transition-all z-50 backdrop-blur-xl border border-white/10 hover:scale-110 active:scale-95 group">
                        <X size={20} className="group-hover:rotate-90 transition-transform duration-300" />
                    </button>
                )}

                <div className="relative z-10 max-w-4xl w-full flex flex-col items-center text-center">
                    <div className="mb-12">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 mb-6">
                            <BrainCircuit size={16} />
                            <span className="text-xs font-bold uppercase tracking-widest">Wolfie AI (Powered by Gemini)</span>
                        </div>
                        <h1 className="text-5xl md:text-7xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white via-slate-200 to-indigo-300 drop-shadow-2xl mb-6">
                            Olá, {user?.full_name?.split(' ')[0] || 'Aluno'}!
                        </h1>
                        <p className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto font-light leading-relaxed">
                            Como você prefere praticar o seu inglês hoje?
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-5xl mx-auto">
                        {/* Live Call Mode */}
                        <button
                            onClick={() => handleModeSelection('live')}
                            className="group relative p-8 rounded-3xl bg-indigo-600/20 backdrop-blur-xl border border-indigo-500/30 hover:bg-indigo-600/40 transition-all duration-300 text-left overflow-hidden flex flex-col items-center text-center shadow-[0_0_40px_rgba(79,70,229,0.2)]"
                        >
                            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 to-purple-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                            <div className="w-20 h-20 rounded-full bg-indigo-500/40 flex items-center justify-center mb-6 group-hover:scale-110 group-hover:bg-indigo-500 transition-all duration-300 relative">
                                <Zap size={32} className="text-white animate-pulse" />
                                <div className="absolute inset-0 rounded-full border-2 border-white/20 animate-ping" />
                            </div>
                            <h3 className="text-2xl font-bold text-white mb-3">Live Call ⚡</h3>
                            <p className="text-indigo-200/70 text-sm">Conversa 100% automática e fluida. Como uma ligação real.</p>
                        </button>

                        {/* Voice Mode */}
                        <button
                            onClick={() => handleModeSelection('voice')}
                            className="group relative p-8 rounded-3xl bg-slate-900/40 backdrop-blur-xl border border-white/10 hover:bg-slate-800/60 transition-all duration-300 text-left overflow-hidden flex flex-col items-center text-center"
                        >
                            <div className="absolute inset-0 bg-gradient-to-br from-slate-500/20 to-slate-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                            <div className="w-20 h-20 rounded-full bg-slate-500/20 flex items-center justify-center mb-6 group-hover:scale-110 group-hover:bg-slate-500 transition-all duration-300">
                                <Mic size={32} className="text-slate-400 group-hover:text-white transition-colors" />
                            </div>
                            <h3 className="text-2xl font-bold text-white mb-3">Mãos dadas</h3>
                            <p className="text-slate-400 text-sm">Pressione para falar. Você controla o tempo da conversa.</p>
                        </button>

                        {/* Text Mode */}
                        <button
                            onClick={() => handleModeSelection('text')}
                            className="group relative p-8 rounded-3xl bg-slate-900/40 backdrop-blur-xl border border-white/10 hover:bg-slate-800/60 transition-all duration-300 text-left overflow-hidden flex flex-col items-center text-center"
                        >
                            <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/20 to-teal-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                            <div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center mb-6 group-hover:scale-110 group-hover:bg-emerald-500 transition-all duration-300">
                                <MessageSquare size={32} className="text-emerald-400 group-hover:text-white transition-colors" />
                            </div>
                            <h3 className="text-2xl font-bold text-white mb-3">Chat por Texto</h3>
                            <p className="text-slate-400 text-sm">Pratique a escrita através do chat interativo do Wolfie.</p>
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ============================================================
    // RENDER — UNIFIED VOICE + TEXT EXPERIENCE
    // ============================================================
    return (
        <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col items-center justify-center overflow-hidden font-sans">

            {/* BACKGROUND EFFECTS */}
            <div className={`absolute inset-0 transition-colors duration-1000 ${state === 'LISTENING' ? 'bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-red-900/30 via-slate-950 to-slate-950' :
                state === 'THINKING' ? 'bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-purple-900/30 via-slate-950 to-slate-950' :
                    state === 'SPEAKING' ? 'bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-cyan-900/30 via-slate-950 to-slate-950' :
                        'bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-950 to-slate-950'
                }`}></div>
            <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none mix-blend-overlay"></div>

            {/* CLOSE BUTTON */}
            {onClose && (
                <button onClick={onClose} className="absolute top-6 right-6 p-3 rounded-full bg-white/5 text-white/50 hover:bg-white/10 hover:text-white transition-all z-50 backdrop-blur-xl border border-white/10 hover:scale-110 active:scale-95 group">
                    <X size={20} className="group-hover:rotate-90 transition-transform duration-300" />
                </button>
            )}

            {/* HEADER HUD */}
            <div className="absolute top-6 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2">
                {/* Status Badge */}
                <div className="flex items-center gap-3 px-5 py-2 rounded-full bg-white/5 border border-white/10 backdrop-blur-md shadow-2xl">
                    <div className={`w-2 h-2 rounded-full ${state === 'LISTENING' ? 'bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]' :
                        state === 'THINKING' ? 'bg-purple-500 animate-pulse' :
                            state === 'SPEAKING' ? 'bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.8)]' :
                                'bg-indigo-500'}`} />
                    <span className="text-[10px] font-bold text-white/90 tracking-[0.2em] uppercase">{getStatusLabel()}</span>
                </div>

                {/* Timer + Level + Controls */}
                <div className="flex items-center gap-2">
                    {/* Only show these in non-live mode or as secondary HUD */}
                    {!liveCall && (
                        <>
                            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 backdrop-blur-md">
                                <Clock size={10} className="text-slate-400" />
                                <span className="text-[10px] font-mono text-slate-400">{formatTime(elapsed)}</span>
                            </div>
                            <div className="px-3 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/20 text-[10px] font-bold text-indigo-300 uppercase tracking-wider">
                                {studentLevel}
                            </div>
                            {/* Translation Toggle */}
                            <button
                                onClick={() => setTranslationEnabled(p => !p)}
                                className={`p-1.5 rounded-full border transition-all ${translationEnabled ? 'bg-sky-500/15 border-sky-500/30 text-sky-300' : 'bg-white/5 border-white/10 text-slate-500'}`}
                                title={translationEnabled ? 'Tradução ON' : 'Tradução OFF'}
                            >
                                <Languages size={12} />
                            </button>
                        </>
                    )}
                    
                    {/* Auto-Speak Toggle */}
                    <button
                        onClick={() => { setAutoSpeakEnabled(p => !p); if (state === 'SPEAKING') stopSpeaking(); }}
                        className={`p-1.5 rounded-full border transition-all ${autoSpeakEnabled ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-white/5 border-white/10 text-slate-500'}`}
                        title={autoSpeakEnabled ? 'Auto-speak ON' : 'Auto-speak OFF'}
                    >
                        {autoSpeakEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}
                    </button>
                    
                    {!liveCall && (
                        <>
                            <button
                                onClick={() => setShowTextInput(p => !p)}
                                className={`p-1.5 rounded-full border transition-all ${showTextInput ? 'bg-amber-500/15 border-amber-500/30 text-amber-300' : 'bg-white/5 border-white/10 text-slate-500'}`}
                                title={showTextInput ? 'Teclado ON' : 'Teclado OFF'}
                            >
                                <MessageSquare size={12} />
                            </button>
                            <button
                                onClick={slowReplay}
                                disabled={!lastSpokenTextRef.current}
                                className="p-1.5 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30"
                                title="Repetir devagar (0.7x)"
                            >
                                <RotateCcw size={12} />
                            </button>
                        </>
                    )}
                </div>

                {/* Idle Hint */}
                {state === 'IDLE' && (
                    <div className="text-white/30 text-[9px] font-bold tracking-[0.3em] uppercase animate-pulse">
                        Pressione a esfera para falar
                    </div>
                )}
            </div>

            {/* ERROR FEEDBACK */}
            {error && (
                <div className="absolute top-32 z-50 animate-in slide-in-from-top-4 fade-in duration-300">
                    <div className="bg-red-950/80 backdrop-blur-2xl border border-red-500/50 text-red-200 px-6 py-3 rounded-2xl flex items-center gap-3 shadow-[0_0_30px_rgba(239,68,68,0.3)]">
                        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-xs font-bold tracking-[0.1em] uppercase">{error}</span>
                    </div>
                </div>
            )}

            {/* ============================================================ */}
            {/* MAIN INTERACTION AREA — THE ORB */}
            {/* ============================================================ */}
            <div className="relative z-20 flex flex-col items-center justify-center w-full h-full max-w-5xl mx-auto">
                <div
                    className={`relative cursor-pointer touch-none flex items-center justify-center group ${liveCall ? 'w-[350px] h-[350px] md:w-[600px] md:h-[600px]' : 'w-[320px] h-[320px] md:w-[500px] md:h-[500px]'}`}
                    onMouseDown={!liveCall ? startRecording : undefined}
                    onMouseUp={!liveCall ? stopRecordingAndSend : undefined}
                >
                    {/* PINGING RINGS (Live Mode) */}
                    {liveCall && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className={`absolute w-[80%] h-[80%] rounded-full border-2 border-indigo-500/20 transition-all duration-700 ${state === 'LISTENING' ? 'animate-ping scale-110 border-red-500/30' : 'animate-pulse'}`} />
                            <div className={`absolute w-[95%] h-[95%] rounded-full border border-indigo-500/10 transition-all duration-1000 ${state === 'SPEAKING' ? 'scale-105 border-cyan-500/20' : ''}`} />
                        </div>
                    )}

                    <VoicePoweredOrb
                        hue={getOrbHue()}
                        audioStream={audioStream}
                        voiceSensitivity={2.5}
                        maxRotationSpeed={1.8}
                        maxHoverIntensity={1.2}
                        onVoiceDetected={handleVoiceDetection}
                        state={state === 'IDLE' ? 0 : state === 'LISTENING' ? 1 : state === 'THINKING' ? 2 : 3}
                    />

                    {/* Hover Hint */}
                    {state === 'IDLE' && !liveCall && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500">
                            <div className="px-5 py-2.5 rounded-full bg-white/10 backdrop-blur-xl border border-white/20 tracking-[0.2em] text-white/90 text-[10px] font-bold uppercase shadow-2xl">
                                Segure para falar
                            </div>
                        </div>
                    )}
                </div>

                {/* Subtitles */}
                <div className={`absolute left-0 right-0 px-8 text-center pointer-events-none z-30 flex flex-col items-center justify-end transition-all ${liveCall ? 'bottom-32 md:bottom-40' : 'bottom-20 md:bottom-28'}`}>
                    {subtitle ? (
                        <p className={`${liveCall ? 'text-2xl md:text-4xl lg:text-5xl font-black' : 'text-xl md:text-2xl lg:text-3xl font-light'} text-white drop-shadow-[0_4px_30px_rgba(0,0,0,0.9)] animate-in fade-in slide-in-from-bottom-10 duration-700 max-w-5xl mx-auto leading-tight italic`}>
                            "{subtitle}"
                        </p>
                    ) : state !== 'IDLE' ? (
                        <p className={`text-xs tracking-[0.4em] font-bold uppercase ${state === 'THINKING' ? 'text-purple-400 animate-pulse' : state === 'LISTENING' ? 'text-red-400 animate-pulse' : 'text-slate-500'}`}>
                            {state === 'THINKING' ? 'Processando...' : state === 'LISTENING' ? 'Ouvindo...' : ''}
                        </p>
                    ) : null}
                </div>

                {/* HANG UP BUTTON (Live Mode Only) */}
                {liveCall && (
                    <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-50">
                        <button 
                            onClick={onClose}
                            className="group flex flex-col items-center gap-2"
                        >
                            <div className="w-16 h-16 rounded-full bg-red-600 flex items-center justify-center text-white shadow-[0_0_30px_rgba(220,38,38,0.5)] hover:bg-red-500 hover:scale-110 active:scale-95 transition-all duration-300 ring-4 ring-white/10">
                                <X size={28} strokeWidth={3} />
                            </div>
                            <span className="text-[10px] font-black uppercase tracking-[0.3em] text-red-500/80">Encerrar</span>
                        </button>
                    </div>
                )}
            </div>

            {/* ============================================================ */}
            {/* TEXT INPUT (Collapsible) */}
            {/* ============================================================ */}
            {showTextInput && (
                <div className="absolute bottom-6 left-4 right-4 z-50 max-w-2xl mx-auto animate-in slide-in-from-bottom-6 fade-in duration-300">
                    <div className="flex items-center gap-2 bg-slate-900/80 backdrop-blur-xl border border-white/10 rounded-full p-2 pl-5 shadow-2xl ring-1 ring-white/5 focus-within:ring-cyan-500/50 transition-all">
                        <input
                            type="text"
                            value={inputText}
                            onChange={(e) => setInputText(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && sendMessage(inputText)}
                            placeholder="Type in English..."
                            disabled={state === 'THINKING'}
                            className="flex-1 bg-transparent border-none text-slate-200 placeholder:text-slate-600 focus:ring-0 focus:outline-none text-sm font-medium"
                        />
                        <button
                            onClick={() => sendMessage(inputText)}
                            disabled={!inputText.trim() || state === 'THINKING'}
                            className="p-2.5 rounded-full bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30 transition-all"
                        >
                            {state === 'THINKING' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                        </button>
                    </div>
                </div>
            )}

            {/* ============================================================ */}
            {/* CORRECTION FEEDBACK CARD (Bottom Left) */}
            {/* ============================================================ */}
            {correction && (
                <div className="absolute bottom-6 left-4 md:left-8 md:w-[420px] z-40 animate-in slide-in-from-bottom-10 fade-in duration-500">
                    <div className="bg-slate-900/40 backdrop-blur-3xl border border-white/10 p-5 rounded-[1.5rem] shadow-[0_20px_50px_rgba(0,0,0,0.5)] relative overflow-hidden group hover:bg-slate-900/60 transition-colors">
                        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-400 via-teal-400 to-emerald-400 opacity-80" />
                        <div className="flex flex-col gap-3 relative z-10">
                            <div className="flex items-center justify-between border-b border-white/5 pb-2">
                                <div className="flex items-center gap-2">
                                    <div className="p-1.5 bg-emerald-500/20 text-emerald-400 rounded-lg">
                                        <Zap size={14} fill="currentColor" />
                                    </div>
                                    <h4 className="text-white font-black text-[10px] uppercase tracking-widest">Correção</h4>
                                </div>
                                <button onClick={() => setCorrection(null)} className="text-slate-400 hover:text-white transition-colors bg-white/5 p-1.5 rounded-full">
                                    <X size={12} />
                                </button>
                            </div>
                            <div className="space-y-2">
                                {correction.original && (
                                    <div className="bg-red-950/30 rounded-xl p-3 border border-red-500/10">
                                        <span className="text-[9px] text-red-400 font-bold uppercase tracking-widest flex items-center gap-1 mb-1">
                                            <X size={10} strokeWidth={3} /> Como você disse
                                        </span>
                                        <p className="text-sm font-medium text-white/50 line-through decoration-red-500/50">{correction.original}</p>
                                    </div>
                                )}
                                <div className="bg-emerald-500/10 rounded-xl p-3 border border-emerald-500/20">
                                    <span className="text-[9px] text-emerald-400 font-bold uppercase tracking-widest flex items-center gap-1 mb-1">
                                        <CheckCircle2 size={10} strokeWidth={3} /> Forma Correta
                                    </span>
                                    <p className="text-base font-black text-emerald-300">"{correction.corrected}"</p>
                                </div>
                                <p className="text-xs text-slate-300 leading-relaxed font-medium">{correction.explanation_pt}</p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* TRANSLATION CARD (Top Left) */}
            {translation && (
                <div className="absolute top-[130px] left-4 md:left-8 z-40 max-w-[280px] md:max-w-sm animate-in fade-in slide-in-from-left-8 duration-500">
                    <div className="bg-sky-950/40 backdrop-blur-xl border border-sky-500/20 p-3 rounded-2xl shadow-lg relative group hover:bg-sky-950/60 transition-colors">
                        <button onClick={() => setTranslation(null)} className="absolute top-2 right-2 text-sky-400/50 hover:text-sky-300"><X size={12} /></button>
                        <div className="flex items-center gap-2 mb-2 text-sky-400">
                            <Languages size={12} />
                            <span className="text-[9px] uppercase font-bold tracking-wider">Tradução</span>
                        </div>
                        <p className="text-sm text-sky-100 font-medium leading-relaxed">{translation}</p>
                    </div>
                </div>
            )}

            {/* VOCABULARY CARD (Top Right) */}
            {vocabulary && vocabulary.keyTerms && vocabulary.keyTerms.length > 0 && (
                <div className="absolute top-[130px] right-4 md:right-8 z-40 max-w-[260px] md:max-w-sm animate-in fade-in slide-in-from-right-8 duration-500">
                    <div className="bg-indigo-950/40 backdrop-blur-xl border border-indigo-500/20 p-3 rounded-2xl shadow-lg relative group hover:bg-indigo-950/60 transition-colors">
                        <button onClick={() => setVocabulary(null)} className="absolute top-2 right-2 text-indigo-400/50 hover:text-indigo-300"><X size={12} /></button>
                        <div className="flex items-center gap-2 mb-2 text-indigo-400">
                            <BookOpen size={12} />
                            <span className="text-[9px] uppercase font-bold tracking-wider">Vocabulário</span>
                        </div>
                        <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
                            {vocabulary.keyTerms.map((term, idx) => (
                                <div key={idx} className="bg-white/5 p-2.5 rounded-xl border border-white/10">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="font-bold text-indigo-300 text-sm">{term.term}</span>
                                        <span className="text-[9px] font-bold bg-indigo-500/20 px-1.5 py-0.5 rounded text-indigo-200">{term.level}</span>
                                    </div>
                                    <p className="text-[11px] text-slate-300 leading-relaxed">{term.definition}</p>
                                    <p className="text-[10px] text-slate-400 italic mt-1">"{term.example}"</p>
                                </div>
                            ))}
                        </div>
                        {vocabulary.grammarNote && (
                            <div className="mt-2 pt-2 border-t border-white/10 text-[11px] text-indigo-300 font-medium leading-relaxed">
                                💡 {vocabulary.grammarNote}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* QUIZ CARD (Bottom Right) */}
            {quiz && (
                <div className="absolute bottom-6 right-4 md:right-8 z-40 max-w-[280px] md:max-w-sm animate-in fade-in slide-in-from-bottom-8 duration-500">
                    <InlineQuiz quiz={quiz} />
                </div>
            )}

            {/* TRANSCRIPT TOGGLE (Bottom center, above text input) */}
            <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40">
                <button
                    onClick={() => setShowTranscript(p => !p)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all text-[10px] font-bold uppercase tracking-wider"
                >
                    {showTranscript ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                    Histórico ({messages.length})
                </button>
            </div>

            {/* TRANSCRIPT PANEL (Slide up) */}
            {showTranscript && (
                <div className="absolute bottom-28 left-4 right-4 max-h-[40vh] z-40 animate-in slide-in-from-bottom-6 fade-in duration-300">
                    <div className="bg-slate-950/90 backdrop-blur-2xl border border-white/10 rounded-2xl p-4 overflow-y-auto max-h-[40vh] space-y-3">
                        {messages.length === 0 ? (
                            <p className="text-xs text-slate-500 text-center py-4">Nenhuma mensagem ainda</p>
                        ) : (
                            messages.map((msg) => (
                                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[80%] p-3 rounded-xl text-sm ${msg.role === 'user'
                                        ? 'bg-indigo-600/30 text-indigo-100 rounded-tr-sm'
                                        : 'bg-slate-800/50 text-slate-200 rounded-tl-sm border-l-2 border-cyan-500'}`}>
                                        <p className="leading-relaxed">{msg.content}</p>
                                        {msg.correction && (
                                            <div className="mt-2 pt-2 border-t border-white/10 text-xs">
                                                <span className="text-red-400 line-through">{msg.correction.original}</span>
                                                <span className="text-emerald-400 ml-2">{msg.correction.corrected}</span>
                                            </div>
                                        )}
                                        {msg.translation && (
                                            <p className="mt-1 text-xs text-sky-300/60 italic">{msg.translation}</p>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                        <div ref={messagesEndRef} />
                    </div>
                </div>
            )}

        </div>
    );
};

export default WolfieTutor;
