// Página do termo individual aberta pelo link do WhatsApp: o que o servidor
// devolve e as mensagens para cada recusa.

export type TermLinkView = {
    ok: boolean;
    reason?: string;
    signer: 'SCHOOL' | 'TEACHER';
    signer_name: string;
    school_name: string;
    student_name: string;
    teacher_name: string;
    agenda: string;
    starts_on: string;
    ends_on: string | null;
    unit_rate: number;
    needs_identity: boolean;
    other_signed: boolean;
    body: string;
    content_hash: string;
    term_id: string;
    version: number;
    expires_at: string;
};

export function termLinkReasonMessage(reason: string | undefined): string {
    switch (reason) {
        case 'used': return 'Este termo já foi assinado por você. Está tudo certo!';
        case 'replaced': return 'Este link foi substituído por um mais novo. Use o último link que chegou no seu WhatsApp.';
        case 'expired': return 'Este link venceu. Peça um novo à escola.';
        case 'executed': return 'Este termo já está assinado por todos. Está tudo certo!';
        case 'declined': return 'Este atendimento foi recusado.';
        case 'revoked':
        case 'superseded':
        case 'terminated': return 'Este termo não está mais valendo. A escola vai te mandar o atualizado, se for o caso.';
        default: return 'Link inválido. Confira se abriu o link completo que chegou no seu WhatsApp.';
    }
}

export function termLinkErrorMessage(error: string | undefined): string {
    if (!error) return 'Não foi possível concluir agora. Tente de novo.';
    if (error === 'link_invalido') return 'Este link não vale mais. Atualize a página.';
    if (error === 'acao_invalida' || error === 'not_authorized') return 'Esta ação não está disponível por este link.';
    if (/fonte alterada|Proposta indisponível/i.test(error)) return 'O termo mudou depois que o link foi enviado. Atualize a página para ver a versão atual.';
    return error;
}
