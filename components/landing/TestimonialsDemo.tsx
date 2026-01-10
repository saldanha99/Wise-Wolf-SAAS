import { TestimonialsColumn } from "@/components/ui/testimonials-columns-1";
import { motion } from "framer-motion";

const testimonials = [
    {
        text: "O Wise Wolf transformou a gestão da minha escola. Antes eu perdia horas com planilhas, agora tudo é automático.",
        image: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&q=80&w=150",
        name: "Ana Silva",
        role: "Diretora Pedagógica",
    },
    {
        text: "A interface é linda e meus alunos adoram a área de membros. A retenção aumentou 30%.",
        image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=150",
        name: "Carlos Mendes",
        role: "Proprietário de Escola",
    },
    {
        text: "Suporte incrível e funcionalidades que realmente funcionam para o mercado brasileiro de idiomas.",
        image: "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?auto=format&fit=crop&q=80&w=150",
        name: "Mariana Costa",
        role: "Coordenadora",
    },
    {
        text: "Simplesmente o melhor investimento que fizemos este ano. O ROI foi imediato.",
        image: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&q=80&w=150",
        name: "Pedro Santos",
        role: "CEO EdTech",
    },
    // Duplicating for scroll effect
    {
        text: "O Wise Wolf transformou a gestão da minha escola. Antes eu perdia horas com planilhas, agora tudo é automático.",
        image: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&q=80&w=150",
        name: "Ana Silva",
        role: "Diretora Pedagógica",
    },
    {
        text: "A interface é linda e meus alunos adoram a área de membros. A retenção aumentou 30%.",
        image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=150",
        name: "Carlos Mendes",
        role: "Proprietário de Escola",
    },
];


const firstColumn = testimonials.slice(0, 3);
const secondColumn = testimonials.slice(3, 6);
const thirdColumn = testimonials.slice(0, 3); // Recycling for visual fill


export const TestimonialsDemo = () => {
    return (
        <section className="bg-transparent my-20 relative">

            <div className="container z-10 mx-auto px-6">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
                    viewport={{ once: true }}
                    className="flex flex-col items-center justify-center max-w-[540px] mx-auto text-center"
                >
                    <div className="flex justify-center">
                        <div className="border border-white/20 py-1 px-4 rounded-full text-white/60 text-sm">Depoimentos</div>
                    </div>

                    <h2 className="text-3xl md:text-5xl font-bold tracking-tighter mt-5 text-white">
                        O que dizem nossos parceiros
                    </h2>
                    <p className="text-center mt-5 text-slate-400">
                        Escolas de todo o Brasil confiam no Wise Wolf.
                    </p>
                </motion.div>

                <div className="flex justify-center gap-6 mt-10 [mask-image:linear-gradient(to_bottom,transparent,black_25%,black_75%,transparent)] max-h-[740px] overflow-hidden">
                    <TestimonialsColumn testimonials={firstColumn} duration={15} />
                    <TestimonialsColumn testimonials={secondColumn} className="hidden md:block" duration={19} />
                    <TestimonialsColumn testimonials={thirdColumn} className="hidden lg:block" duration={17} />
                </div>
            </div>
        </section>
    );
};
