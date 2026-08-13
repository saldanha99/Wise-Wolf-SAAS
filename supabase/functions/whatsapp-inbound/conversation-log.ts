/**
 * O QUE VAI PARA O HISTÓRICO DA CONVERSA — e o que só fica no registro.
 *
 * Achado no teste ponta a ponta de 13/08/2026: a resposta ao lead só era
 * gravada em `ai_wa_messages` **se o envio pelo WhatsApp desse certo**. Uma
 * remarcação de experimental aconteceu no banco (agenda movida, professora
 * avisada) e não sobrou registro nenhum de que o agente decidiu aquilo — o
 * envio ao aluno falhou e levou o log junto. Instabilidade da Evolution vira
 * ponto cego exatamente quando você mais precisa saber o que o robô fez.
 *
 * Agora TODA resposta é registrada, com `entregue: true|false`. Isso cria um
 * segundo problema, que este módulo resolve: uma mensagem que o lead **nunca
 * recebeu** não pode voltar como fala da atendente na próxima rodada. O modelo
 * leria "eu já expliquei isso" e não repetiria a informação — o aluno ficaria
 * sem resposta e sem saber por quê.
 *
 * Logo: o registro guarda tudo; o histórico enviado ao modelo guarda só o que
 * a pessoa realmente viu.
 */

export interface LinhaDeConversa {
  direction?: string | null;
  content?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface MensagemDoModelo {
  role: "user" | "assistant";
  content: string;
}

/**
 * A mensagem chegou à pessoa?
 *
 * ⚠️ Só `entregue === false` reprova. Linha antiga não tem o campo, e tratar
 * ausência como "não entregue" apagaria todo o histórico anterior à mudança —
 * a atendente perderia a memória das conversas em andamento de uma vez só.
 */
export function foiEntregue(linha: LinhaDeConversa): boolean {
  return linha?.meta?.entregue !== false;
}

/**
 * Converte as linhas do banco no histórico que vai para o modelo, já sem o que
 * não foi entregue. `rows` vem do mais novo para o mais antigo (como o select
 * ordena) e sai na ordem da conversa.
 */
export function historicoParaModelo(rows: LinhaDeConversa[], limiteCaracteres = 900): MensagemDoModelo[] {
  return (rows || [])
    .filter(foiEntregue)
    .reverse()
    .map((m) => ({
      role: m.direction === "in" ? "user" as const : "assistant" as const,
      content: String(m.content || "").slice(0, limiteCaracteres),
    }));
}
