import { describe, expect, it } from 'vitest';
import {
  asDecision,
  consentErrorMessage,
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
