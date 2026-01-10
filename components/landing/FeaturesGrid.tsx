import { Zap, BarChart3, Shield, Globe, Users, TrendingUp } from "lucide-react";

const features = [
    {
        title: "Gestão Financeira Blindada",
        description: "Automatize 100% das cobranças. Chega de cobrar alunos no WhatsApp. O sistema envia lembretes e bloqueia inadimplentes automaticamente.",
        icon: Shield,
        className: "md:col-span-2",
    },
    {
        title: "Retenção com Dopamina",
        description: "Gamificação integrada que vicia os alunos em estudar. Rankings, conquistas e níveis que aumentam a LTV (Lifetime Value).",
        icon: Zap,
        className: "md:col-span-1",
    },
    {
        title: "Métricas de CEO",
        description: "Dashboard em tempo real. Saiba exatamente seu CAC, LTV e Churn sem abrir planilhas complexas.",
        icon: BarChart3,
        className: "md:col-span-1",
    },
    {
        title: "Escala Infinita",
        description: "Gerencie 10 ou 10.000 alunos com a mesma equipe. Processos automatizados de matrícula e enturmação.",
        icon: TrendingUp,
        className: "md:col-span-2",
    },
];

export function FeaturesGrid() {
    return (
        <section className="py-24 bg-zinc-950">
            <div className="container mx-auto px-6 max-w-7xl">
                <div className="mb-16 text-center">
                    <span className="text-blue-500 font-bold tracking-widest uppercase text-sm">Por que o Wise Wolf?</span>
                    <h2 className="text-4xl md:text-5xl font-black text-white mt-4 tracking-tight">
                        Mais que um Sistema.<br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-violet-500">Uma Máquina de Crescimento.</span>
                    </h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {features.map((feature, i) => (
                        <div key={i} className={`group relative overflow-hidden rounded-3xl bg-zinc-900/50 border border-white/10 p-8 hover:bg-zinc-900 transition-colors ${feature.className}`}>
                            <div className="absolute top-0 right-0 p-4 opacity-20 group-hover:opacity-40 transition-opacity">
                                <feature.icon size={120} />
                            </div>
                            <div className="relative z-10 flex flex-col h-full justify-between">
                                <div className="w-12 h-12 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                                    <feature.icon size={24} />
                                </div>
                                <div>
                                    <h3 className="text-2xl font-bold text-white mb-3">{feature.title}</h3>
                                    <p className="text-zinc-400 leading-relaxed font-medium">
                                        {feature.description}
                                    </p>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
