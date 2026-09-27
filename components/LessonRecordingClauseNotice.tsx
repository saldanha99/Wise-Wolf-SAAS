import React from 'react';
import { FileText } from 'lucide-react';

interface LessonRecordingClauseNoticeProps {
    /** Onde a cláusula está no contrato, ex.: "Cláusula 8" (aluno) ou "Cláusula 11ª" (professor). */
    clauseLabel: string;
}

/**
 * Destaque, ao lado da assinatura, da cláusula do registro das aulas. O
 * registro é decisão da escola (27/09/2026) e quem assina o contrato concorda
 * com ele — por isso a cláusula não pode passar despercebida no meio do texto.
 * Só aparece quando a versão assinada traz a cláusula (lib/contractTerms.ts).
 */
export function LessonRecordingClauseNotice({ clauseLabel }: LessonRecordingClauseNoticeProps) {
    return (
        <div
            role="note"
            data-lesson-recording-clause-notice=""
            className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-xs leading-relaxed text-blue-800"
        >
            <p className="mb-1 flex items-center gap-1 font-bold">
                <FileText size={12} aria-hidden="true" /> Registro das aulas — {clauseLabel}
            </p>
            As aulas no Google Meet da escola são transcritas e anotadas automaticamente pelo Google, sem gravação em vídeo, e o professor aprova o resumo de cada aula, preparado com ajuda de IA. Ao assinar, você concorda com esse registro. Para que ele serve, quem vê, os prazos e como pedir para não ser registrado estão na {clauseLabel} do contrato.
        </div>
    );
}
