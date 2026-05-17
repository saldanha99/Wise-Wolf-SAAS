import React, { useState, useRef, useEffect } from 'react';
import { Mic, Send, Play, Pause, Keyboard, X, Sparkles, Volume2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    audioBase64?: string;
    createdAt: Date;
}

const WolfTutorChat: React.FC = () => {
    const [messages, setMessages] = useState<Message[]>([
        {
            id: 'welcome',
            role: 'assistant',
            content: "Hello! I'm Wolfie, your English tutor. How are you feeling today?",
            createdAt: new Date(),
        }
    ]);
    const [isRecording, setIsRecording] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [inputText, setInputText] = useState('');
    const [showTextInput, setShowTextInput] = useState(false);
    const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' }); // Chrome/Android uses webm often
                handleAudioSend(audioBlob);
                stream.getTracks().forEach(track => track.stop()); // Stop mic
            };

            mediaRecorder.start();
            setIsRecording(true);
        } catch (error) {
            console.error('Error accessing microphone:', error);
            alert('Cannot access microphone. Please check permissions.');
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };

    const handleAudioSend = async (audioBlob: Blob) => {
        setIsLoading(true);
        const newMessageId = Date.now().toString();

        // 1. Add User Message (Optimistic UI - Placeholder text for Audio)
        const userMsg: Message = {
            id: newMessageId,
            role: 'user',
            content: '🎤 Audio Message',
            createdAt: new Date(),
        };
        setMessages(prev => [...prev, userMsg]);

        try {
            const formData = new FormData();
            formData.append('audio', audioBlob, 'voice.webm');
            formData.append('studentLevel', 'A1'); // Could be prop
            // formData.append('conversationId', ...); // If keeping state

            const { data, error } = await supabase.functions.invoke('wolf-tutor-api', {
                body: formData,
            });

            if (error) throw error;

            processApiResponse(data);

        } catch (error) {
            console.error('Error sending audio:', error);
            setMessages(prev => [...prev, {
                id: 'error-' + Date.now(),
                role: 'assistant',
                content: 'Sorry, I had trouble hearing you. Please try again.',
                createdAt: new Date()
            }]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleTextSend = async () => {
        if (!inputText.trim()) return;

        const text = inputText;
        setInputText('');
        setIsLoading(true);

        const userMsg: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: text,
            createdAt: new Date(),
        };
        setMessages(prev => [...prev, userMsg]);

        try {
            const { data, error } = await supabase.functions.invoke('wolf-tutor-api', {
                body: JSON.stringify({
                    text: text,
                    studentLevel: 'A1'
                }),
            });

            if (error) throw error;

            processApiResponse(data);
        } catch (error) {
            console.error('Error sending text:', error);
            setMessages(prev => [...prev, {
                id: 'error-' + Date.now(),
                role: 'assistant',
                content: 'Sorry, connection error. Please try again.',
                createdAt: new Date()
            }]);
        } finally {
            setIsLoading(false);
        }
    };

    const processApiResponse = (data: any) => {
        // Correct the user's text if it was speech-to-text
        if (data.userText) {
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last.role === 'user' && last.content === '🎤 Audio Message') {
                    return [...prev.slice(0, -1), { ...last, content: data.userText }];
                }
                return prev;
            });
        }

        const aiMsg: Message = {
            id: 'ai-' + Date.now(),
            role: 'assistant',
            content: data.aiText,
            audioBase64: data.aiAudioBase64,
            createdAt: new Date(),
        };

        setMessages(prev => [...prev, aiMsg]);

        // Auto-play audio
        if (data.aiAudioBase64) {
            playAudio(data.aiAudioBase64, aiMsg.id);
        }
    };

    const playAudio = (base64: string, msgId: string) => {
        if (audioPlayerRef.current) {
            audioPlayerRef.current.pause();
        }

        const audio = new Audio(`data:audio/mp3;base64,${base64}`);
        audioPlayerRef.current = audio;
        setPlayingMessageId(msgId);

        audio.play().catch(e => console.error("Auto-play blocked:", e));

        audio.onended = () => {
            setPlayingMessageId(null);
        };
    };

    const togglePlay = (msg: Message) => {
        if (playingMessageId === msg.id && audioPlayerRef.current) {
            audioPlayerRef.current.pause();
            setPlayingMessageId(null);
        } else if (msg.audioBase64) {
            playAudio(msg.audioBase64, msg.id);
        }
    };

    return (
        <div className="flex flex-col h-[600px] bg-brand-surface-2 dark:bg-brand-surface rounded-3xl overflow-hidden border border-brand-border dark:border-brand-border shadow-2xl relative">

            {/* Header */}
            <div className="bg-brand-surface dark:bg-slate-950 p-4 flex items-center gap-4 border-b border-brand-border z-10">
                <div className="w-12 h-12 rounded-full bg-indigo-500 overflow-hidden border-2 border-indigo-300 p-0.5 relative">
                    {/* Wolf Avatar Placeholder or Image */}
                    <div className="w-full h-full bg-brand-surface rounded-full flex items-center justify-center text-xl">🐺</div>
                    <div className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white dark:border-slate-900 animate-pulse"></div>
                </div>
                <div>
                    <h3 className="font-black text-brand-text text-lg">Wolfie Tutor</h3>
                    <p className="text-xs text-indigo-500 font-bold uppercase tracking-wider">Always Online</p>
                </div>
            </div>

            {/* Chat Feed */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-hide bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] bg-fixed">
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                        <div className={`max-w-[80%] flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>

                            <div className={`p-4 rounded-2xl relative shadow-sm ${msg.role === 'user'
                                    ? 'bg-emerald-500 text-white rounded-tr-none'
                                    : 'bg-brand-surface dark:bg-brand-surface-2 text-brand-text dark:text-slate-200 rounded-tl-none border border-brand-border dark:border-brand-border'
                                }`}>
                                <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>

                                {msg.role === 'assistant' && msg.audioBase64 && (
                                    <button
                                        onClick={() => togglePlay(msg)}
                                        className="mt-3 flex items-center gap-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 px-3 py-1.5 rounded-full text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors"
                                    >
                                        {playingMessageId === msg.id ? <Pause size={14} className="fill-current" /> : <Play size={14} className="fill-current" />}
                                        {playingMessageId === msg.id ? 'Listening...' : 'Listen'}
                                    </button>
                                )}
                            </div>
                            <span className="text-[10px] text-brand-muted mt-1 font-medium px-1">
                                {msg.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                        </div>
                    </div>
                ))}

                {isLoading && (
                    <div className="flex justify-start">
                        <div className="bg-brand-surface dark:bg-brand-surface-2 p-4 rounded-2xl rounded-tl-none border border-brand-border dark:border-brand-border flex items-center gap-2">
                            <div className="flex gap-1">
                                <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                                <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                                <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                            </div>
                            <span className="text-xs font-bold text-brand-muted">Wolfie is thinking...</span>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="bg-brand-surface dark:bg-slate-950 p-4 border-t border-brand-border dark:border-brand-border relative z-20">

                {/* Text Inout Mode */}
                {showTextInput && (
                    <div className="flex items-center gap-2 animate-in slide-in-from-bottom-5 fade-in duration-300">
                        <button
                            onClick={() => setShowTextInput(false)}
                            className="p-3 rounded-full hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2 text-brand-muted transition-colors"
                        >
                            <X size={20} />
                        </button>
                        <input
                            type="text"
                            value={inputText}
                            onChange={(e) => setInputText(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleTextSend()}
                            placeholder="Type a message to Wolfie..."
                            className="flex-1 bg-brand-surface-2 dark:bg-brand-surface border-none rounded-2xl px-5 py-3.5 focus:ring-2 focus:ring-indigo-500 outline-none text-brand-text"
                            autoFocus
                        />
                        <button
                            onClick={handleTextSend}
                            disabled={!inputText.trim() || isLoading}
                            className="bg-indigo-600 text-white p-3.5 rounded-full shadow-lg shadow-indigo-500/30 hover:scale-105 active:scale-95 transition-all disabled:opacity-50 disabled:shadow-none"
                        >
                            <Send size={20} className="ml-0.5" />
                        </button>
                    </div>
                )}

                {/* Voice Input Mode (Default) */}
                {!showTextInput && (
                    <div className="flex flex-col items-center justify-center gap-4 relative py-2">
                        {isRecording && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none mb-14">
                                <div className="w-40 h-40 bg-red-500/10 rounded-full animate-ping"></div>
                                <div className="absolute w-32 h-32 bg-red-500/20 rounded-full animate-pulse"></div>
                            </div>
                        )}

                        <div className="text-center space-y-1">
                            {isRecording ? (
                                <p className="text-red-500 font-bold animate-pulse">Recording... Click to stop</p>
                            ) : (
                                <p className="text-brand-muted text-sm font-medium">Click microphone to speak</p>
                            )}
                        </div>

                        <div className="flex items-center justify-between w-full max-w-xs mx-auto gap-6 z-10 px-4">
                            <button
                                onClick={() => setShowTextInput(true)}
                                className="p-3 text-brand-muted hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-full transition-all"
                                title="Type instead"
                            >
                                <Keyboard size={24} />
                            </button>

                            <button
                                onClick={isRecording ? stopRecording : startRecording}
                                disabled={isLoading}
                                className={`
                                    relative w-20 h-20 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300
                                    ${isRecording
                                        ? 'bg-red-500 shadow-red-500/40 scale-110'
                                        : 'bg-gradient-to-br from-indigo-500 to-purple-600 shadow-indigo-500/40 hover:scale-105 active:scale-95'
                                    }
                                    ${isLoading ? 'opacity-50 cursor-not-allowed grayscale' : ''}
                                `}
                            >
                                {isRecording ? (
                                    <div className="w-8 h-8 bg-brand-surface rounded-md animate-none" />
                                ) : (
                                    <Mic size={36} className="text-white" />
                                )}
                            </button>

                            <div className="w-12 h-12" /> {/* Spacer for centering mic */}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default WolfTutorChat;
