/**
 * Auditoria DETERMINÍSTICA do gabarito gerado pela IA.
 *
 * Contexto: `correctIndex` é autoral do modelo. Um erro do modelo já marcou
 * "My name am Ana" como resposta correta enquanto a própria explicação dizia
 * "'My name is' usa 'is'". Este módulo tira da IA a palavra final.
 *
 * Princípio: a IA PROPÕE, o código VETA. Concordância de classe fechada
 * (pronome pessoal + cópula/auxiliar) é decidível sem modelo nenhum. Quando o
 * gabarito viola uma dessas regras, a questão é descartada antes de chegar ao
 * aluno — nunca "corrigida" por adivinhação.
 *
 * Regra de ouro: só rejeitamos com CERTEZA. Toda construção fora do alcance
 * das regras devolve `unknown` e segue o fluxo normal. Falso negativo (deixar
 * passar) é aceitável; falso positivo (derrubar questão boa) desperdiça
 * geração, então cada regra tem guardas explícitas contra ambiguidade.
 */

export type AuditStatus = "ok" | "unknown" | "rejected";

export interface AuditResult {
  status: AuditStatus;
  /** Código estável para log/telemetria. */
  code?: AuditRejectionCode;
  /** Detalhe legível (pt-BR) do que foi violado. */
  detail?: string;
}

export type AuditRejectionCode =
  | "KEY_FAILS_AGREEMENT"
  | "NO_VALID_OPTION"
  | "EXPLANATION_CONTRADICTS_KEY";

export interface AuditableQuestion {
  prompt: string;
  options: string[];
  correctIndex: number;
  explanationPt?: string;
}

// ─────────────────────────────────────────────────────────────
// Tabelas de classe fechada
// ─────────────────────────────────────────────────────────────

type Pronoun = "i" | "you" | "we" | "they" | "he" | "she" | "it";

interface PronounForms {
  bePresent: string;
  bePast: string;
  doForm: string;
  haveForm: string;
}

const PRONOUN_FORMS: Record<Pronoun, PronounForms> = {
  i: { bePresent: "am", bePast: "was", doForm: "do", haveForm: "have" },
  you: { bePresent: "are", bePast: "were", doForm: "do", haveForm: "have" },
  we: { bePresent: "are", bePast: "were", doForm: "do", haveForm: "have" },
  they: { bePresent: "are", bePast: "were", doForm: "do", haveForm: "have" },
  he: { bePresent: "is", bePast: "was", doForm: "does", haveForm: "has" },
  she: { bePresent: "is", bePast: "was", doForm: "does", haveForm: "has" },
  it: { bePresent: "is", bePast: "was", doForm: "does", haveForm: "has" },
};

const isPronoun = (word: string): word is Pronoun =>
  Object.prototype.hasOwnProperty.call(PRONOUN_FORMS, word);

const BE_PRESENT = new Set(["am", "is", "are"]);
const BE_PAST = new Set(["was", "were"]);
const DO_FORMS = new Set(["do", "does"]);
const HAVE_FORMS = new Set(["have", "has"]);

/** Advérbios/negação que podem ficar entre o sujeito e o verbo. */
const SKIPPABLE = new Set([
  "not",
  "never",
  "always",
  "really",
  "also",
  "just",
  "still",
  "only",
  "actually",
  "probably",
  "certainly",
  "definitely",
  "sometimes",
  "usually",
  "often",
  "rarely",
  "already",
  "even",
  "truly",
  "simply",
  "honestly",
  "totally",
  "completely",
]);

/** Sujeito coordenado vira plural — fora do alcance das regras. */
const COORDINATORS = new Set(["and", "or", "nor", "plus"]);

/** Interrogativas invertem a ordem: o sujeito vem depois do verbo. */
const WH_WORDS = new Set([
  "who",
  "what",
  "where",
  "when",
  "why",
  "how",
  "which",
  "whose",
]);

/** Auxiliar antes do sujeito ⇒ o verbo seguinte fica na forma nua. */
const AUXILIARIES = new Set([
  "do",
  "does",
  "did",
  "will",
  "would",
  "can",
  "could",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "to",
  "let",
  "please",
  "never",
]);

