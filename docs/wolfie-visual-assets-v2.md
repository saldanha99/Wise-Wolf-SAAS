# Wolfie Visual Assets V2 — carreira, eventos e lock verificável

> Versão: 2
> Data: 1º de agosto de 2026
> Estado: publicado em produção na release `20260802T022645Z-745c73755821`
> Escopo: três experiências de carreira, três experiências de eventos e
> endurecimento do inventário visual

## 1. Resumo

O lote V2 acrescenta seis ambientes originais ao Wolf Tutor:

- carreira: `job-interviews`, `career-networking` e `promotion`;
- eventos: `talks`, `trade-shows` e `medical-congresses`.

Os fundos foram produzidos com o ImageGen integrado ao Codex, em modo built-in,
como ambientes 3D cinematográficos realistas estilizados. Imagens anteriores da
Wise Wolf foram usadas somente como referência de acabamento, iluminação e
profundidade; nenhuma arquitetura foi copiada. A Praktika permanece apenas como
referência conceitual de presença e imersão, sem reutilização de asset,
personagem, interface ou composição proprietária.

Nenhum prompt ou arquivo contém aluno, rosto real, dado pessoal, dado clínico,
marca, logo, texto rasterizado ou informação de empresa. As fontes aprovadas
ficam fora do runtime; somente os WebPs finais em `public/assets/wolfie/` são
consumidos pela aplicação.

## 2. Inventário final

| Experiência | Fonte ImageGen aprovada | Desktop | Mobile |
|---|---|---|---|
| `job-interviews` | `exec-b4db3f7b-da5c-41ba-af0c-514cd5a78dd0.png` | `desktop.dc0f18a9a9dc.webp` | `mobile.f52093d7182f.webp` |
| `career-networking` | `exec-882145be-3aa3-4965-852a-dcbb5cc96439.png` | `desktop.81efc6d17664.webp` | `mobile.27130ba290bd.webp` |
| `promotion` | `exec-3f04d1bd-8a02-4102-8684-7d51021f5a1c.png` | `desktop.23a201d28af8.webp` | `mobile.e2b1eaf5674f.webp` |
| `talks` | `exec-f1a565e9-cad6-4208-be4e-bc51ba242f9b.png` | `desktop.3caabfba1153.webp` | `mobile.37bec22ebd53.webp` |
| `trade-shows` | `exec-306f12c9-af13-43de-a61b-328635d272ac.png` | `desktop.8d9bfdb96dd1.webp` | `mobile.f7716d273068.webp` |
| `medical-congresses` | `exec-a41d1dad-6c75-43a3-a985-584f6d6e0fa4.png` | `desktop.e7cdb4fbc2b9.webp` | `mobile.18951655e993.webp` |

As fontes possuem `1672 × 941`. Cada fonte aprovada originou:

- desktop `1600 × 900`, WebP, orçamento máximo de 320.000 bytes;
- mobile `900 × 1200`, WebP, orçamento máximo de 180.000 bytes;
- crop central inspecionado para manter contexto e a região do personagem.

## 3. Contrato de cache e integridade

O Nginx publica `/assets/` com cache imutável de um ano. Por isso, todos os
fundos e o personagem manifestados usam os primeiros 12 caracteres do SHA-256
na URL. O lote V2 também migra os nomes V1 para esse contrato, sem alterar seus
bytes.

Regras obrigatórias:

1. nunca substituir os bytes de uma URL já publicada;
2. qualquer regeneração cria novo WebP e nova URL fingerprintada;
3. a URL antiga permanece disponível enquanto algum cliente puder referenciá-la;
4. `visualAssetManifest.json` é o lock machine-readable de URL, dimensão, bytes,
   orçamento, SHA-256 e fonte ImageGen;
5. o catálogo resolve assets pelo manifesto, não por convenção de nome;
6. testes rejeitam arquivo ausente, truncado, fora do orçamento, com dimensão ou
   checksum divergente e fingerprint incompatível.

O catálogo passa a referenciar exclusivamente as novas URLs imutáveis. Os 25
endereços V1 sem fingerprint continuam presentes, travados pelos mesmos hashes,
como aliases de transição para sessões e bundles já abertos. Eles não são usados
por código novo e só devem ser removidos em uma release posterior, após a janela
de cache; nenhuma URL fingerprintada pode ter seus bytes substituídos.

## 4. Prompt-base

```text
Use case: stylized-concept
Asset type: full-screen background for a Wolf Tutor interactive English
training experience.

Create an original premium 3D environment in cinematic stylized realism, with
convincing materials, human eye-level camera and clear foreground, midground and
background. Deliver the environment only: no character and no interface.

Use a widescreen 16:9 composition. Reserve the requested third as a calm,
low-contrast open zone for a full-body interactive character. Keep the central
crop meaningful at mobile 3:4 and preserve calm zones for HTML HUD, captions and
controls.

Do not include people, identifiable faces, hands, embedded text, pseudo-text,
letters, numbers, logos, brands, trademarks, emblems, flags, watermarks,
readable documents, readable screens, personal data or company identity. Do not
imitate or reproduce Praktika assets or composition.
```

