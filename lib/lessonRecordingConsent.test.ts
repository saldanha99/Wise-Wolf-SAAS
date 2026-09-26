import { describe, expect, it } from 'vitest';
import {
  asDecision,
  asGuardianReason,
  codeErrorMessage,
  consentErrorMessage,
  formatSendTime,
  missingContactLabel,
  notSentReasonLabel,
  resendAllowed,
  sendWindowText,
  consentLink,
  consentWhatsAppMessage,
  formatWait,
  googleIdentityState,
  guardianReasonText,
  isFullName,
  isMissingRpcError,
  isSixDigitCode,
  normalizeSignerName,
  onlyDigits,
  whatsappDigits,
  whatsappUrl,
} from './lessonRecordingConsent';

describe('nome de quem autoriza', () => {
  it('normaliza espaços como o servidor', () => {
    expect(normalizeSignerName('  Maria   da  Silva ')).toBe('Maria da Silva');
  });

  it('exige nome e sobrenome', () => {
    expect(isFullName('Maria')).toBe(false);
    expect(isFullName('Maria Silva')).toBe(true);
    expect(isFullName('  Ana   Paula ')).toBe(true);
    expect(isFullName('A B')).toBe(false);
    expect(isFullName(`Maria ${'x'.repeat(120)}`)).toBe(false);
  });
});

describe('link e WhatsApp', () => {
  it('monta o link público com o token', () => {
    expect(consentLink('https://system.wisewolflanguage.com.br/', 'a'.repeat(64)))
      .toBe(`https://system.wisewolflanguage.com.br/registro-das-aulas?token=${'a'.repeat(64)}`);
  });

  it('põe o DDI 55 em número brasileiro sem ele', () => {
    expect(whatsappDigits('(11) 99999-0000')).toBe('5511999990000');
    expect(whatsappDigits('5511999990000')).toBe('5511999990000');
    expect(whatsappDigits('123')).toBeNull();
    expect(whatsappDigits(null)).toBeNull();
  });

  it('não abre WhatsApp sem telefone', () => {
    expect(whatsappUrl('', 'oi')).toBeNull();
    expect(whatsappUrl('11999990000', 'oi')).toBe('https://wa.me/5511999990000?text=oi');
  });

  it('fala com o responsável quando o aluno é menor', () => {
    const message = consentWhatsAppMessage({
      studentName: 'Pedro Fixture',
      schoolName: 'Escola Fixture',
      link: 'https://exemplo.invalid/x',
      forGuardian: true,
    });
    expect(message).toContain('Como Pedro é menor de idade');
    expect(message).toContain('https://exemplo.invalid/x');
    expect(message).toContain('sem vídeo');
  });

  it('fala direto com o aluno adulto', () => {
    const message = consentWhatsAppMessage({
      studentName: 'Ana Fixture',
      link: 'https://exemplo.invalid/y',
      forGuardian: false,
    });
    expect(message.startsWith('Olá, Ana!')).toBe(true);
    expect(message).toContain('a escola');
  });
});

describe('respostas do servidor', () => {
  it('traduz os códigos de erro', () => {
    expect(consentErrorMessage('ERROR: responsavel_obrigatorio')).toContain('responsável');
    expect(consentErrorMessage('link_expirado')).toContain('expirou');
    expect(consentErrorMessage('qualquer coisa')).toContain('Tente de novo');
    expect(consentErrorMessage(undefined)).toContain('Tente de novo');
  });

  it('decisão desconhecida vira "sem resposta"', () => {
    expect(asDecision('ACCEPTED')).toBe('ACCEPTED');
    expect(asDecision('REVOKED')).toBe('REVOKED');
    expect(asDecision('outra')).toBe('NONE');
    expect(asDecision(null)).toBe('NONE');
  });
});

describe('envio em lote', () => {
  it('mostra o horário de Brasília com o dia da semana', () => {
    // 26/09/2026 é sábado; 22:50 UTC = 19:50 em Brasília.
    expect(formatSendTime('2026-09-26T22:50:00Z')).toBe('sáb 26/09 às 19:50');
    expect(formatSendTime(null)).toBe('');
    expect(formatSendTime('não é data')).toBe('');
  });

  it('descreve a janela do lote no mesmo dia e atravessando o domingo', () => {
    expect(sendWindowText('2026-09-28T17:05:00Z', '2026-09-28T17:38:00Z')).toBe('seg 28/09, das 14:05 às 14:38');
    expect(sendWindowText('2026-09-26T22:50:00Z', '2026-09-28T12:12:00Z'))
      .toBe('de sáb 26/09 às 19:50 até seg 28/09 às 09:12');
    expect(sendWindowText('2026-09-28T17:05:00Z', '2026-09-28T17:05:00Z')).toBe('seg 28/09 às 14:05');
  });

  it('reenvio só depois da data que o servidor liberou', () => {
    const now = new Date('2026-09-28T12:00:00Z');
    expect(resendAllowed('2026-09-28T11:59:00Z', now)).toBe(true);
    expect(resendAllowed('2026-09-29T12:00:00Z', now)).toBe(false);
    expect(resendAllowed(null, now)).toBe(false);
  });

  it('diz o que falta cadastrar para quem está sem contato', () => {
    expect(missingContactLabel('idade_nao_cadastrada')).toContain('data de nascimento');
    expect(missingContactLabel('menor_sem_telefone_do_responsavel')).toContain('responsável');
    expect(missingContactLabel(undefined)).toContain('Sem telefone');
  });

  it('traduz o motivo de mensagem que não saiu', () => {
    expect(notSentReasonLabel('aluno_ja_decidiu')).toBe('respondeu antes do envio');
    expect(notSentReasonLabel('provider_http_400')).toBe('o WhatsApp recusou o envio');
    expect(notSentReasonLabel('qualquer')).toBe('não saiu');
  });

  it('traduz os erros do envio', () => {
    expect(consentErrorMessage('contagem_mudou')).toContain('Confira de novo');
    expect(consentErrorMessage('ERROR: reenvio_so_depois_de_3_dias')).toContain('3 dias');
  });
});

