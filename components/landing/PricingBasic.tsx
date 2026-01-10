"use client";

import { Pricing } from "@/components/ui/pricing";

const plans = [
    {
        name: "STARTER",
        price: "147",
        yearlyPrice: "1490",
        period: "per month",
        features: [
            "Até 20 Alunos",
            "1GB de Armazenamento",
            "Suporte por Email",
            "Gestão Financeira Básica",
        ],
        description: "Ideal para professores particulares e pequenas escolas.",
        buttonText: "Começar Agora",
        href: "/signup?plan=starter",
        isPopular: false,
    },
    {
        name: "PROFESSIONAL",
        price: "297",
        yearlyPrice: "2990",
        period: "per month",
        features: [
            "Alunos ILIMITADOS",
            "5GB de Armazenamento",
            "Suporte Prioritário",
            "Módulo Pedagógico Completo",
            "Área do Aluno Personalizada",
        ],
        description: "Perfeito para escolas em crescimento.",
        buttonText: "Escolher Profissional",
        href: "/signup?plan=pro",
        isPopular: true,
    },
    {
        name: "ENTERPRISE",
        price: "597",
        yearlyPrice: "6089",
        period: "per month",
        features: [
            "Tudo do Professional",
            "70GB de Armazenamento",
            "Gerente de Conta Dedicado",
            "White Label (Sua Marca)",
            "API de Integração",
        ],
        description: "Para grandes redes e franquias.",
        buttonText: "Falar com Consultor",
        href: "/contact",
        isPopular: false,
    },
];

export function PricingBasic() {
    return (
        <div className="">
            <Pricing
                plans={plans}
                title="Preços Simples e Transparentes"
                description="Escolha o plano ideal para escalar sua escola hoje mesmo."
            />
        </div>
    );
}
