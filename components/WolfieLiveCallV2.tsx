import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Mic, MicOff, StopCircle, RefreshCw, MessageSquare, AlertCircle, Sparkles, Zap, BookOpen, Volume2, Trophy, Clock, CheckCircle, Star } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { VoicePoweredOrb } from './VoicePoweredOrb';
import { useVAD } from '../hooks/useVAD';

interface WolfieLiveCallV2Props {
    user: any;
    wolfieConfig: any;
    avatarId: string;
    scenarioId: string;
    onClose: () => void;
}

type CallState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

interface CorrectionItem {
    id: string;
    explanation: string;
    wrongSentence: string;
    correctSentence: string;
}

export default function WolfieLiveCallV2({
    user,
    wolfieConfig,
    avatarId,
    scenarioId,
    onClose
}: WolfieLiveCallV2Props) {
    const [state, setState] = useState<CallState>('IDLE');
    const [subtitle, setSubtitle] = useState<string>('Pressione o microfone para começar...');
    const [transcript, setTranscript] = useState<{ role: 'user' | 'assistant', content: string }[]>([]);
    const [corrections, setCorrections] = useState<CorrectionItem[]>([]);
    const [activeTab, setActiveTab] = useState<'TRANSCRIPT' | 'CORRECTIONS'>('TRANSCRIPT');
    const [scenarioStep, setScenarioStep] = useState(1);
    const [error, setError] = useState<string | null>(null);
    const [activeCorrectionPopUp, setActiveCorrectionPopUp] = useState<CorrectionItem | null>(null);
    const [showSummary, setShowSummary] = useState(false);
    const [vocabLearned, setVocabLearned] = useState(0);
    const [speakSlower, setSpeakSlower] = useState(false);
    const [repeatRequired, setRepeatRequired] = useState(false);
    const [targetPhrase, setTargetPhrase] = useState<string | null>(null);
    const sessionStartRef = useRef<number>(Date.now());
    const lastSpokenTextRef = useRef<string>('');

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const audioMimeTypeRef = useRef<string>('audio/webm');
    const audioStreamRef = useRef<MediaStream | null>(null);
    const [audioStreamReady, setAudioStreamReady] = useState<MediaStream | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const stateRef = useRef<CallState>('IDLE');
    stateRef.current = state;

    // Format Scenario Title
    const missionTitle = scenarioId.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    // Init audio — cross-platform (Chrome desktop, Chrome Android, Safari iOS)
    useEffect(() => {
        const pickMimeType = (): string => {
            const candidates = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/mp4;codecs=mp4a.40.2',
                'audio/mp4',
                'audio/ogg;codecs=opus',
            ];
            for (const t of candidates) {
                if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
            }
            return '';
        };

        const initAudio = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 16000,
                        channelCount: 1,
                    }
                });
                audioStreamRef.current = stream;
                setAudioStreamReady(stream);
                const mimeType = pickMimeType();
                const mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
                audioMimeTypeRef.current = mediaRecorder.mimeType || mimeType || 'audio/webm';
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) currentChunks.push(event.data);
                };
                mediaRecorderRef.current = mediaRecorder;
            } catch (err) {
                alert('Permissão de microfone necessária.');
                onClose();
            }
        };

        const currentChunks: Blob[] = [];
        audioChunksRef.current = currentChunks;
        initAudio();

        return () => {
            stopSpeaking();
            audioStreamRef.current?.getTracks().forEach(t => t.stop());
        };
    }, []);

    // VAD — auto-listening
    const startRecordingVAD = useCallback(() => {
        if (stateRef.current === 'THINKING' || activeCorrectionPopUp) return;
        if (stateRef.current === 'SPEAKING') {
            window.speechSynthesis.cancel();
        }
        if (!isMuted && mediaRecorderRef.current && mediaRecorderRef.current.state === 'inactive') {
            audioChunksRef.current = [];
            mediaRecorderRef.current.start();
            setState('LISTENING');
            setSubtitle('');
            setError(null);
        }
    }, [isMuted, activeCorrectionPopUp]);

    const stopRecordingVAD = useCallback(() => {
        if (stateRef.current !== 'LISTENING' || !mediaRecorderRef.current) return;
        const recorder = mediaRecorderRef.current;
        recorder.onstop = () => {
            const mimeType = audioMimeTypeRef.current;
            const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
            if (audioBlob.size < 1000) {
                setState('IDLE');
                return;
            }
            processAudio(audioBlob, mimeType);
        };
        recorder.stop();
        setState('THINKING');
        setSubtitle('');
    }, []);

    useVAD(audioStreamReady, !isMuted && !showSummary && !activeCorrectionPopUp, {
        onSpeechStart: startRecordingVAD,
        onSpeechEnd: stopRecordingVAD,
    });

    // Legacy push-to-talk kept as fallback for manual trigger
    const startRecording = () => {
        if (state === 'SPEAKING' || state === 'THINKING' || activeCorrectionPopUp) return;
        if (mediaRecorderRef.current.state === 'inactive') {
            audioChunksRef.current = [];
            mediaRecorderRef.current.start();
            setState('LISTENING');
            setSubtitle('');
            setError(null);
        }
    };

    const stopRecordingAndSend = () => {
        if (state !== 'LISTENING' || !mediaRecorderRef.current) return;
        const recorder = mediaRecorderRef.current;
        if (recorder.state === 'recording') {
            recorder.stop();
            setState('THINKING');
            setSubtitle('');
        } else {
            setState('IDLE');
        }
    };

    const processAudio = async (audioBlob: Blob, mimeType: string) => {
        try {
            if (audioBlob.size > 5 * 1024 * 1024) throw new Error('Áudio muito longo.');
            if (audioBlob.size < 1000) throw new Error('Áudio muito curto, segure o botão por mais tempo.');

            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = async () => {
                const base64String = reader.result as string;
                const contextList = transcript.slice(-4).map(m => `${m.role === 'user' ? 'Student' : 'Wolfie'}: ${m.content}`);
                const previousContext = contextList.join('\n');

                const payload = {
                    audioBase64: base64String,
                    audioMimeType: mimeType,
                    studentLevel: wolfieConfig?.level || 'A1',
                    topic: scenarioId,
                    mode: wolfieConfig?.goal === 'Fluency' ? 'fluency' : 'grammar_focus',
                    correctionStrictness: wolfieConfig?.correctionStrictness || 2,
                    previousContext,
                    turnCount: Math.floor(transcript.length / 2),
                    conversationId: `${user.id}-${scenarioId}-${Date.now()}`,
                };

                const { data, error: supabaseError } = await supabase.functions.invoke('wolfie-brain', { body: payload });
                if (supabaseError) throw supabaseError;
                if (data.error) throw new Error(data.error);

                const cleanAiText = (data.aiText || '').trim();
                const transcribed = (data.transcribedText || '').trim();

                if (data.correction) {
                    const newCorr: CorrectionItem = {
                        id: Math.random().toString(36).substring(7),
                        explanation: data.correction.explanation_pt,
                        wrongSentence: data.correction.original,
                        correctSentence: data.correction.corrected,
                    };
                    setCorrections(prev => [newCorr, ...prev]);
                    setActiveTab('CORRECTIONS');
                    setActiveCorrectionPopUp(newCorr);
                }

                // Accumulate vocab count
                if (data.vocabulary?.keyTerms?.length) {
                    setVocabLearned(prev => prev + data.vocabulary.keyTerms.length);
                }
                
                // Repeat enforcement
                if (data.repeatRequired) {
                    setRepeatRequired(true);
                    setTargetPhrase(data.targetPhrase);
                } else {
                    setRepeatRequired(false);
                    setTargetPhrase(null);
                }

                setTranscript(prev => [
                    ...prev,
                    { role: 'user', content: transcribed || '[Mensagem de Áudio]' },
                    { role: 'assistant', content: cleanAiText },
                ]);

                if (transcript.length > 0 && transcript.length % 2 === 0) {
                    setScenarioStep(s => Math.min(s + 1, 4));
                }

                speak(cleanAiText);
            };
        } catch (err: any) {
            setError(err?.message || 'Wolfie teve um erro técnico ao falar com o servidor de IA.');
            setState('IDLE');
            setSubtitle('Aperte para tentar novamente.');
        }
    };

    const detectLanguage = (text: string): 'pt-BR' | 'en-US' => {
        const lower = text.toLowerCase();
        const hasAccents = /[áàâãéêíóôõúç]/i.test(text);
        const ptWords = /\b(você|olá|oi|tudo bem|qual|seu|sua|meu|minha|para|não|sim|obrigad[oa]|prática|prazer|hoje|aprender)\b/i.test(lower);
        return (hasAccents || ptWords) ? 'pt-BR' : 'en-US';
    };

    const NEURAL_EN = [
        'Microsoft Aria Online (Natural) - English (United States)',
        'Microsoft Jenny Online (Natural) - English (United States)',
        'Microsoft Ava Online (Natural) - English (United States)',
        'Microsoft Eddy (English (United States))',
        'Google US English',
        'Samantha',
        'Karen',
    ];
    const NEURAL_PT = [
        'Microsoft Francisca Online (Natural) - Portuguese (Brazil)',
        'Microsoft Antonio Online (Natural) - Portuguese (Brazil)',
        'Microsoft Thalita Online (Natural) - Portuguese (Brazil)',
        'Google português do Brasil',
        'Luciana',
    ];

    const pickBestVoice = (lang: 'en-US' | 'pt-BR'): SpeechSynthesisVoice | undefined => {
        const list = lang === 'en-US' ? NEURAL_EN : NEURAL_PT;
        const voices = window.speechSynthesis.getVoices();
        for (const name of list) {
            const v = voices.find(v => v.name === name);
            if (v) return v;
        }
        return voices.find(v => v.lang.startsWith(lang.slice(0, 2)));
    };

    const speak = (text: string) => {
        setState('SPEAKING');
        setSubtitle('');
        window.speechSynthesis.cancel();
        lastSpokenTextRef.current = text;

        const cleaned = text.trim();
        if (!cleaned) { setState('IDLE'); return; }

        const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
        const lastIndex = sentences.length - 1;

        sentences.forEach((s, i) => {
            const trimmed = s.trim();
            if (!trimmed) return;
            const lang = detectLanguage(trimmed);
            const u = new SpeechSynthesisUtterance(trimmed);
            const voice = pickBestVoice(lang);
            if (voice) u.voice = voice;
            u.lang = lang;
            u.rate = speakSlower ? 0.75 : (lang === 'pt-BR' ? 1.05 : 1.0);
            u.pitch = 1.0;

            if (i === 0) {
                u.onstart = () => setSubtitle(cleaned);
            }
            if (i === lastIndex) {
                u.onend = () => setState('IDLE');
                u.onerror = () => setState('IDLE');
            }

            window.speechSynthesis.speak(u);
        });
    };

    const stopSpeaking = () => {
        window.speechSynthesis.cancel();
    };

    const getOrbColor = () => {
        switch (state) {
            case 'IDLE': return 220;
            case 'LISTENING': return 0;
            case 'THINKING': return 280;
            case 'SPEAKING': return 180;
            default: return 220;
        }
    };

    const handleRepeatCorrection = () => {
        if (!activeCorrectionPopUp) return;

        const phrase = activeCorrectionPopUp.correctSentence;
        setActiveCorrectionPopUp(null);

        speak(`Repeat after me: ${phrase}`);
    };

    const handleAttemptClose = () => {
        stopSpeaking();
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
        setState('IDLE');
        setShowSummary(true);
    };

    const handleRealClose = async () => {
        const totalTurns = Math.floor(transcript.length / 2);
        const totalXP = (totalTurns * 5) + (corrections.length * 2);
        if (totalXP > 0) {
            try {
                const { data: currentProfile } = await supabase
                    .from('profiles')
                    .select('xp')
                    .eq('id', user.id)
                    .single();
                const currentXP = currentProfile?.xp || 0;
                await supabase
                    .from('profiles')
                    .update({ xp: currentXP + totalXP })
                    .eq('id', user.id);
            } catch (e) {
                console.error('Error saving XP:', e);
            }
        }
        onClose();
    };

    const getSessionDuration = () => {
        const diff = Math.floor((Date.now() - sessionStartRef.current) / 1000);
        const mins = Math.floor(diff / 60);
        const secs = diff % 60;
        return `${mins}min ${secs.toString().padStart(2, '0')}s`;
    };

    return (
        <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col font-sans overflow-hidden">
            {activeCorrectionPopUp && (
                <div className="absolute inset-0 z-[300] flex flex-col items-center justify-center p-6 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-slate-900 border-2 border-indigo-500 rounded-3xl w-full max-w-md shadow-2xl shadow-indigo-500/20 overflow-hidden flex flex-col animate-in slide-in-from-bottom-10 touch-none">
                        <div className="bg-indigo-500/10 p-5 border-b border-indigo-500/20 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <BookOpen className="text-indigo-400" size={24} />
                                <h3 className="text-white font-bold text-lg">Correção Rápida</h3>
                            </div>
                            <button
                                onClick={() => setActiveCorrectionPopUp(null)}
                                className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors text-white"
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <div className="p-6 space-y-6">
                            <div>
                                <p className="text-slate-300 text-sm leading-relaxed">
                                    {activeCorrectionPopUp.explanation}
                                </p>
                            </div>
                            <div className="space-y-4 bg-slate-950/50 p-4 rounded-2xl border border-white/5">
                                <div>
                                    <span className="text-[10px] font-bold text-red-400 uppercase tracking-widest block mb-1">Como você disse:</span>
                                    <p className="text-slate-400 font-medium line-through decoration-red-500/50">{activeCorrectionPopUp.wrongSentence}</p>
                                </div>
                                <div>
                                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest block mb-1">Forma mais natural:</span>
                                    <p className="text-white font-bold text-lg">{activeCorrectionPopUp.correctSentence}</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-6 pt-0 flex flex-col gap-3">
                            <button
                                onClick={handleRepeatCorrection}
                                className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-4 rounded-xl transition-colors shadow-lg shadow-indigo-600/20"
                            >
                                <Volume2 size={20} />
                                REPETIR EM VOZ ALTA
                            </button>
                            <button
                                onClick={() => setActiveCorrectionPopUp(null)}
                                className="w-full py-3 text-slate-400 hover:text-white font-bold text-sm transition-colors"
                            >
                                Fechar e Continuar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showSummary && (
                <div className="absolute inset-0 z-[300] flex flex-col items-center justify-center p-6 bg-slate-950/90 backdrop-blur-md animate-in fade-in">
                    <div className="bg-slate-900 border-2 border-emerald-500 rounded-3xl w-full max-w-md shadow-2xl shadow-emerald-500/20 overflow-hidden flex flex-col animate-in slide-in-from-bottom-10">
                        <div className="bg-emerald-500/10 p-6 border-b border-emerald-500/20 text-center">
                            <Trophy className="text-emerald-400 w-12 h-12 mx-auto mb-3" />
                            <h3 className="text-white font-black text-2xl">Sessão Concluída!</h3>
                            <p className="text-slate-400 text-sm mt-1">Veja como você foi:</p>
                        </div>
                        <div className="p-6 grid grid-cols-2 gap-4">
                            <div className="bg-slate-950/50 rounded-2xl p-4 border border-white/5 text-center">
                                <MessageSquare className="w-6 h-6 text-indigo-400 mx-auto mb-2" />
                                <p className="text-2xl font-black text-white">{Math.floor(transcript.length / 2)}</p>
                                <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">Turnos</p>
                            </div>
                            <div className="bg-slate-950/50 rounded-2xl p-4 border border-white/5 text-center">
                                <CheckCircle className="w-6 h-6 text-pink-400 mx-auto mb-2" />
                                <p className="text-2xl font-black text-white">{corrections.length}</p>
                                <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">Correções</p>
                            </div>
                            <div className="bg-slate-950/50 rounded-2xl p-4 border border-white/5 text-center">
                                <BookOpen className="w-6 h-6 text-amber-400 mx-auto mb-2" />
                                <p className="text-2xl font-black text-white">{vocabLearned}</p>
                                <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">Palavras Novas</p>
                            </div>
                            <div className="bg-slate-950/50 rounded-2xl p-4 border border-white/5 text-center">
                                <Clock className="w-6 h-6 text-cyan-400 mx-auto mb-2" />
                                <p className="text-2xl font-black text-white">{getSessionDuration()}</p>
                                <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">Tempo</p>
                            </div>
                        </div>
                        <div className="px-6 pb-2">
                            <div className="bg-gradient-to-r from-amber-500/20 to-amber-600/10 border border-amber-500/30 rounded-2xl p-4 flex items-center justify-center gap-3">
                                <Star className="w-8 h-8 text-amber-400" />
                                <div>
                                    <p className="text-amber-400 font-black text-2xl">+{(Math.floor(transcript.length / 2) * 5) + (corrections.length * 2)} XP</p>
                                    <p className="text-amber-400/60 text-xs font-bold uppercase tracking-wider">Experiência ganha</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-6 flex flex-col gap-3">
                            <button
                                onClick={() => setShowSummary(false)}
                                className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-4 rounded-xl transition-colors shadow-lg shadow-indigo-600/20"
                            >
                                <Mic size={20} />
                                Praticar mais
                            </button>
                            <button
                                onClick={handleRealClose}
                                className="w-full py-3 text-slate-400 hover:text-white font-bold text-sm transition-colors"
                            >
                                Encerrar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-slate-950"></div>

            <div className="relative z-10 flex flex-col h-full">
                <header className="flex items-center justify-between p-6 border-b border-white/5 bg-slate-950/50 backdrop-blur-md">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-900 rounded-full border border-white/10">
                            <span className="relative flex h-2.5 w-2.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                            </span>
                            <span className="text-xs font-bold text-slate-300 tracking-wider">LIVE</span>
                        </div>
                    </div>
                    <div className="text-center absolute left-1/2 -translate-x-1/2 hidden md:block">
                        <h2 className="text-lg font-black text-white tracking-wide">{missionTitle}</h2>
                        <p className="text-xs font-bold text-indigo-400 uppercase tracking-widest mt-1">Step {scenarioStep} of 4</p>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-slate-900 rounded-full border border-white/10">
                            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">{wolfieConfig.level}</span>
                            <div className="w-px h-3 bg-slate-700"></div>
                            <span className="text-xs font-bold text-slate-200 capitalize">{avatarId}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setSpeakSlower(p => !p)}
                                className={`p-2 rounded-full border transition-all ${speakSlower ? 'bg-amber-500/15 border-amber-500/30 text-amber-300' : 'bg-white/5 border-white/10 text-slate-500'}`}
                                title={speakSlower ? 'Velocidade: Devagar' : 'Velocidade: Normal'}
                            >
                                <Clock size={18} />
                            </button>
                            <button
                                onClick={() => speak(lastSpokenTextRef.current)}
                                disabled={!lastSpokenTextRef.current}
                                className="p-2 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30"
                                title="Repetir última frase"
                            >
                                <RefreshCw size={18} />
                            </button>
                        </div>
                        <div className="w-px h-6 bg-white/10 mx-2"></div>
                        <button onClick={handleAttemptClose} className="p-2 bg-white/5 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition-colors">
                            <X size={20} />
                        </button>
                    </div>
                </header>

                <main className="flex-1 flex flex-col lg:flex-row overflow-hidden">
                    <div className="flex-1 relative flex flex-col items-center justify-center p-8 lg:border-r border-white/5">
                        <div className="text-center md:hidden absolute top-6 w-full px-6">
                            <h2 className="text-lg font-black text-white tracking-wide">{missionTitle}</h2>
                            <p className="text-xs font-bold text-indigo-400 uppercase tracking-widest mt-1">Step {scenarioStep} of 4</p>
                        </div>
                        <div className="w-[280px] h-[280px] md:w-[400px] md:h-[400px] relative mt-10 lg:mt-0">
                            <VoicePoweredOrb
                                hue={getOrbColor()}
                                audioStream={audioStreamReady}
                                className="w-full h-full scale-125"
                                maxHoverIntensity={state === 'SPEAKING' ? 1.5 : 0.8}
                                maxRotationSpeed={state === 'THINKING' ? 3.0 : 1.2}
                            />
                        </div>
                        <div className="absolute bottom-12 w-full max-w-2xl px-6 text-center">
                            {error && (
                                <div className="inline-block px-4 py-2 bg-red-500/10 border border-red-500/20 text-red-500 rounded-xl text-sm font-bold mb-4">
                                    {error}
                                </div>
                            )}
                            <div className={`p-6 rounded-3xl backdrop-blur-md transition-all duration-300 ${state === 'SPEAKING' ? 'bg-slate-900/80 border border-white/10 shadow-2xl scale-100' : 'bg-transparent scale-95 opacity-50'}`}>
                                <p className="text-2xl md:text-3xl font-medium text-white leading-relaxed">
                                    {subtitle}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="w-full lg:w-[450px] bg-slate-950/50 flex flex-col border-t lg:border-t-0 border-white/5">
                        <div className="flex px-4 pt-4 border-b border-white/5 gap-2">
                            <button
                                onClick={() => setActiveTab('TRANSCRIPT')}
                                className={`flex-1 pb-3 text-sm font-bold tracking-wider uppercase transition-colors border-b-2 ${activeTab === 'TRANSCRIPT' ? 'text-white border-indigo-500' : 'text-slate-500 border-transparent hover:text-slate-300'}`}
                            >
                                Transcript
                            </button>
                            <button
                                onClick={() => setActiveTab('CORRECTIONS')}
                                className={`flex-1 pb-3 text-sm font-bold tracking-wider uppercase transition-colors border-b-2 relative ${activeTab === 'CORRECTIONS' ? 'text-white border-indigo-500' : 'text-slate-500 border-transparent hover:text-slate-300'}`}
                            >
                                Corrections
                                {corrections.length > 0 && (
                                    <span className="absolute top-0 right-4 w-2 h-2 bg-pink-500 rounded-full animate-ping"></span>
                                )}
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
                            {activeTab === 'TRANSCRIPT' && (
                                <div className="space-y-6">
                                    {transcript.length === 0 ? (
                                        <div className="h-full flex flex-col items-center justify-center text-slate-500">
                                            <MessageSquare size={48} className="opacity-20 mb-4" />
                                            <p className="text-center font-medium">A conversa aparecerá aqui.</p>
                                        </div>
                                    ) : (
                                        transcript.map((msg, i) => (
                                            <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                                                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 ml-2 mr-2">
                                                    {msg.role === 'user' ? 'You' : avatarId}
                                                </span>
                                                <div className={`p-4 rounded-2xl max-w-[85%] ${msg.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-slate-800 text-slate-200 rounded-tl-sm'}`}>
                                                    {msg.content}
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}

                            {activeTab === 'CORRECTIONS' && (
                                <div className="space-y-4">
                                    {corrections.length === 0 ? (
                                        <div className="h-full flex flex-col items-center justify-center text-slate-500 mt-10">
                                            <Sparkles size={48} className="opacity-20 mb-4" />
                                            <p className="text-center font-medium">Você está indo super bem!<br />Ainda não há correções estruturais.</p>
                                        </div>
                                    ) : (
                                        corrections.map((corr) => (
                                            <div key={corr.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg animate-in fade-in slide-in-from-right-4">
                                                <div className="flex items-start gap-3 mb-3">
                                                    <div className="p-1.5 bg-red-500/10 text-red-400 rounded-lg shrink-0 mt-0.5"><X size={16} /></div>
                                                    <p className="text-slate-400 line-through decoration-red-500/50">{corr.wrongSentence}</p>
                                                </div>
                                                <div className="flex items-start gap-3 mb-4">
                                                    <div className="p-1.5 bg-emerald-500/10 text-emerald-400 rounded-lg shrink-0 mt-0.5"><CheckCircle2 size={16} /></div>
                                                    <p className="text-white font-medium">{corr.correctSentence}</p>
                                                </div>
                                                <div className="mt-4 pt-4 border-t border-slate-800">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <AlertCircle size={14} className="text-indigo-400" />
                                                        <span className="text-[11px] font-bold text-indigo-400 uppercase tracking-widest">Explicação</span>
                                                    </div>
                                                    <p className="text-sm text-slate-300 leading-relaxed">{corr.explanation}</p>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </main>

                {/* BOTTOM ACTION BAR — Mute toggle (VAD handles recording) */}
                <footer className="p-6 border-t border-white/5 bg-slate-950 flex flex-col items-center justify-center pb-8 lg:pb-6 gap-3">
                    <button
                        onClick={() => setIsMuted(m => !m)}
                        className={`relative group overflow-hidden flex items-center justify-center gap-4 w-20 h-20 rounded-full font-black transition-all duration-300 select-none
                            ${isMuted ? 'bg-red-500/20 border-2 border-red-500/40 text-red-400 hover:bg-red-500/30' :
                                state === 'LISTENING' ? 'bg-indigo-500 scale-110 shadow-[0_0_40px_rgba(99,102,241,0.5)] text-white' :
                                    'bg-indigo-600/20 border-2 border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/30'}
                        `}
                    >
                        {state === 'LISTENING' && !isMuted && (
                            <span className="absolute inset-0 border-4 border-white/20 rounded-full animate-ping pointer-events-none"></span>
                        )}
                        {isMuted ? <MicOff size={28} /> : <Mic size={28} />}
                    </button>
                    <span className="text-[11px] text-slate-500 font-bold uppercase tracking-widest">
                        {isMuted ? 'Microfone desligado' :
                            state === 'LISTENING' ? 'Ouvindo...' :
                            state === 'THINKING' ? 'Processando...' :
                            state === 'SPEAKING' ? 'Wolfie falando' :
                            'Aguardando sua voz'}
                    </span>
                </footer>
            </div>

        </div>
    );
}

// Icon fallbacks if not imported
const CheckCircle2 = ({ className, size }: { className?: string, size?: number }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size || 24} height={size || 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" /><path d="m9 12 2 2 4-4" /></svg>
);