describe('responsável e idade (fail-closed)', () => {
  it('motivo fora da lista com responsável exigido vira idade desconhecida', () => {
    expect(asGuardianReason('MINOR')).toBe('MINOR');
    expect(asGuardianReason('KIDS', true)).toBe('KIDS');
    expect(asGuardianReason(null, true)).toBe('AGE_UNKNOWN');
    expect(asGuardianReason('outro', true)).toBe('AGE_UNKNOWN');
    expect(asGuardianReason(null, false)).toBeNull();
  });

  it('explica à família por que o responsável responde', () => {
    expect(guardianReasonText('AGE_UNKNOWN', 'Ana')).toContain('ainda não cadastrou a data de nascimento de Ana');
    expect(guardianReasonText('MINOR', 'Ana')).toContain('Como Ana é menor de idade');
    expect(guardianReasonText('KIDS', 'Ana')).toContain('menor de idade');
  });

  it('mensagem do link não chama de menor quem só não tem idade cadastrada', () => {
    const message = consentWhatsAppMessage({
      studentName: 'Bruno Fixture',
      link: 'https://exemplo.invalid/z',
      forGuardian: true,
      guardianReason: 'AGE_UNKNOWN',
    });
    expect(message).toContain('autorização do responsável por Bruno');
    expect(message).not.toContain('menor de idade');
    expect(message).toContain('código de 6 dígitos');
  });
});

describe('código do WhatsApp', () => {
  it('campo aceita só 6 números', () => {
    expect(onlyDigits('12a3-45678')).toBe('123456');
    expect(isSixDigitCode('123456')).toBe(true);
    expect(isSixDigitCode('12345')).toBe(false);
    expect(isSixDigitCode('12345a')).toBe(false);
  });

  it('erro do código diz as tentativas restantes e a espera', () => {
    expect(codeErrorMessage({ error: 'codigo_incorreto', attemptsLeft: 4 })).toContain('Restam 4 tentativas');
    expect(codeErrorMessage({ error: 'codigo_incorreto', attemptsLeft: 1 })).toContain('Resta 1 tentativa');
    expect(codeErrorMessage({ error: 'codigo_bloqueado' })).toContain('código novo');
    expect(codeErrorMessage({ error: 'limite_de_envios', retryAfterSeconds: 1200 })).toContain('Tente em 20 minutos');
    expect(codeErrorMessage({ error: 'telefone_nao_cadastrado' })).toContain('cadastrar');
  });

  it('formata a espera', () => {
    expect(formatWait(30)).toBe('30 segundos');
    expect(formatWait(60)).toBe('1 minuto');
    expect(formatWait(3000)).toBe('50 minutos');
    expect(formatWait(3600)).toBe('1 hora');
    expect(formatWait(null)).toBe('1 minuto');
  });

  it('o código mais específico vence na tradução do erro', () => {
    expect(consentErrorMessage('ERROR: teacher_google_identity_required')).toContain('conta Google');
    expect(consentErrorMessage('kids_classification_requires_direction')).toContain('infantil');
  });
});

describe('conta Google do professor', () => {
  it('rota ainda não publicada é indisponível, não erro', () => {
    expect(isMissingRpcError({ code: 'PGRST202', message: 'x' })).toBe(true);
    expect(isMissingRpcError({ code: '42883', message: 'x' })).toBe(true);
    expect(isMissingRpcError({ message: 'Could not find the function public.get_my_google_identity' })).toBe(true);
    expect(isMissingRpcError({ code: '42501', message: 'sem_permissao' })).toBe(false);
    expect(googleIdentityState(null, { code: 'PGRST202' })).toEqual({ status: 'unavailable' });
    expect(googleIdentityState(null, { code: '500', message: 'timeout' })).toEqual({ status: 'error' });
  });

  it('só conta como confirmada com e-mail e data de confirmação', () => {
    expect(googleIdentityState(null, null)).toEqual({ status: 'missing', email: null });
    expect(googleIdentityState({ email: 'p@gmail.com', verified_at: null }, null)).toEqual({ status: 'missing', email: 'p@gmail.com' });
    expect(googleIdentityState([{ email: 'p@gmail.com', verified_at: '2026-09-26T12:00:00Z' }], null))
      .toEqual({ status: 'verified', email: 'p@gmail.com', verifiedAt: '2026-09-26T12:00:00Z' });
  });
});
