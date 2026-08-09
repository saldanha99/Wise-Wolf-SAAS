import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PROFILE_COLUMNS, isProfileColumn } from './profileColumns';

// Guarda contra a classe de bug mais cara e mais silenciosa deste projeto:
// mandar num UPDATE de `profiles` um campo que NÃO é coluna.
//
// O PostgREST não ignora o campo desconhecido — ele derruba o comando inteiro.
// Resultado: nada é salvo, e a mensagem de erro fala de um campo que o usuário
// nem tocou. Em 09/08/2026 isso estava quebrando cinco caminhos de salvamento,
// entre eles trocar o telefone do aluno e cadastrar a chave PIX do professor.
//
// O teste lê o CÓDIGO-FONTE, não o banco: roda offline, no mesmo lugar em que o
// erro nasce, e falha no CI antes de chegar na tela de alguém.

const arquivos = execFileSync('git', ['ls-files', '*.tsx', '*.ts'], { encoding: 'utf8' })
    .split('\n')
    .filter(f => f && !f.includes('node_modules') && !f.endsWith('profileColumns.ts') && !f.endsWith('profileColumns.test.ts'));

/** Objeto literal que começa em `abre`, com as chaves equilibradas. */
const literalEm = (texto: string, abre: number): string | null => {
    let nivel = 0;
    for (let i = abre; i < Math.min(abre + 4000, texto.length); i++) {
        if (texto[i] === '{') nivel++;
        else if (texto[i] === '}') {
            nivel--;
            if (nivel === 0) return texto.slice(abre, i + 1);
        }
    }
    return null;
};

interface Escrita { arquivo: string; linha: number; campo: string }

const escritasEmProfiles = (): Escrita[] => {
    const achados: Escrita[] = [];

    for (const arquivo of arquivos) {
        let src = '';
        try { src = readFileSync(arquivo, 'utf8'); } catch { continue; }
        if (!src.includes("'profiles'") && !src.includes('"profiles"')) continue;

        // Payload passado por VARIÁVEL: .from('profiles').update(updates)
        const porVariavel = new Set(
            [...src.matchAll(/\.from\(\s*['"]profiles['"]\s*\)[\s\S]{0,200}?\.(?:update|insert|upsert)\(\s*([A-Za-z_$][\w$]*)/g)]
                .map(m => m[1]),
        );

        for (const m of src.matchAll(/\{/g)) {
            const abre = m.index!;
            const antes = src.slice(Math.max(0, abre - 260), abre);
            const inline = /from\(\s*['"]profiles['"]\s*\)[\s\S]{0,200}?\.(?:update|insert|upsert)\(\s*$/.test(antes);
            const declarado = [...porVariavel].some(v =>
                new RegExp(`\\b(?:const|let|var)\\s+${v}\\b[^=]*=\\s*$`).test(antes));
            if (!inline && !declarado) continue;

            const corpo = literalEm(src, abre);
            if (!corpo) continue;
            const linha = src.slice(0, abre).split('\n').length;
            for (const c of corpo.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gm)) {
                achados.push({ arquivo, linha, campo: c[1] });
            }
        }

        // Atribuição fora do literal: updatePayload.campo = ...
        // `=(?!=)` é obrigatório: sem isso, `payload.error === true` era lido
        // como atribuição e virava falso positivo em edge function que nem
        // escreve em profiles.
        for (const m of src.matchAll(/\b(?:updates?|updatePayload|profilePayload|payload)\.([a-z_][a-z0-9_]*)\s*=(?!=)/g)) {
            achados.push({ arquivo, linha: src.slice(0, m.index!).split('\n').length, campo: m[1] });
        }
    }
    return achados;
};

describe('colunas gravadas em profiles', () => {
    it('o fixture reflete o banco (140 colunas em 09/08/2026)', () => {
        expect(PROFILE_COLUMNS.length).toBeGreaterThan(100);
        expect(isProfileColumn('phone')).toBe(true);
        expect(isProfileColumn('pix_key')).toBe(true);
        // As duas que quebravam a tela — se voltarem a existir como coluna,
        // atualize o fixture e este teste junto.
        expect(isProfileColumn('correction_preference')).toBe(false);
        expect(isProfileColumn('updated_at')).toBe(false);
    });

    it('nenhuma tela grava campo que não é coluna de profiles', () => {
        const fantasmas = escritasEmProfiles().filter(e => !isProfileColumn(e.campo));
        const relatorio = fantasmas
            .map(e => `  ${e.arquivo}:${e.linha} → "${e.campo}" não é coluna de profiles`)
            .join('\n');
        expect(relatorio, `\nO PostgREST derruba o UPDATE INTEIRO quando recebe campo desconhecido:\n${relatorio}\n`).toBe('');
    });

    it('a varredura realmente enxerga as escritas (senão passaria vazia por engano)', () => {
        // Sem esta âncora, um regex quebrado faria o teste acima "passar" sempre.
        const campos = new Set(escritasEmProfiles().map(e => e.campo));
        expect(campos.size).toBeGreaterThan(20);
        expect(campos.has('phone')).toBe(true);
    });
});
