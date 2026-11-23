import { describe, expect, it } from 'vitest';
import { hubDisplayTitle } from './hubDisplayTitle';

describe('título de vitrine da biblioteca do Hub', () => {
  it('troca o título cru do acervo por um nome de verdade', () => {
    expect(hubDisplayTitle('BOOK B2 Part 1,2')).toBe('Livro B2 — Partes 1 e 2');
    expect(hubDisplayTitle('AULA EXPERIMENTAL KIDS A1')).toBe('Aula experimental Kids A1');
    expect(hubDisplayTitle('BOOK A1 WISE WOLF Part 3')).toBe('Livro A1 Wise Wolf — Parte 3');
    expect(hubDisplayTitle('TOEFL Trial Lesson B1/B2')).toBe('TOEFL Trial Lesson B1/B2');
  });

  it('não mexe em título que já está bom', () => {
    expect(hubDisplayTitle('Debate & Argument B2')).toBe('Debate & Argument B2');
    expect(hubDisplayTitle('English for Travelers A1')).toBe('English for Travelers A1');
  });
});
