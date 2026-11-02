import { readFileSync, writeFileSync } from 'node:fs';
import { teacherPjClauses } from '../lib/teacherPjContract';

// Minuta sem dados reais. A mesma fonte das cláusulas 1–10 é usada pelo aplicativo.
const clauses = teacherPjClauses(0).map(clause => ({ ...clause,
  paragraphs: clause.paragraphs.map(text => text.replace('R$ 0,00', 'R$ [honorário contratado]')),
}));
const source = readFileSync('components/TeacherContractDocument.tsx', 'utf8');
const recording = source.slice(source.indexOf('function TeacherLessonRecordingClause()'), source.indexOf('interface TeacherContractProps'));
const recordingParagraphs = [...recording.matchAll(/<p className="text-justify">([\s\S]*?)<\/p>/g)]
  .map(match => match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
if (recordingParagraphs.length !== 8) throw new Error('Cláusula 11ª não foi extraída integralmente');
clauses.push({ title: 'CLÁUSULA 11ª – REGISTRO DAS AULAS', paragraphs: recordingParagraphs });
const intro = `# Contrato geral do professor PJ — versão 3

Minuta revisada em 26/10/2026, para identificação e formalização futura. Não é contrato assinado, não substitui as vias anteriores e não comprova ausência de relação de emprego. O modelo da versão 3 é mantido junto ao código; este documento não constitui assinatura.

## Identificação das partes

CONTRATANTE: [razão social da escola], CNPJ [preencher], sede [endereço], representada por [nome e qualificação do representante]. Contatos oficiais: [e-mail e WhatsApp]. Cidade/UF: [preencher].

CONTRATADA: [razão social ou nome empresarial], CNPJ [preencher], sede [endereço da empresa], representada por [nome], CPF [preencher], que declara poderes para obrigá-la. Professor executor inicialmente indicado: [nome]. Na Cláusula 11ª, “CONTRATADO” designa o professor executor quanto ao registro de suas aulas e aos direitos sobre seus dados.

VERSÃO: 3. DATA DA ASSINATURA E INÍCIO: [preencher]. HONORÁRIOS POR AULA DE 30 MINUTOS: [preencher]. CANAL PARA COMUNICAÇÕES E ENCERRAMENTO: [preencher].

`;
const body = clauses.map(clause => `## ${clause.title}\n\n${clause.paragraphs.join('\n\n')}\n`).join('\n');
writeFileSync('docs/legal/contrato-geral-professor-pj-v3.md', intro + body + `
## Assinaturas e comprovantes

As partes firmam este instrumento por meio eletrônico, com acesso ao texto integral e ao comprovante das manifestações. Identificar signatários, poderes de representação, data, versão e mecanismo de prova utilizado.

CONTRATANTE: [representante da escola]. CONTRATADA: [representante da empresa]. Local e data: [preencher]. Identificadores das manifestações e da versão integral: [preencher]. Não inserir imagem de assinatura como se fosse aceite real.

## Aplicação e revisão

O prazo de 30 dias é uma estipulação contratual bilateral, não um mínimo universal do art. 599 do Código Civil. Esse artigo prevê oito dias na hipótese de retribuição fixada por mês ou mais, quatro dias para semana ou quinzena e aviso de véspera para contratação inferior a sete dias, nas condições de sua aplicação. A natureza da relação depende dos fatos. O modelo demanda conferência trabalhista e fiscal da operação antes da adoção.

Para professores com contrato já assinado, usar aditivo próprio com concordância expressa, preservando os direitos anteriores e definindo os efeitos futuros. O fluxo de aceite deste código não força nova assinatura nem substitui contratos anteriores. A assinatura por aluno ainda depende de implementação própria.

## Fontes oficiais

- Código Civil, arts. 393, 408–416, 421–422, 473 e 593–607: https://www.planalto.gov.br/ccivil_03/leis/2002/l10406compilada.htm
- CLT, arts. 2º, 3º, 9º e 442-B: https://www.planalto.gov.br/ccivil_03/decreto-lei/del5452.htm
- STF, Tema 1.389 (situação consultada em 26/10/2026): https://portal.stf.jus.br/jurisprudenciaRepercussao/verAndamentoProcesso.asp?classeProcesso=ARE&incidente=7138684&numeroTema=1389
- MP nº 2.200-2/2001, art. 10: https://www.planalto.gov.br/ccivil_03/mpv/antigas_2001/2200-2.htm
- LGPD: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm
`);
console.log('Minuta v3 exportada das cláusulas do aplicativo, sem dados reais.');
