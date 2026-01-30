import React, { useState, useRef, useEffect } from 'react';
import { X, Zap, CheckCircle2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { VoicePoweredOrb } from './VoicePoweredOrb';

interface WolfieLiveCallProps {
    user: any;
    topic?: string;
    onClose: () => void;
}

type CallState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

interface CorrectionData {
    explanation: string;
    solution: string;
}

const WolfieLiveCall: React.FC<WolfieLiveCallProps> = ({ user, topic = "Free Conversation", onClose }) => {
    const [state, setState] = useState<CallState>('IDLE');
    const [correction, setCorrection] = useState<CorrectionData | null>(null);
    const [subtitle, setSubtitle] = useState<string>('');
    const [messages, setMessages] = useState<{ role: string, content: string }[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [isVoiceDetected, setIsVoiceDetected] = useState(false);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const [audioStream, setAudioStream] = useState<MediaStream | null>(null);

    // Initialize Audio connection
    useEffect(() => {
        const initAudio = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                setAudioStream(stream);

                // We only need recorder when we actually record
                const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? { mimeType: 'audio/webm;codecs=opus' }
                    : { mimeType: 'audio/webm' };

                const mediaRecorder = new MediaRecorder(stream, options);
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        audioChunksRef.current.push(event.data);
                    }
                };
                mediaRecorderRef.current = mediaRecorder;

            } catch (err) {
                console.error("Microphone access denied:", err);
                alert("Permissão de microfone necessária.");
                onClose();
            }
        };

        initAudio();

        return () => {
            // Cleanup provided in audioStream effect or here if needed,
            // but we need to stop tracks on unmount.
            // Since we don't have the ref locally in cleanup scope easily without ref,
            // we will let the state update handle it or use a separate ref for cleanup if needed.
            // Actually, we can just clean up 'audioStream' tracks if we had access,
            // but in useEffect cleanup 'audioStream' is stale (null).
            // We should use a Ref just for cleanup or the cleanup function of the Init effect.
            // Wait, we can't access 'stream' var here.

            // Allow Orb to handle cleanup? No, we own the stream.
            stopSpeaking();
        };
    }, []);

    // Cleanup Effect
    useEffect(() => {
        return () => {
            if (audioStream) {
                audioStream.getTracks().forEach(track => track.stop());
            }
        };
    }, [audioStream]);

    const startRecording = () => {
        // Prevent recording if we are speaking
        if (state === 'SPEAKING' || state === 'THINKING') return;
        if (!mediaRecorderRef.current) return;

        audioChunksRef.current = [];
        mediaRecorderRef.current.start();
        setState('LISTENING');
        setCorrection(null);
        setSubtitle('');
        setError(null);
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

    const processAudio = async (audioBlob: Blob) => {
        try {
            if (audioBlob.size > 5 * 1024 * 1024) {
                throw new Error("Audio too long (Max 5MB). Please be brief.");
            }

            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);

            reader.onloadend = async () => {
                const base64String = reader.result as string;
                const context = messages.slice(-4).map(m => `${m.role === 'user' ? 'Student' : 'Wolfie'}: ${m.content}`).join('\n');

                const { data, error: supabaseError } = await supabase.functions.invoke('wolfie-brain', {
                    body: {
                        audioBase64: base64String,
                        studentLevel: user.levelBadge || 'A1',
                        previousContext: context,
                        topic: topic
                    }
                });

                if (supabaseError) throw supabaseError;
                if (data.error) throw new Error(data.error);

                const aiText = data.aiText;

                setMessages(prev => [
                    ...prev,
                    { role: 'user', content: '[Audio Message]' },
                    { role: 'assistant', content: aiText }
                ]);

                // Correction Parsing
                const correctionMatch = aiText.match(/\[Correction: (.*?)\] \/ (.*?)(\.|$)/);
                const simpleCorrectionMatch = !correctionMatch ? aiText.match(/\[Correction: (.*?)\]/) : null;

                let textToSpeak = aiText;
                textToSpeak = textToSpeak.replace(/\[Correction: .*?\] \/ .*?(\.|$)/, '');
                textToSpeak = textToSpeak.replace(/\[Correction: .*?\]/, '');

                if (correctionMatch) {
                    setCorrection({
                        explanation: correctionMatch[1],
                        solution: correctionMatch[2]
                    });
                } else if (simpleCorrectionMatch) {
                    setCorrection({
                        explanation: simpleCorrectionMatch[1],
                        solution: "Listen to the correct phrase..."
                    });
                }

                speak(textToSpeak.trim());
            };

        } catch (err: any) {
            console.error("Live Call Error:", err);
            setError("Connection Error: " + (err.message || "Try again"));
            setState('IDLE');
        }
    };

    const speak = (text: string) => {
        setState('SPEAKING');
        setSubtitle(text);

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'en-US';
        utterance.rate = 1.0;

        const voices = window.speechSynthesis.getVoices();
        const preferredVoice = voices.find(v => v.name.includes('Google US English')) || voices.find(v => v.lang === 'en-US');
        if (preferredVoice) utterance.voice = preferredVoice;

        utterance.onend = () => setState('IDLE');
        utterance.onerror = () => setState('IDLE');

        window.speechSynthesis.speak(utterance);
    };

    const stopSpeaking = () => {
        window.speechSynthesis.cancel();
    };

    const getStatusText = () => {
        switch (state) {
            case 'IDLE': return 'SEGURE PARA FALAR';
            case 'LISTENING': return 'OUVINDO...';
            case 'THINKING': return 'PROCESSANDO...';
            case 'SPEAKING': return 'WOLFIE FALANDO...';
        }
    };

    // Derived visual state for the Orb
    // We can change hue based on state
    // IDLE: Blue (200), LISTENING: Red (0/360), THINKING: Purple (280), SPEAKING: Cyan (180)
    const getOrbHue = () => {
        switch (state) {
            case 'IDLE': return 220; // Blue
            case 'LISTENING': return 0;   // Red
            case 'THINKING': return 280; // Purple
            case 'SPEAKING': return 180; // Cyan
        }
    };

    return (
        <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col items-center justify-center overflow-hidden font-sans">

            {/* Background Effects */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-950 to-slate-950"></div>

            {/* Close Button */}
            <button
                onClick={onClose}
                className="absolute top-6 right-6 p-3 rounded-full bg-slate-800/50 text-slate-400 hover:bg-slate-700/50 hover:text-white transition-all z-50 backdrop-blur-md border border-white/5"
            >
                <X size={24} />
            </button>

            {/* HEADER */}
            <div className="absolute top-12 flex flex-col items-center z-10 space-y-2 pointer-events-none">
                <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 backdrop-blur-sm">
                    <div className={`w-2 h-2 rounded-full ${state === 'LISTENING' ? 'bg-red-500 animate-pulse' : 'bg-indigo-400'}`} />
                    <span className="text-xs font-bold text-indigo-300 tracking-widest uppercase">Live Voice Channel</span>
                </div>
            </div>

            {/* ERROR FEEDBACK */}
            {error && (
                <div className="absolute top-24 z-50 animate-in slide-in-from-top-4 fade-in duration-300">
                    <div className="bg-red-500/10 backdrop-blur-md border border-red-500/50 text-red-200 px-6 py-3 rounded-full flex items-center gap-3 shadow-[0_0_30px_rgba(239,68,68,0.3)]">
                        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-xs font-bold tracking-widest uppercase">{error}</span>
                    </div>
                </div>
            )}

            {/* MAIN INTERACTION AREA */}
            <div className="relative z-20 flex flex-col items-center justify-center w-full h-full max-w-4xl">

                {/* THE ORB - Centerpiece */}
                <div
                    className="relative w-[500px] h-[500px] cursor-pointer touch-none flex items-center justify-center"
                    onMouseDown={startRecording}
                    onMouseUp={stopRecordingAndSend}
                    onTouchStart={(e) => { e.preventDefault(); startRecording(); }}
                    onTouchEnd={(e) => { e.preventDefault(); stopRecordingAndSend(); }}
                >
                    <VoicePoweredOrb
                        hue={getOrbHue()}
                        audioStream={audioStream}  // PASS REACTIVE STATE!
                        voiceSensitivity={2.0}
                        maxRotationSpeed={1.5}
                        maxHoverIntensity={1.0}
                        onVoiceDetected={setIsVoiceDetected}
                    />

                    {/* Status Text Overlay (Optional, maybe below is better) */}
                </div>

                {/* Subtitles */}
                <div className="absolute bottom-40 left-0 right-0 px-8 text-center pointer-events-none z-30 min-h-[80px]">
                    {subtitle && (
                        <p className="text-xl md:text-2xl font-serif italic text-indigo-100 drop-shadow-lg animate-in fade-in slide-in-from-bottom-2">
                            "{subtitle}"
                        </p>
                    )}
                    {!subtitle && (
                        <p className={`text-lg font-bold tracking-[0.2em] transition-colors duration-500 ${state === 'THINKING' ? 'text-purple-400 animate-pulse' : 'text-slate-500'}`}>
                            {getStatusText()}
                        </p>
                    )}
                </div>

            </div>

            {/* CORRECTION FEEDBACK CARD */}
            {correction && (
                <div className="absolute bottom-12 left-6 right-6 md:left-auto md:right-auto md:w-full md:max-w-2xl mx-auto z-30 animate-in slide-in-from-bottom-10 fade-in duration-500">
                    <div className="bg-slate-900/95 backdrop-blur-xl border-l-4 border-yellow-500 border-y border-r border-white/10 p-6 rounded-r-2xl shadow-2xl relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-yellow-500/10 to-transparent -translate-x-full group-hover:animate-shimmer" />
                        <div className="flex flex-col gap-4 relative z-10">
                            <div className="flex items-center gap-3 border-b border-white/5 pb-3">
                                <div className="p-2 bg-yellow-500/20 text-yellow-400 rounded-lg shrink-0">
                                    <Zap size={20} />
                                </div>
                                <h4 className="text-yellow-500 text-sm font-black uppercase tracking-widest">Feedback</h4>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="space-y-1">
                                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wide flex items-center gap-1">
                                        <X size={12} className="text-red-500" /> A melhoria
                                    </span>
                                    <p className="text-sm font-medium text-slate-300 leading-relaxed">{correction.explanation}</p>
                                </div>
                                <div className="space-y-1">
                                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wide flex items-center gap-1">
                                        <CheckCircle2 size={12} className="text-emerald-500" /> O correto
                                    </span>
                                    <p className="text-lg font-bold text-emerald-400 leading-relaxed">"{correction.solution}"</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
};

export default WolfieLiveCall;
