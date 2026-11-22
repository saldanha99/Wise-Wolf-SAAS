import { afterEach, describe, expect, it } from 'vitest';
import { brandText, getTutorName, setTutorName } from './tutorBrand';

describe('tutorBrand', () => {
  afterEach(() => setTutorName(undefined));
  it('mantém o Wolfie por padrão', () => {
    expect(getTutorName()).toBe('Wolfie');
    expect(brandText('Praticar com o Wolfie')).toBe('Praticar com o Wolfie');
  });
  it('troca só a palavra inteira pelo nome da escola', () => {
    setTutorName(' Luna ');
    expect(brandText('Praticar com o Wolfie')).toBe('Praticar com Luna');
    expect(brandText('Toque no Wolfie para falar')).toBe('Toque em Luna para falar');
    expect(brandText('memória do Wolfie. O Wolfie mudou')).toBe('memória de Luna. Luna mudou');
    expect(brandText('WolfieLab e Wolfie Tutor')).toBe('WolfieLab e Luna Tutor');
  });
  it('limpa nome perigoso e cai no padrão se vazio', () => {
    setTutorName('<script>');
    expect(getTutorName()).toBe('script');
    setTutorName('   ');
    expect(getTutorName()).toBe('Wolfie');
  });
});
