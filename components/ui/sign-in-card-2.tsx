
import React, { useState } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'framer-motion';
import { Mail, Lock, Eye, EyeClosed, ArrowRight, ShieldCheck } from 'lucide-react';
import { cn } from "../../lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
    return (
        <input
            type={type}
            data-slot="input"
            className={cn(
                "file:text-foreground placeholder:text-muted-foreground selection:bg-blue-600 selection:text-white dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
                "focus-visible:border-blue-500 focus-visible:ring-blue-500/50 focus-visible:ring-[3px]",
                "aria-invalid:ring-red-500/20 dark:aria-invalid:ring-red-500/40 aria-invalid:border-red-500",
                className
            )}
            {...props}
        />
    )
}

interface SignInCard2Props {
    onLogin: (e: React.FormEvent, data: { email: string, password: string }) => void;
    isLoading: boolean;
    onDemoLogin?: (email: string, pass: string) => void;
    error?: string;
}

export function SignInCard2({ onLogin, isLoading, onDemoLogin, error }: SignInCard2Props) {
    const [showPassword, setShowPassword] = useState(false);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [focusedInput, setFocusedInput] = useState<string | null>(null);
    const [rememberMe, setRememberMe] = useState(false);

    // For 3D card effect
    const mouseX = useMotionValue(0);
    const mouseY = useMotionValue(0);
    const rotateX = useTransform(mouseY, [-300, 300], [10, -10]);
    const rotateY = useTransform(mouseX, [-300, 300], [-10, 10]);

    const handleMouseMove = (e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect();
        mouseX.set(e.clientX - rect.left - rect.width / 2);
        mouseY.set(e.clientY - rect.top - rect.height / 2);
    };

    const handleMouseLeave = () => {
        mouseX.set(0);
        mouseY.set(0);
    };

    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        onLogin(event, { email, password });
    };

    return (
        <div className="min-h-screen w-full bg-[#020617] relative overflow-hidden flex items-center justify-center p-4">
            {/* Brand Watermark */}
            <div className="absolute top-8 left-8 flex items-center gap-3 opacity-50">
                <ShieldCheck size={32} className="text-blue-500" />
                <span className="text-white font-black text-xl tracking-tighter">WISE WOLF</span>
            </div>

            {/* Background gradient effect - Deep Blue Theme */}
            <div className="absolute inset-0 bg-gradient-to-b from-blue-900/20 via-[#002366]/30 to-[#020617]" />

            {/* Noise texture */}
            <div className="absolute inset-0 opacity-[0.03] mix-blend-soft-light"
                style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
                    backgroundSize: '200px 200px'
                }}
            />

            {/* Top radial glow - Blue */}
            <motion.div
                className="absolute top-0 left-1/2 transform -translate-x-1/2 w-[100vh] h-[60vh] rounded-b-full bg-blue-600/10 blur-[80px]"
                animate={{
                    opacity: [0.3, 0.5, 0.3],
                    scale: [0.95, 1.05, 0.95]
                }}
                transition={{
                    duration: 8,
                    repeat: Infinity,
                    repeatType: "mirror"
                }}
            />

            {/* Bottom Red Glow for that Wise Wolf secondary color */}
            <motion.div
                className="absolute bottom-0 right-0 transform translate-x-1/4 translate-y-1/4 w-[80vh] h-[80vh] rounded-full bg-[#D32F2F]/10 blur-[100px]"
                animate={{
                    opacity: [0.2, 0.4, 0.2],
                    scale: [1, 1.1, 1]
                }}
                transition={{
                    duration: 10,
                    repeat: Infinity,
                    repeatType: "mirror"
                }}
            />

            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8 }}
                className="w-full max-w-md relative z-10"
                style={{ perspective: 1500 }}
            >
                <motion.div
                    className="relative"
                    style={{ rotateX, rotateY }}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                >
                    <div className="relative group">
                        {/* Card glow effect */}
                        <motion.div
                            className="absolute -inset-[1px] rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-700"
                            animate={{
                                boxShadow: [
                                    "0 0 20px 2px rgba(59, 130, 246, 0.1)",
                                    "0 0 30px 5px rgba(59, 130, 246, 0.2)",
                                    "0 0 20px 2px rgba(59, 130, 246, 0.1)"
                                ]
                            }}
                            transition={{ duration: 4, repeat: Infinity, repeatType: "mirror" }}
                        />

                        {/* Borders with traveling light */}
                        <div className="absolute -inset-[1px] rounded-3xl overflow-hidden pointer-events-none">
                            <motion.div
                                className="absolute top-0 left-0 h-[2px] w-[50%] bg-gradient-to-r from-transparent via-blue-400 to-transparent opacity-0 group-hover:opacity-70 transition-opacity"
                                animate={{ left: ["-50%", "100%"] }}
                                transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                            />
                            <motion.div
                                className="absolute bottom-0 right-0 h-[2px] w-[50%] bg-gradient-to-r from-transparent via-red-400 to-transparent opacity-0 group-hover:opacity-70 transition-opacity"
                                animate={{ right: ["-50%", "100%"] }}
                                transition={{ duration: 3, repeat: Infinity, ease: "linear", delay: 1.5 }}
                            />
                        </div>

                        {/* Glass card background */}
                        <div className="relative bg-[#020617]/80 backdrop-blur-xl rounded-3xl p-8 border border-white/5 shadow-2xl overflow-hidden">

                            {/* Header */}
                            <div className="text-center space-y-4 mb-8">
                                <motion.div
                                    initial={{ scale: 0.5, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    className="mx-auto w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-600 to-blue-900 border border-white/10 flex items-center justify-center shadow-lg shadow-blue-500/20"
                                >
                                    <ShieldCheck size={24} className="text-white" />
                                </motion.div>

                                <div>
                                    <h1 className="text-2xl font-black bg-clip-text text-transparent bg-gradient-to-b from-white to-white/60 tracking-tight">
                                        Acesso Restrito
                                    </h1>
                                    <p className="text-slate-400 text-xs font-medium mt-1">
                                        Insira suas credenciais para continuar.
                                    </p>
                                </div>
                            </div>

                            {/* Form */}
                            <form onSubmit={handleSubmit} className="space-y-5">
                                {error && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-red-400 text-xs font-bold flex items-center justify-center gap-2"
                                    >
                                        <ShieldCheck size={14} /> {error}
                                    </motion.div>
                                )}

                                <div className="space-y-4">
                                    {/* Email */}
                                    <motion.div
                                        whileHover={{ scale: 1.01 }}
                                        className="relative group/email"
                                    >
                                        <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500/20 to-purple-500/20 rounded-xl opacity-0 group-hover/email:opacity-100 transition-opacity" />
                                        <div className="relative flex items-center">
                                            <Mail className={`absolute left-4 w-4 h-4 transition-colors ${focusedInput === 'email' ? 'text-blue-400' : 'text-slate-500'}`} />
                                            <Input
                                                type="email"
                                                placeholder="E-mail corporativo"
                                                value={email}
                                                onChange={(e) => setEmail(e.target.value)}
                                                onFocus={() => setFocusedInput('email')}
                                                onBlur={() => setFocusedInput(null)}
                                                className="pl-11 h-12 bg-slate-900/50 border-white/5 text-slate-200 placeholder:text-slate-600 rounded-xl focus:bg-slate-900 focus:border-blue-500/50 transition-all font-medium text-sm"
                                            />
                                        </div>
                                    </motion.div>

                                    {/* Password */}
                                    <motion.div
                                        whileHover={{ scale: 1.01 }}
                                        className="relative group/password"
                                    >
                                        <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500/20 to-purple-500/20 rounded-xl opacity-0 group-hover/password:opacity-100 transition-opacity" />
                                        <div className="relative flex items-center">
                                            <Lock className={`absolute left-4 w-4 h-4 transition-colors ${focusedInput === 'password' ? 'text-blue-400' : 'text-slate-500'}`} />
                                            <Input
                                                type={showPassword ? "text" : "password"}
                                                placeholder="Senha de acesso"
                                                value={password}
                                                onChange={(e) => setPassword(e.target.value)}
                                                onFocus={() => setFocusedInput('password')}
                                                onBlur={() => setFocusedInput(null)}
                                                className="pl-11 pr-11 h-12 bg-slate-900/50 border-white/5 text-slate-200 placeholder:text-slate-600 rounded-xl focus:bg-slate-900 focus:border-blue-500/50 transition-all font-medium text-sm"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowPassword(!showPassword)}
                                                className="absolute right-3 p-1 hover:text-white text-slate-500 transition-colors"
                                            >
                                                {showPassword ? <Eye size={16} /> : <EyeClosed size={16} />}
                                            </button>
                                        </div>
                                    </motion.div>
                                </div>

                                {/* Actions */}
                                <div className="flex items-center justify-between text-xs">
                                    <label className="flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white transition-colors">
                                        <input
                                            type="checkbox"
                                            checked={rememberMe}
                                            onChange={() => setRememberMe(!rememberMe)}
                                            className="w-3.5 h-3.5 rounded border-white/10 bg-white/5 checked:bg-blue-600 transition-all cursor-pointer"
                                        />
                                        Manter conectado
                                    </label>
                                    <a href="#" className="text-blue-400 hover:text-blue-300 font-medium transition-colors">Recuperar senha?</a>
                                </div>

                                {/* Submit Button */}
                                <motion.button
                                    whileHover={{ scale: 1.02 }}
                                    whileTap={{ scale: 0.98 }}
                                    disabled={isLoading}
                                    type="submit"
                                    className="w-full relative group/btn h-12 rounded-xl overflow-hidden"
                                >
                                    <div className="absolute inset-0 bg-gradient-to-r from-blue-600 to-[#D32F2F] opacity-90 group-hover/btn:opacity-100 transition-opacity" />
                                    <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20" />

                                    <div className="relative flex items-center justify-center gap-2 text-white font-bold text-sm tracking-wide uppercase">
                                        {isLoading ? (
                                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                        ) : (
                                            <>Entrar <ArrowRight size={16} /></>
                                        )}
                                    </div>
                                </motion.button>
                            </form>

                            {/* Demo Quick Access */}
                            {onDemoLogin && (
                                <div className="mt-8 pt-6 border-t border-white/5 space-y-4">
                                    <p className="text-[10px] uppercase font-black text-slate-500 tracking-widest text-center">Acesso Rápido (Demo)</p>
                                    <div className="grid grid-cols-2 gap-2">
                                        {[
                                            { label: 'Diretor', email: 'diretor@wisewolf.com', pass: '123456' },
                                            { label: 'Professor', email: 'professor@wisewolf.com', pass: '123456' },
                                            { label: 'Aluno', email: 'aluno@wisewolf.com', pass: '123456' },
                                            { label: 'Super Admin', email: 'admin@educore.io', pass: '123456' }
                                        ].map((demo, i) => (
                                            <button
                                                key={i}
                                                type="button"
                                                onClick={() => {
                                                    setEmail(demo.email);
                                                    setPassword(demo.pass);
                                                    // Optional: Auto submit or just fill
                                                }}
                                                className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 text-[10px] font-bold text-slate-300 hover:text-white transition-all text-center uppercase tracking-wide"
                                            >
                                                {demo.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                        </div>
                    </div>
                </motion.div>
            </motion.div>

            <div className="absolute bottom-6 text-center w-full pointer-events-none">
                <p className="text-[10px] text-slate-600 font-bold uppercase tracking-[0.2em] mix-blend-screen opacity-50">
                    Wise Wolf System • v1.0
                </p>
            </div>
        </div>
    );
}
