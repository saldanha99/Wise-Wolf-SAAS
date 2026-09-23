/**
 * A professora avisa, pelo número da escola, que o lead da experimental não
 * apareceu.
 *
 * Hoje isso morre na conversa: alguém precisa abrir a plataforma, marcar a
 * falta e chamar o lead de volta. A falta tem peso — a experimental não paga a
 * professora quando o aluno não comparece —, então a leitura aqui é
 * CONSERVADORA: precisa falar de ausência E de aula/aluno, e qualquer sinal de
 * que a aula aconteceu derruba a detecção.
 */

function normalizar(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

export function mentionsTrialNoShow(text: string): boolean {
  const t = normalizar(text);
  if (!t) return false;

  // A aula aconteceu: nada aqui é falta, mesmo que a frase cite "não".
  // O lookbehind em `compareceu` é obrigatório: sem ele, "o aluno NÃO
  // compareceu" — a frase mais comum de todas — casava aqui e a falta era
  // descartada como se a aula tivesse acontecido.
  if (
    /\b(aula (foi|deu) (otima|boa|certa)|consegui dar|deu certo|aula realizada|ela (veio|entrou)|ele (veio|entrou)|(?<!nao )compareceu)\b/
      .test(t)
  ) {
    return false;
  }

  // Sinal FORTE: a frase só faz sentido como "não teve aula". Como este
  // caminho só roda para quem É professor E tem experimental que começou nas
  // últimas 6 horas, o contexto já vem da situação — exigir a palavra "aula"
  // no texto rejeitaria o jeito como a professora realmente escreve
  // ("esperei 10 minutos e ninguém entrou").
  const forte =
    /\b(nao (compareceu|apareceu|veio|entrou|chegou)|nao deu as caras|ninguem (entrou|apareceu|veio)|no ?show)\b/
      .test(t) ||
    /\b(esperei|aguardei)\b.*\b(nao (veio|apareceu|entrou|chegou)|ninguem)\b/
      .test(t) ||
    /\b(sem sinal (do|da) alun|fiquei sozinh)\w*/.test(t);
  if (forte) return true;

  // Sinal FRACO: "faltou"/"ausente" sozinho é ambíguo (pode ser sobre pagamento,
  // material, outro aluno). Aí sim exige o assunto explícito.
  const fraco = /\b(faltou|ausente)\b/.test(t);
  if (!fraco) return false;
  return /\b(experimental|trial|aula|alun[oa]|lead|candidat[oa])\b/.test(t);
}

/**
 * Mensagem para o lead que faltou. Não cobra e não culpa: o objetivo é trazer
 * de volta, e quem some por uma hora costuma voltar se a porta ficar aberta.
 */
export function trialNoShowLeadMessage(opts: {
  leadName?: string | null;
  teacherName?: string | null;
  whenText?: string | null;
}): string {
  const nome = String(opts.leadName || "").trim().split(/\s+/)[0];
  const saudacao = nome ? `Oi, ${nome}!` : "Oi!";
  const teacher = String(opts.teacherName || "").trim();
  const quando = String(opts.whenText || "").trim();
  return (
    `${saudacao} Passando aqui porque a gente não conseguiu se encontrar na sua aula experimental${
      quando ? ` de ${quando}` : ""
    }${teacher ? ` com a Teacher ${teacher}` : ""}. 😊\n\n` +
    `Acontece! Se você ainda quiser conhecer a escola, eu remarco numa boa — me diz o melhor dia e horário para você que eu vejo com a professora.`
  );
}

/**
 * Aviso para o canal comercial: o lead faltou e foi chamado de volta.
 */
export function trialNoShowChannelMessage(opts: {
  leadName?: string | null;
  leadPhone?: string | null;
  teacherName?: string | null;
  whenText?: string | null;
}): string {
  const fone = String(opts.leadPhone || "").replace(/\D/g, "");
  return (
    `🔴 *Experimental — aluno não compareceu*\n\n` +
    `👤 ${String(opts.leadName || "lead").trim()}${
      fone ? ` — wa.me/${fone}` : ""
    }\n` +
    `👩‍🏫 ${String(opts.teacherName || "professor(a)").trim()}\n` +
    `🕐 ${String(opts.whenText || "horário não identificado")}\n\n` +
    `A professora avisou pelo WhatsApp. A falta já está registrada e o lead recebeu convite para remarcar.`
  );
}
