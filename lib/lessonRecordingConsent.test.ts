import { describe, expect, it } from 'vitest';
import {
  asDecision,
  consentErrorMessage,
  formatSendTime,
  missingContactLabel,
  notSentReasonLabel,
  resendAllowed,
  sendWindowText,
  consentLink,
  consentWhatsAppMessage,
  isFullName,
  normalizeSignerName,
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
