"use client";

import { Calendar, Code, FileText, User, Clock, Rocket, Zap, Target } from "lucide-react";
import RadialOrbitalTimeline from "@/components/ui/radial-orbital-timeline";

const timelineData = [
    {
        id: 1,
        title: "Cadastro Rápido",
        date: "Passo 1",
        content: "Configure sua escola em menos de 2 minutos. Defina sua marca e suas turmas.",
        category: "Setup",
        icon: Rocket,
        relatedIds: [2],
        status: "completed" as const,
        energy: 100,
    },
    {
        id: 2,
        title: "Gestão Financeira",
        date: "Passo 2",
        content: "Automatize cobranças e receba pagamentos via PIX/Cartão sem dor de cabeça.",
        category: "Financeiro",
        icon: Zap,
        relatedIds: [1, 3],
        status: "completed" as const,
        energy: 90,
    },
    {
        id: 3,
        title: "Retenção de Alunos",
        date: "Passo 3",
        content: "Use o sistema de gamificação e área do aluno para manter todos engajados.",
        category: "Pedagógico",
        icon: Target,
        relatedIds: [2, 4],
        status: "in-progress" as const,
        energy: 85,
    },
    {
        id: 4,
        title: "Escala & Crescimento",
        date: "Passo 4",
        content: "Acompanhe métricas de conversão e expanda para novas unidades.",
        category: "Growth",
        icon: FileText,
        relatedIds: [3],
        status: "pending" as const,
        energy: 60,
    },
];

export function RadialOrbitalTimelineDemo() {
    return (
        <>
            <RadialOrbitalTimeline timelineData={timelineData} />
        </>
    );
}