## 5. Variações aprovadas

| Experiência | Direção combinada com o prompt-base |
|---|---|
| `job-interviews` | Sala contemporânea e acolhedora de entrevista, duas cadeiras e mesa compacta; azul-marinho/slate com luz profissional; região direita livre; sem currículo ou identidade de empregador. |
| `career-networking` | Lounge internacional sofisticado, madeira, vidro e grupos de mobiliário à esquerda; região direita escura e vazia; sem pessoas, crachás ou marca de evento. |
| `promotion` | Sala privada de desenvolvimento de liderança, mesa baixa e duas poltronas à direita; luz quente com preenchimento azul; região esquerda livre; sem avaliações, salário, certificado ou símbolo de poder. |
| `talks` | Auditório íntimo com palco escultórico e superfície de apresentação totalmente vazia; violeta/coral sobre plum; região esquerda livre; sem palestrante, plateia ou slide rasterizado. |
| `trade-shows` | Estande modular premium totalmente genérico e vazio; lavanda/rose sobre aubergine; corredor esquerdo livre e foco no centro-direita; sem produto, letreiro ou trade dress. |
| `medical-congresses` | Corredor e sala premium de congresso, superfícies vazias e arquitetura violeta/âmbar com acento clínico; região esquerda livre; sem anatomia, paciente, exame, pôster ou alegação médica. |

## 6. Checksums e orçamento

| Experiência | Desktop: bytes / SHA-256 | Mobile: bytes / SHA-256 |
|---|---|---|
| `job-interviews` | 74.254 / `dc0f18a9a9dcc00280878034b33bdfb22c3a17b388c9795a17d5df84151a0c64` | 44.076 / `f52093d7182f43fd3da68bdc9a3ea795506772a7051c20c68cbd26eb1145dd66` |
| `career-networking` | 70.650 / `81efc6d17664aec808dd08b13fba1a2b9a650069c07c895d7764efa64f9e58c3` | 46.386 / `27130ba290bde9ac4a919ef3ae935993265f4377ead4db4c3d39543c5b533f55` |
| `promotion` | 56.184 / `23a201d28af8a9a7eed42522febd880b5b8a7ace0f308aa4d5164a3c03c04ed3` | 37.384 / `e2b1eaf5674f5526bbe48b5a46f603a8caa6118b563d98a02320a78482d72da1` |
| `talks` | 45.578 / `3caabfba1153419637897712e5f6683ffed88f56ced6bb6ab49714c1d1b0789b` | 28.064 / `37bec22ebd53dc1290e0b4e09807150b7728fb510192d727591bbf0fa79a50b3` |
| `trade-shows` | 106.354 / `8d9bfdb96dd147e4ceb04ddb87906452ab8de8b8a0dad0bfbb2078e4897c471a` | 52.840 / `f7716d27306837ab1409a786bdf1d39d08e8a48871041af03ded644ed4ac62eb` |
| `medical-congresses` | 103.162 / `e7cdb4fbc2b924a7df2ac1da9953d4d13b374ac1f84f9a8001200c2a286e9333` | 49.496 / `18951655e993be46377460f39f56d03327351fcf7c48b9855e7ba1de286018d8` |

## 7. QA e rollout executados

Concluído:

- inspeção visual das seis fontes desktop;
- inspeção conjunta dos seis recortes mobile;
- dimensões e decodificação confirmadas;
- todos os arquivos dentro do orçamento;
- 18 testes focais e 60 testes da suíte completa aprovados;
- typecheck aprovado;
- build de produção aprovado com a flag V2 ativa;
- 62/62 caminhos verificados em `public` e `dist`: 37 assets primários e
  25 aliases de transição;
- QA integrado aprovado nos seis cenários em `1440 × 900` e `390 × 844`, sem
  overflow horizontal e com os recortes desktop/mobile corretos;
- nenhum texto, logo, marca, pessoa ou dado detectado na revisão visual;
- release transacional concluído a partir do commit `f1ee474d99eb`;
- backup reversível:
  `/opt/wisewolf/backups/release-20260802T022645Z-745c73755821`;
- 62/62 URLs aprovadas no smoke remoto com MIME, bytes e SHA-256;
- frontend e Hub em `200`; marcador remoto confirmado na release acima;
- 14 recursos carregados em navegação headless de produção — os 12 novos
  recortes, personagem fingerprintado e um alias legado — sem erro de página;
- navegador headless encerrado e nenhuma sessão residual.

Os 38 perfis sem bitmap próprio continuam no fallback visual determinístico.