/** Gatilhos de subjuntivo ("if I were") — desligam a checagem de passado. */
const SUBJUNCTIVE_TRIGGERS = new Set([
  "if",
  "wish",
  "wishes",
  "wished",
  "suppose",
  "supposing",
  "imagine",
  "though",
  "although",
  "unless",
]);

const BLANK_PATTERN = /_{2,}/;
const BLANK_PATTERN_GLOBAL = /_{2,}/g;

// ─────────────────────────────────────────────────────────────
// Tokenização
// ─────────────────────────────────────────────────────────────

interface Token {
  word: string;
  /** Bloco delimitado por . ! ? ; : aspas ou parênteses. */
  clause: number;
  /** Havia um dígito colado antes (ex.: "9 am" = horário, não verbo). */
  digitBefore: boolean;
}

const CLAUSE_BREAKER = /[.!?;:"“”„()\[\]]/;
const WORD_PATTERN = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

function tokenize(text: string): Token[] {
  const normalized = text
    .replace(/[’‘‛]/g, "'")
    .replace(/n't\b/gi, " not")
    .replace(/'m\b/gi, " am")
    .replace(/'re\b/gi, " are")
    .replace(/'ve\b/gi, " have")
    .replace(/'ll\b/gi, " will");

  const tokens: Token[] = [];
  let clause = 0;
  let cursor = 0;
  WORD_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_PATTERN.exec(normalized)) !== null) {
    const gap = normalized.slice(cursor, match.index);
    if (CLAUSE_BREAKER.test(gap)) clause += 1;
    tokens.push({
      word: match[0].toLowerCase(),
      clause,
      digitBefore: /\d\s*$/.test(gap),
    });
    cursor = match.index + match[0].length;
  }
  return tokens;
}

function previousMeaningful(tokens: Token[], index: number): number | null {
  for (let i = index - 1; i >= 0; i--) {
    if (tokens[i].clause !== tokens[index].clause) return null;
    if (SKIPPABLE.has(tokens[i].word)) continue;
    return i;
  }
  return null;
}

function nextMeaningful(tokens: Token[], index: number): number | null {
  for (let i = index + 1; i < tokens.length; i++) {
    if (tokens[i].clause !== tokens[index].clause) return null;
    if (SKIPPABLE.has(tokens[i].word)) continue;
    return i;
  }
  return null;
}

/** "Ana and I are" — sujeito coordenado sai do alcance das regras. */
function isCoordinated(tokens: Token[], subjectIndex: number): boolean {
  const previous = tokens[subjectIndex - 1];
  return Boolean(
    previous &&
      previous.clause === tokens[subjectIndex].clause &&
      COORDINATORS.has(previous.word),
  );
}

/** "Does he have…" — auxiliar antes do sujeito exige verbo nu. */
function hasAuxiliaryBeforeSubject(
  tokens: Token[],
  subjectIndex: number,
): boolean {
  const clause = tokens[subjectIndex].clause;
  for (let i = subjectIndex - 1; i >= 0 && tokens[i].clause === clause; i--) {
    if (AUXILIARIES.has(tokens[i].word)) return true;
  }
  return false;
}

function hasSubjunctiveTrigger(tokens: Token[], verbIndex: number): boolean {
  const clause = tokens[verbIndex].clause;
  for (let i = verbIndex - 1; i >= 0; i--) {
    // O gatilho pode abrir a oração anterior ("If I were you, I would…").
    if (tokens[i].clause < clause - 1) break;
    if (SUBJUNCTIVE_TRIGGERS.has(tokens[i].word)) return true;
  }
  return false;
}

/**
 * Localiza o sujeito de um verbo. Ordem normal: token significativo anterior.
 * Interrogativa (verbo abrindo a oração ou depois de WH-word): token seguinte.
 */
function findSubject(tokens: Token[], verbIndex: number): number | null {
  const previous = previousMeaningful(tokens, verbIndex);
  if (previous === null || WH_WORDS.has(tokens[previous].word)) {
    return nextMeaningful(tokens, verbIndex);
  }
  return previous;
}

// ─────────────────────────────────────────────────────────────
// Regra 1 — concordância decidível
// ─────────────────────────────────────────────────────────────

export interface AgreementViolation {
  verb: string;
  subject: string;
  expected: string;
}

/**
 * Violações de concordância que podem ser afirmadas sem ambiguidade.
 * Cobre pronome pessoal + be/do/have e a regra universal de `am`
 * (só o pronome "I" licencia "am" — é o que reprova "My name am Ana").
 */
export function agreementViolations(text: string): AgreementViolation[] {
  const tokens = tokenize(text);
  const violations: AgreementViolation[] = [];

  tokens.forEach((token, index) => {
    const verb = token.word;
    const isBe = BE_PRESENT.has(verb) || BE_PAST.has(verb);
    const isDo = DO_FORMS.has(verb);
    const isHave = HAVE_FORMS.has(verb);
    if (!isBe && !isDo && !isHave) return;
    // "9 am" é horário, não cópula.
    if (verb === "am" && token.digitBefore) return;

    const subjectIndex = findSubject(tokens, index);
    if (subjectIndex === null) return;
    if (isCoordinated(tokens, subjectIndex)) return;

    const subject = tokens[subjectIndex].word;

    if (isPronoun(subject)) {
      const forms = PRONOUN_FORMS[subject];
      if (BE_PRESENT.has(verb) && verb !== forms.bePresent) {
        violations.push({ verb, subject, expected: forms.bePresent });
        return;
      }
      if (
        BE_PAST.has(verb) &&
        verb !== forms.bePast &&
        !hasSubjunctiveTrigger(tokens, index)
      ) {
        violations.push({ verb, subject, expected: forms.bePast });
        return;
      }
      if (isDo || isHave) {
        if (hasAuxiliaryBeforeSubject(tokens, subjectIndex)) return;
        const expected = isDo ? forms.doForm : forms.haveForm;
        if (verb !== expected) {
          violations.push({ verb, subject, expected });
        }
      }
      return;
    }

    // Sujeito não-pronominal: só a regra universal de `am` é decidível.
    if (verb === "am") {
      violations.push({ verb, subject, expected: "is/are" });
    }
  });

  return violations;
}

// ─────────────────────────────────────────────────────────────
// Montagem da frase a partir das lacunas
// ─────────────────────────────────────────────────────────────

const SEQUENCE_SEPARATORS = ["/", ";", ","];

export function countBlanks(prompt: string): number {
  const matches = prompt.match(BLANK_PATTERN_GLOBAL);
  return matches ? matches.length : 0;
}

/**
 * Preenche as lacunas do enunciado com uma alternativa.
 * Alternativas de múltiplas lacunas vêm como sequência ("is / like / am").
 * Devolve null quando não dá para mapear com segurança.
 */
export function fillBlanks(prompt: string, option: string): string | null {
  const blanks = countBlanks(prompt);
  if (blanks === 0) return null;

  const segments = prompt.split(BLANK_PATTERN_GLOBAL);
  let fillers: string[] | null = null;

  if (blanks === 1) {
    fillers = [option];
  } else {
    for (const separator of SEQUENCE_SEPARATORS) {
      const parts = option.split(separator).map((part) => part.trim());
      if (parts.length === blanks && parts.every(Boolean)) {
        fillers = parts;
        break;
      }
    }
  }
  if (!fillers) return null;

  return segments.reduce(
    (sentence, segment, index) =>
      index === 0 ? segment : `${sentence}${fillers[index - 1]}${segment}`,
    "",
  );
}

// ─────────────────────────────────────────────────────────────
// Regra 2 — explicação que contradiz o gabarito
// ─────────────────────────────────────────────────────────────

const QUOTED_PATTERNS = [
  /'([^']{2,80})'/g,
  /"([^"]{2,80})"/g,
  /[“„]([^”“]{2,80})[”]/g,
];

