import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const faqs = [
    {
        question: "Preciso de cartão de crédito para testar?",
        answer: "Não. Você pode começar com o plano gratuito (Starter) para gerenciar seus primeiros alunos sem compromisso."
    },
    {
        question: "Consigo migrar meus dados atuais?",
        answer: "Sim! Temos uma equipe de onboarding dedicada para importar suas planilhas e cadastros atuais sem custo adicional nos planos Pro e Enterprise."
    },
    {
        question: "O sistema bloqueia alunos inadimplentes?",
        answer: "Sim. Você configura as regras (ex: 5 dias de atraso). O aluno perde acesso à plataforma pedagógica até regularizar, o que aumenta a recuperação de crédito em até 40%."
    },
    {
        question: "Serve para professores autônomos?",
        answer: "Perfeitamente. O Wise Wolf foi criado para eliminar a burocracia tanto de grandes redes quanto de 'eu-quipes' que querem crescer."
    }
];

export function FaqSection() {
    return (
        <section className="py-24 bg-black">
            <div className="container mx-auto px-6 max-w-3xl">
                <h2 className="text-3xl font-bold text-white text-center mb-12">Perguntas Frequentes</h2>
                <Accordion type="single" collapsible className="w-full space-y-4">
                    {faqs.map((faq, index) => (
                        <AccordionItem key={index} value={`item-${index}`} className="border border-white/10 rounded-xl bg-zinc-900/30 px-6">
                            <AccordionTrigger className="text-white hover:text-blue-400 hover:no-underline py-6 text-left font-semibold text-lg data-[state=open]:text-blue-400">
                                {faq.question}
                            </AccordionTrigger>
                            <AccordionContent className="text-zinc-400 text-base pb-6 leading-relaxed">
                                {faq.answer}
                            </AccordionContent>
                        </AccordionItem>
                    ))}
                </Accordion>
            </div>
        </section>
    );
}
