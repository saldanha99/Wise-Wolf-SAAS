import React, { useState, useRef, useEffect } from 'react';
import { X, Mic, StopCircle, RefreshCw, MessageSquare, AlertCircle, Sparkles, Zap, BookOpen, Volume2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { VoicePoweredOrb } from './VoicePoweredOrb';

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
    // Pronunciation score retornado pelo backend (Phase 2 - Gemini Audio)
    const [pronunciation, setPronunciation] = useState<null | { score: number; level: string; issues: string[]; tip_pt: string }>(null);
    const [pronHistory, setPronHistory] = useState<{ score: number; level: string; ts: number }[]>([]);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
    const recognitionRef = useRef<any>(null);
    const finalTranscriptRef = useRef<string>('');

    // Format Scenario Title
    const missionTitle = scenarioId.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    // Init Audio & Speech Recognition
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
                    if (event.data.size > 0) {
                        currentChunks.push(event.data);
                    }
                };
                mediaRecorderRef.current = mediaRecorder;
            } catch (err) {
                console.error("Microphone access denied:", err);
                alert("Permissão de microfone necessária.");
                onClose();
            }
        };

        const initSpeechRecognition = () => {
            // @ts-ignore
            const windowEl = window as any;
            const SpeechRecognition = windowEl.SpeechRecognition || windowEl.webkitSpeechRecognition;
            if (SpeechRecognition) {
                const recognition = new SpeechRecognition();
                recognition.continuous = true;
                recognition.interimResults = true;
                recognition.lang = 'pt-BR'; // Force Portuguese BR so it doesn't butcher the user's native language

                recognition.onresult = (event: any) => {
                    let interimTranscript = '';
                    let finalTranscript = '';

                    for (let i = event.resultIndex; i < event.results.length; ++i) {
                        if (event.results[i].isFinal) {
                            finalTranscript += event.results[i][0].transcript;
                        } else {
                            interimTranscript += event.results[i][0].transcript;
                        }
                    }
                    if (finalTranscript) {
                        finalTranscriptRef.current += finalTranscript + ' ';
                    }
                };

                recognition.onerror = (event: any) => {
                    console.error("Speech recognition error", event.error);
                };

                recognitionRef.current = recognition;
            }
        };

        const currentChunks: Blob[] = [];
        audioChunksRef.current = currentChunks;

        initAudio();
        initSpeechRecognition();

        return () => {
            stopSpeaking();
        };
    }, []);

    // Cleanup Stream
    useEffect(() => {
        return () => {
            if (audioStream) {
                audioStream.getTracks().forEach(track => track.stop());
            }
        };
    }, [audioStream]);

    const startRecording = () => {
        if (state === 'SPEAKING' || state === 'THINKING' || activeCorrectionPopUp) return;
        if (!mediaRecorderRef.current) return;

        audioChunksRef.current = [];
        finalTranscriptRef.current = ''; // Reset transcript

        mediaRecorderRef.current.start();
        if (recognitionRef.current) {
            try {
                recognitionRef.current.start();
            } catch (e) { console.error(e) }
        }

        setState('LISTENING');
        setSubtitle('Ouvindo...');
        setError(null);
    };

    const stopRecordingAndSend = () => {
        if (state !== 'LISTENING' || !mediaRecorderRef.current) return;

        mediaRecorderRef.current.stop();
        if (recognitionRef.current) {
            try {
                recognitionRef.current.stop();
            } catch (e) { console.error(e) }
        }

        setState('THINKING');
        setSubtitle('Hmm, let me think...');

        setTimeout(() => {
            const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
            processAudio(audioBlob);
        }, 300); // Increased slightly to give ASR time to finalize
    };

    const processAudio = async (audioBlob: Blob) => {
        try {
            if (audioBlob.size > 5 * 1024 * 1024) throw new Error("Áudio muito longo.");

            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = async () => {
                const base64String = reader.result as string;
                const contextList = transcript.slice(-4).map(m => `${m.role === 'user' ? 'Student' : 'Wolfie'}: ${m.content}`);
                const previousContext = contextList.join('\n');
                const userText = finalTranscriptRef.current.trim();

                const payload = {
                    message: userText,
                    audioBase64: base64String, // Re-enabled to allow Gemini to hear the real English pronunciation instead of relying solely on the buggy PT-centric browser STT
                    studentLevel: wolfieConfig?.level || 'A1',
                    topic: scenarioId,
                    mode: wolfieConfig?.goal === 'Fluency' ? 'fluency' : 'grammar_focus',
                    correctionStrictness: wolfieConfig?.correctionStrictness || 2,
                    previousContext: previousContext,
                    conversationId: `${user.id}-${scenarioId}-${Date.now()}` // Simplify session tracking for now
                };

                // Timeout de 25s para evitar travamento indefinido (M6 - Wolfie crash fix)
                const invokePromise = supabase.functions.invoke('wolfie-brain', { body: payload });
                const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Tempo de resposta excedido (25s). Tente novamente.')), 25000)
                );
                const { data, error: supabaseError } = await Promise.race([invokePromise, timeoutPromise]);

                if (supabaseError) throw supabaseError;
                if (data.error) throw new Error(data.error);

                const cleanAiText = data.aiText || '';

                // Estruturado direto do backend (substitui o regex parsing antigo)
                if (data.correction && data.correction.original) {
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

                // Pronuncia (Phase 2): score + tip
                if (data.pronunciation && typeof data.pronunciation.score === 'number') {
                    setPronunciation(data.pronunciation);
                    setPronHistory(prev => [...prev, {
                        score: data.pronunciation.score,
                        level: data.pronunciation.level,
                        ts: Date.now()
                    }].slice(-20));
                }

                // Prefere a transcricao do Gemini (que ouve o ingles real) se houver
                const userDisplayText = data.transcribedText || userText || '[Mensagem de Áudio]';

                setTranscript(prev => [
                    ...prev,
                    { role: 'user', content: userDisplayText },
                    { role: 'assistant', content: cleanAiText }
                ]);

                // Update scenario step (simple progression mock)
                if (transcript.length > 0 && transcript.length % 2 === 0) {
                    setScenarioStep(s => Math.min(s + 1, 4));
                }

                speak(cleanAiText);
            };

        } catch (err: any) {
            console.error("Call Error:", err);
            setError(err?.message || 'Wolfie teve um erro técnico ao falar com o servidor de IA. Tente novamente em alguns segundos.');
            setState('IDLE');
            setSubtitle('Aperte para tentar novamente.');
        }
    };

    const speak = (text: string) => {
        setState('SPEAKING');
        setSubtitle('');
        window.speechSynthesis.cancel(); // Clear queue

        // Text is expected to be strictly 2 blocks now: [PT Block] \n [EN Block]
        const blocks = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        if (blocks.length === 0) {
            setState('IDLE');
            return;
        }

        const voices = window.speechSynthesis.getVoices();
        const enVoice = voices.find(v => v.lang === 'en-US' && v.name.includes('Natural'))
            || voices.find(v => v.lang.includes('en') && v.name.includes('Aria'))
            || voices.find(v => v.lang.includes('en') && v.name.includes('Jenny'))
            || voices.find(v => v.name.includes('Google US English'))
            || voices.find(v => v.lang.startsWith('en'));

        // Prioridade atualizada: 1. MS Natural, 2. MS Online, 3. Google, 4. Qualquer PT (que não seja a da Maria antiga)
        const ptVoice = voices.find(v => v.lang === 'pt-BR' && v.name.includes('Natural'))
            || voices.find(v => v.lang === 'pt-BR' && v.name.includes('Online'))
            || voices.find(v => v.lang === 'pt-BR' && v.name.includes('Google português'))
            || voices.find(v => v.lang.startsWith('pt') && !v.name.includes('Maria'))
            || voices.find(v => v.lang.startsWith('pt'));

        const speakChunk = (chunkIndex: number) => {
            if (chunkIndex >= blocks.length) {
                setState('IDLE');
                return;
            }

            const chunkText = blocks[chunkIndex];
            setSubtitle(chunkText);

            const utterance = new SpeechSynthesisUtterance(chunkText);

            // According to our new strict prompt, the first block (index 0) is always PT-BR.
            // The subsequent blocks are always EN-US.
            if (chunkIndex === 0 && blocks.length > 1) { // Only PT if there's more than 1 block, otherwise assume EN
                utterance.lang = 'pt-BR';
                if (ptVoice) utterance.voice = ptVoice;
                utterance.rate = 1.05; // Velocidade natural e confortável (1.35 distorce a voz e a faz parecer velha)
                utterance.pitch = 1.0;
            } else {
                utterance.lang = 'en-US';
                if (enVoice) utterance.voice = enVoice;
                utterance.rate = 1.0;
                utterance.pitch = 1.0;
            }

            utterance.onend = () => {
                speakChunk(chunkIndex + 1);
            };

            utterance.onerror = (e) => {
                console.error("TTS Error processing chunk:", e);
                speakChunk(chunkIndex + 1);
            };

            window.speechSynthesis.speak(utterance);
        };

        speakChunk(0);
    };

    const stopSpeaking = () => {
        window.speechSynthesis.cancel();
    };

    const getOrbColor = () => {
        switch (state) {
            case 'IDLE': return 220; // Blue
            case 'LISTENING': return 0; // Red
            case 'THINKING': return 280; // Purple
            case 'SPEAKING': return 180; // Cyan
            default: return 220;
        }
    };

    const handleRepeatCorrection = () => {
        if (!activeCorrectionPopUp) return;

        const phrase = activeCorrectionPopUp.correctSentence;
        setActiveCorrectionPopUp(null);

        // Send as a single block so the `speak` function uses EN-US voice
        speak(`Repeat after me: ${phrase}`);
    };

    return (
        <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col font-sans overflow-hidden">
            {/* CORRECTION POP-UP MODAL */}
            {activeCorrectionPopUp && (
                <div className="absolute inset-0 z-[300] flex flex-col items-center justify-center p-6 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-brand-surface border-2 border-indigo-500 rounded-3xl w-full max-w-md shadow-2xl shadow-indigo-500/20 overflow-hidden flex flex-col animate-in slide-in-from-bottom-10 touch-none">
                        {/* Header */}
                        <div className="bg-indigo-500/10 p-5 border-b border-indigo-500/20 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <BookOpen className="text-indigo-400" size={24} />
                                <h3 className="text-white font-bold text-lg">Correção Rápida</h3>
                            </div>
                            <button
                                onClick={() => setActiveCorrectionPopUp(null)}
                                className="p-2 bg-brand-surface/5 hover:bg-brand-surface/10 rounded-full transition-colors text-white"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="p-6 space-y-6">
                            <div>
                                <p className="text-slate-300 text-sm leading-relaxed">
                                    {activeCorrectionPopUp.explanation}
                                </p>
                            </div>

                            <div className="space-y-4 bg-slate-950/50 p-4 rounded-2xl border border-white/5">
                                <div>
                                    <span className="text-[10px] font-bold text-red-400 uppercase tracking-widest block mb-1">Como você disse:</span>
                                    <p className="text-brand-muted font-medium line-through decoration-red-500/50">{activeCorrectionPopUp.wrongSentence}</p>
                                </div>

                                <div>
                                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest block mb-1">Forma mais natural:</span>
                                    <p className="text-white font-bold text-lg">{activeCorrectionPopUp.correctSentence}</p>
                                </div>
                            </div>
                        </div>

                        {/* Actions */}
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
                                className="w-full py-3 text-brand-muted hover:text-white font-bold text-sm transition-colors"
                            >
                                Fechar e Continuar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Dynamic Background */}
            <div className={`absolute inset-0 transition-colors duration-1000 ${state === 'LISTENING' ? 'bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-indigo-900/30 via-slate-950 to-slate-950' :
                state === 'SPEAKING' ? 'bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-cyan-900/20 via-slate-950 to-slate-950' :
                    'bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-slate-950'
                }`}></div>

            <div className="relative z-10 flex flex-col h-full">
                {/* TOP BAR */}
                <header className="flex items-center justify-between p-6 border-b border-white/5 bg-slate-950/50 backdrop-blur-md">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-brand-surface rounded-full border border-white/10">
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
                        <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-brand-surface rounded-full border border-white/10">
                            <span className="text-xs font-bold text-brand-muted uppercase tracking-wider">{wolfieConfig.level}</span>
                            <div className="w-px h-3 bg-slate-700"></div>
                            <span className="text-xs font-bold text-slate-200 capitalize">{avatarId}</span>
                        </div>
                        <button onClick={onClose} className="p-2 bg-brand-surface/5 hover:bg-brand-surface/10 rounded-full text-brand-muted hover:text-white transition-colors">
                            <X size={20} />
                        </button>
                    </div>
                </header>

                {/* MAIN SPLIT VIEW */}
                <main className="flex-1 flex flex-col lg:flex-row overflow-hidden">

                    {/* LEFT: VISUAL ORB & SUBTITLES */}
                    <div className="flex-1 relative flex flex-col items-center justify-center p-4 sm:p-8 lg:border-r border-white/5 min-h-[60vh] lg:min-h-0">

                        {/* Mobile Header (fallback when center is hidden) */}
                        <div className="text-center md:hidden absolute top-4 w-full px-4">
                            <h2 className="text-base font-black text-white tracking-wide">{missionTitle}</h2>
                            <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest mt-0.5">Step {scenarioStep} of 4</p>
                        </div>

                        {/* Orb */}
                        <div className="w-[220px] h-[220px] sm:w-[280px] sm:h-[280px] md:w-[400px] md:h-[400px] relative mt-12 lg:mt-0">
                            <VoicePoweredOrb
                                hue={getOrbColor()}
                                audioStream={audioStream}
                                className="w-full h-full scale-125"
                                maxHoverIntensity={state === 'SPEAKING' ? 1.5 : 0.8}
                                maxRotationSpeed={state === 'THINKING' ? 3.0 : 1.2}
                            />
                        </div>

                        {/* Active Subtitle */}
                        <div className="absolute bottom-6 sm:bottom-12 w-full max-w-2xl px-4 sm:px-6 text-center">
                            {error && (
                                <div className="inline-block px-4 py-2 bg-red-500/10 border border-red-500/20 text-red-500 rounded-xl text-xs sm:text-sm font-bold mb-3">
                                    {error}
                                </div>
                            )}
                            <div className={`p-4 sm:p-6 rounded-3xl backdrop-blur-md transition-all duration-300 ${state === 'SPEAKING' ? 'bg-brand-surface/80 border border-white/10 shadow-2xl scale-100' : 'bg-transparent scale-95 opacity-50'}`}>
                                <p className="text-base sm:text-2xl md:text-3xl font-medium text-white leading-relaxed">
                                    {subtitle}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* RIGHT: SIDEBAR (Transcript & Corrections) */}
                    <div className="w-full lg:w-[450px] bg-slate-950/50 flex flex-col border-t lg:border-t-0 border-white/5">
                        {/* Pronunciation Banner (Phase 2 - Gemini Audio) */}
                        {pronunciation && (
                            <div className={`px-4 py-3 border-b border-white/5 ${
                                pronunciation.level === 'EXCELLENT' ? 'bg-emerald-500/10' :
                                pronunciation.level === 'GOOD' ? 'bg-blue-500/10' :
                                pronunciation.level === 'FAIR' ? 'bg-amber-500/10' :
                                'bg-rose-500/10'
                            }`}>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-3">
                                        <div className={`text-2xl font-black ${
                                            pronunciation.level === 'EXCELLENT' ? 'text-emerald-400' :
                                            pronunciation.level === 'GOOD' ? 'text-blue-400' :
                                            pronunciation.level === 'FAIR' ? 'text-amber-400' :
                                            'text-rose-400'
                                        }`}>{pronunciation.score}</div>
                                        <div>
                                            <p className="text-[10px] uppercase tracking-widest text-brand-muted font-bold">Pronuncia</p>
                                            <p className="text-xs font-bold text-white">{pronunciation.level}</p>
                                        </div>
                                    </div>
                                    {pronHistory.length > 1 && (
                                        <div className="text-[10px] text-brand-muted">
                                            Média: <span className="text-white font-bold">{Math.round(pronHistory.reduce((s, p) => s + p.score, 0) / pronHistory.length)}</span>
                                        </div>
                                    )}
                                </div>
                                {pronunciation.tip_pt && (
                                    <p className="text-xs text-slate-300 mt-2 leading-relaxed">💡 {pronunciation.tip_pt}</p>
                                )}
                                {pronunciation.issues && pronunciation.issues.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 mt-2">
                                        {pronunciation.issues.map((iss, i) => (
                                            <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-slate-300">{iss}</span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Tabs */}
                        <div className="flex px-4 pt-4 border-b border-white/5 gap-2">
                            <button
                                onClick={() => setActiveTab('TRANSCRIPT')}
                                className={`flex-1 pb-3 text-sm font-bold tracking-wider uppercase transition-colors border-b-2 ${activeTab === 'TRANSCRIPT' ? 'text-white border-indigo-500' : 'text-brand-muted border-transparent hover:text-slate-300'}`}
                            >
                                Transcript
                            </button>
                            <button
                                onClick={() => setActiveTab('CORRECTIONS')}
                                className={`flex-1 pb-3 text-sm font-bold tracking-wider uppercase transition-colors border-b-2 relative ${activeTab === 'CORRECTIONS' ? 'text-white border-indigo-500' : 'text-brand-muted border-transparent hover:text-slate-300'}`}
                            >
                                Corrections
                                {corrections.length > 0 && (
                                    <span className="absolute top-0 right-4 w-2 h-2 bg-pink-500 rounded-full animate-ping"></span>
                                )}
                            </button>
                        </div>

                        {/* Tab Content */}
                        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
                            {activeTab === 'TRANSCRIPT' && (
                                <div className="space-y-6">
                                    {transcript.length === 0 ? (
                                        <div className="h-full flex flex-col items-center justify-center text-brand-muted">
                                            <MessageSquare size={48} className="opacity-20 mb-4" />
                                            <p className="text-center font-medium">A conversa aparecerá aqui.</p>
                                        </div>
                                    ) : (
                                        transcript.map((msg, i) => (
                                            <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                                                <span className="text-[10px] font-bold text-brand-muted uppercase tracking-widest mb-1.5 ml-2 mr-2">
                                                    {msg.role === 'user' ? 'You' : avatarId}
                                                </span>
                                                <div className={`p-4 rounded-2xl max-w-[85%] ${msg.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-brand-surface-2 text-slate-200 rounded-tl-sm'}`}>
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
                                        <div className="h-full flex flex-col items-center justify-center text-brand-muted mt-10">
                                            <Sparkles size={48} className="opacity-20 mb-4" />
                                            <p className="text-center font-medium">Você está indo super bem!<br />Ainda não há correções estruturais.</p>
                                        </div>
                                    ) : (
                                        corrections.map((corr) => (
                                            <div key={corr.id} className="bg-brand-surface border border-brand-border rounded-2xl p-5 shadow-lg animate-in fade-in slide-in-from-right-4">
                                                <div className="flex items-start gap-3 mb-3">
                                                    <div className="p-1.5 bg-red-500/10 text-red-400 rounded-lg shrink-0 mt-0.5"><X size={16} /></div>
                                                    <p className="text-brand-muted line-through decoration-red-500/50">{corr.wrongSentence}</p>
                                                </div>
                                                <div className="flex items-start gap-3 mb-4">
                                                    <div className="p-1.5 bg-emerald-500/10 text-emerald-400 rounded-lg shrink-0 mt-0.5"><CheckCircle2 size={16} /></div>
                                                    <p className="text-white font-medium">{corr.correctSentence}</p>
                                                </div>
                                                <div className="mt-4 pt-4 border-t border-brand-border">
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

                {/* BOTTOM ACTION BAR */}
                <footer className="p-6 border-t border-white/5 bg-slate-950 flex justify-center pb-8 lg:pb-6">
                    <button
                        onMouseDown={startRecording}
                        onMouseUp={stopRecordingAndSend}
                        onTouchStart={startRecording}
                        onTouchEnd={stopRecordingAndSend}
                        disabled={state === 'SPEAKING' || state === 'THINKING' || !!activeCorrectionPopUp}
                        className={`relative group overflow-hidden flex items-center justify-center gap-4 px-10 py-5 rounded-full font-black uppercase tracking-widest transition-all duration-300 select-none
                            ${(state === 'SPEAKING' || state === 'THINKING' || !!activeCorrectionPopUp) ? 'bg-brand-surface-2 text-brand-muted cursor-not-allowed border border-white/5' :
                                state === 'LISTENING' ? 'bg-indigo-500 scale-105 shadow-[0_0_40px_rgba(99,102,241,0.5)] text-white' :
                                    'bg-indigo-600 hover:bg-indigo-500 text-white shadow-xl hover:shadow-2xl hover:-translate-y-1'}
                        `}
                    >
                        {state === 'LISTENING' && (
                            <span className="absolute inset-0 border-4 border-white/20 rounded-full animate-ping pointer-events-none"></span>
                        )}

                        {state === 'IDLE' && <Mic size={24} />}
                        {state === 'LISTENING' && <StopCircle size={24} className="animate-pulse" />}
                        {state === 'THINKING' && <RefreshCw size={24} className="animate-spin text-brand-muted" />}
                        {state === 'SPEAKING' && <Zap size={24} className="opacity-50" />}

                        <span>
                            {state === 'IDLE' ? 'Segure para Falar' : state === 'LISTENING' ? 'Solte para Enviar' : state === 'THINKING' ? 'Processando' : 'Wolfie Falando'}
                        </span>
                    </button>

                    {/* Instructions hint */}
                    {state === 'IDLE' && (
                        <div className="absolute bottom-2 text-center w-full pointer-events-none">
                            <span className="text-[10px] text-brand-muted font-medium uppercase tracking-widest">Push and hold to speak</span>
                        </div>
                    )}
                </footer>
            </div>

        </div>
    );
}

// Icon fallbacks if not imported
const CheckCircle2 = ({ className, size }: { className?: string, size?: number }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size || 24} height={size || 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" /><path d="m9 12 2 2 4-4" /></svg>
);