function quotedPhrases(text: string): string[] {
  const phrases: string[] = [];
  for (const pattern of QUOTED_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const phrase = match[1].trim();
      if (phrase) phrases.push(phrase);
    }
  }
  return phrases;
}

function sameVerbFamily(a: string, b: string): boolean {
  if (BE_PRESENT.has(a) || BE_PAST.has(a)) {
    return BE_PRESENT.has(b) || BE_PAST.has(b);
  }
  if (DO_FORMS.has(a)) return DO_FORMS.has(b);
  if (HAVE_FORMS.has(a)) return HAVE_FORMS.has(b);
  // Mesma raiz variando só o -s de 3ª pessoa ("goes" vs "go").
  return a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`;
}

function isVerbish(word: string): boolean {
  return (
    BE_PRESENT.has(word) ||
    BE_PAST.has(word) ||
    DO_FORMS.has(word) ||
    HAVE_FORMS.has(word)
  );
}

/**
 * A explicação costuma citar a forma certa entre aspas ("'My name is' usa
 * 'is'"). Se o gabarito produz outra flexão para o MESMO sujeito, o par
 * gabarito↔explicação está incoerente e a questão não pode ir ao ar.
 *
 * Guarda contra contraexemplo: só consideramos citações que já são
 * gramaticais pelas regras da Regra 1 — assim "não diga 'he have'" não
 * dispara rejeição.
 */
export function explanationContradiction(
  keyedSentence: string,
  explanationPt: string,
): string | null {
  if (!explanationPt) return null;
  const sentenceTokens = tokenize(keyedSentence);
  if (sentenceTokens.length < 2) return null;

  for (const phrase of quotedPhrases(explanationPt)) {
    if (agreementViolations(phrase).length > 0) continue; // contraexemplo
    const phraseTokens = tokenize(phrase);
    if (phraseTokens.length < 2) continue;

    for (let i = 1; i < phraseTokens.length; i++) {
      const quotedVerb = phraseTokens[i].word;
      const quotedSubject = phraseTokens[i - 1].word;
      if (!isVerbish(quotedVerb)) continue;

      for (let j = 1; j < sentenceTokens.length; j++) {
        if (sentenceTokens[j - 1].word !== quotedSubject) continue;
        const keyedVerb = sentenceTokens[j].word;
        if (keyedVerb === quotedVerb) continue;
        if (!sameVerbFamily(quotedVerb, keyedVerb)) continue;
        return `explicação cita "${quotedSubject} ${quotedVerb}" mas o gabarito produz "${quotedSubject} ${keyedVerb}"`;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Auditoria da questão
// ─────────────────────────────────────────────────────────────

/**
 * Veredito determinístico sobre o gabarito de UMA questão.
 *
 * `rejected` = temos prova de que o índice marcado como correto está errado
 * ou é incoerente com a explicação. Nunca devolvemos um índice "corrigido":
 * a questão sai de circulação e o fluxo cai no banco curado.
 */
export function auditQuestionKey(question: AuditableQuestion): AuditResult {
  const { prompt, options, correctIndex, explanationPt } = question;
  if (
    !prompt ||
    !Array.isArray(options) ||
    !Number.isInteger(correctIndex) ||
    correctIndex < 0 ||
    correctIndex >= options.length
  ) {
    return { status: "unknown" };
  }

  const keyedOption = options[correctIndex];
  const hasBlank = BLANK_PATTERN.test(prompt);
  const keyedSentence = hasBlank
    ? fillBlanks(prompt, keyedOption)
    : `${prompt} ${keyedOption}`;

  // Regra 1 — só decide quando a frase pôde ser montada.
  if (hasBlank && keyedSentence) {
    const filled = options.map((option) => fillBlanks(prompt, option));
    // Sem mapeamento completo das alternativas não há comparação justa.
    if (filled.every((sentence) => sentence !== null)) {
      const scores = filled.map((sentence) =>
        agreementViolations(sentence as string).length
      );
      const keyedScore = scores[correctIndex];
      if (keyedScore > 0) {
        const cleanAlternative = scores.some((score, index) =>
          index !== correctIndex && score === 0
        );
        const violation = agreementViolations(keyedSentence)[0];
        if (cleanAlternative) {
          return {
            status: "rejected",
            code: "KEY_FAILS_AGREEMENT",
            detail:
              `gabarito produz "${violation.subject} ${violation.verb}" (esperado "${violation.expected}") enquanto outra alternativa é gramatical`,
          };
        }
        return {
          status: "rejected",
          code: "NO_VALID_OPTION",
          detail:
            `nenhuma alternativa é gramatical; o gabarito produz "${violation.subject} ${violation.verb}"`,
        };
      }
    }
  }

  // Regra 2 — independe da montagem completa das alternativas.
  if (keyedSentence && explanationPt) {
    const contradiction = explanationContradiction(
      keyedSentence,
      explanationPt,
    );
    if (contradiction) {
      return {
        status: "rejected",
        code: "EXPLANATION_CONTRADICTS_KEY",
        detail: contradiction,
      };
    }
  }

  return keyedSentence ? { status: "ok" } : { status: "unknown" };
}
