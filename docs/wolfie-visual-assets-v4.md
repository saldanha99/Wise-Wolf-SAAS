# Wolfie Visual Assets V4 — provas internacionais e laboratórios

> Versão: 4
> Data: 2 de agosto de 2026
> Estado: integração e QA local aprovados; rollout em produção pendente
> Escopo: cinco experiências de provas internacionais e cinco laboratórios de habilidade

## 1. Resumo

O lote V4 prepara dez ambientes originais para o Wolf Tutor:

- provas internacionais: `exam-cambridge`, `exam-toefl`, `exam-ielts`,
  `exam-toeic` e `exam-duolingo`;
- laboratórios de habilidade: `listening-lab`, `pronunciation-lab`,
  `writing-lab`, `vocabulary-lab` e `presentation-lab`.

Os fundos foram produzidos com o ImageGen integrado ao Codex como ambientes 3D
cinematográficos realistas estilizados. A Praktika foi usada somente como
referência conceitual de presença e imersão. Nenhum asset, personagem, sala,
interface, paleta ou composição proprietária foi reproduzido.

As imagens não contêm aluno, pessoa, rosto, mão, corpo, silhueta, marca, logo,
texto, pseudotexto, glifo, letra, número, bandeira, dado, documento legível,
tela legível, gráfico ou interface embutida. A cena de `exam-duolingo` também
evita verde vivo, coruja, mascote e qualquer elemento de identidade visual do
serviço citado pelo nome canônico da experiência. Todo conteúdo pedagógico,
legenda e controle permanece em HTML acessível. As fontes aprovadas são
preservadas fora do runtime; somente os WebPs finais em
`public/assets/wolfie/` serão consumidos pela aplicação.

## 2. Inventário integrado

| Experiência | Fonte ImageGen aprovada | Desktop | Mobile |
|---|---|---|---|
| `exam-cambridge` | `exec-0aecc5f4-97da-4b4d-aa6c-4be87494ffc9.png` | `desktop.373af4b139ed.webp` | `mobile.688a19261164.webp` |
| `exam-toefl` | `exec-059dc707-ca39-4d38-90f8-1a096c6f16c1.png` | `desktop.83ff1f067209.webp` | `mobile.20ceb502ea7e.webp` |
| `exam-ielts` | `exec-82c78033-d776-4052-b9be-25e5dee016dd.png` | `desktop.4f221c48a062.webp` | `mobile.3a5749e66232.webp` |
| `exam-toeic` | `exec-ae99ae0a-7d80-4022-9d6c-ab64a02bea6f.png` | `desktop.d55736018355.webp` | `mobile.efac6eb29b58.webp` |
| `exam-duolingo` | `exec-15edcf76-824d-40a8-9b8b-a6ecff637ac9.png` | `desktop.3dae9089c6e8.webp` | `mobile.1d27c40da778.webp` |
| `listening-lab` | `exec-fd775873-4967-4bb9-96f6-7d20258db133.png` | `desktop.47c78d7f2bf1.webp` | `mobile.3aa5fe898afa.webp` |
| `pronunciation-lab` | `exec-c2255670-0041-4edb-bd90-83212b844cb6.png` | `desktop.e8e29b402c75.webp` | `mobile.1777972f5b87.webp` |
| `writing-lab` | `exec-ebede0ec-095d-4c6c-9347-052a2e5644c7.png` | `desktop.af0947bf245b.webp` | `mobile.af7d7b7788c0.webp` |
| `vocabulary-lab` | `exec-9dae4fdd-e38d-42f7-9cce-0c56903b052d.png` | `desktop.257f75f59101.webp` | `mobile.b8be1192783b.webp` |
| `presentation-lab` | `exec-f1daa406-f3f5-4651-b17b-3f0b3e21d160.png` | `desktop.45863e9a8305.webp` | `mobile.fc85426ad26c.webp` |

Todas as fontes aprovadas possuem `1672 × 941`. Cada uma originou:

- desktop `1600 × 900`, WebP, orçamento máximo de 320.000 bytes;
- mobile `900 × 1200`, WebP, orçamento máximo de 180.000 bytes;
- crop central preparado para manter contexto e espaço útil para personagem,
  HUD, legenda e controles.

## 3. Prompt-base

```text
Use case: stylized-concept.
Asset type: full-screen background for a Wolf Tutor interactive English
training experience.

Create an original premium 3D environment in cinematic stylized realism, with
convincing materials, human eye-level camera and clear foreground, midground and
background. Deliver the environment only: no character and no interface.

Use a widescreen 16:9 composition. Reserve the requested third as a calm,
low-contrast open zone for a later full-body interactive character. Keep the
central crop meaningful at mobile 3:4 and preserve calm zones for accessible
HTML HUD, captions and controls.

Do not include people, identifiable faces, hands, bodies, silhouettes,
embedded text, pseudo-text, glyphs, letters, numbers, logos, brands,
trademarks, flags, watermarks, readable documents, readable screens, charts,
data, user interface or character. Do not imitate or reproduce any Praktika
asset or composition.
```

## 4. Direções aprovadas

| Experiência | Direção combinada com o prompt-base |
|---|---|
| `exam-cambridge` | Sala oral clássica e sóbria em madeira e azul, com duas poltronas e mesa neutra à esquerda e grande parede direita calma; sem identidade oficial do exame. |
| `exam-toefl` | Cabine moderna de prova por computador com monitor apagado, microfone e fone totalmente genéricos; área esquerda escura e livre; sem interface ou marca. |
| `exam-ielts` | Sala individual de speaking, acolhedora e silenciosa, com cadeira e mesa redonda à esquerda e parede direita ampla; sem examinador, documento ou sinalização. |
| `exam-toeic` | Centro corporativo de avaliação abstrato com mobiliário modular à direita e grande área azul livre à esquerda; sem tela, instrução ou identidade empresarial. |
| `exam-duolingo` | Mesa doméstica neutra de prova remota com monitor apagado, webcam e microfone genéricos à direita; área esquerda calma; sem verde vivo, coruja, mascote, marca ou trade dress. |
| `listening-lab` | Laboratório acústico com fones, caixas e painéis de absorção; região direita calma; sem onda, indicador, texto ou marca. |
| `pronunciation-lab` | Estúdio de voz com microfone e filtro antipop genéricos à direita e parede esquerda livre; sem inscrição ou leitura visual incorporada. |
| `writing-lab` | Estação editorial minimalista com papel totalmente em branco e fólio fechado à esquerda; região direita clara e calma; sem letra, documento legível ou interface. |
| `vocabulary-lab` | Laboratório de objetos cotidianos neutros e sem rótulo, organizados à direita; área esquerda livre para personagem e conteúdo acessível. |
| `presentation-lab` | Palco de ensaio vazio com superfície de apresentação totalmente em branco à esquerda e área direita mais calma; sem plateia, gráfico, dado ou texto. |

## 5. Decisões conservadoras de QA visual

- Em `exam-cambridge`, `exec-0c9877d8-4c24-4cfa-adc7-908112f63b6e.png`
  foi rejeitada porque a primeira cadeira saía do recorte; a tentativa
  `exec-a93ecc91-b623-436b-b53b-4495a7b69ba6.png` também foi descartada porque
  a cadeira esquerda ainda ficava excessivamente cortada.
- Em `exam-toefl`, `exec-4e87a475-d49e-4747-a7e5-e2645b3d7c61.png` foi
  rejeitada porque monitor e acessórios estavam deslocados demais à direita;
  `exec-9ea11cfe-8a31-4b5c-8054-48f57ea37d4e.png` ainda não preservava a
  estação inteira no recorte vertical.
- Em `listening-lab`, `exec-01d179e8-749b-4dda-802b-34a785ab52f7.png` foi
  rejeitada porque o suporte do fone desaparecia no recorte mobile central.
- Em `pronunciation-lab`, `exec-bd8cca77-d844-4c90-a202-29d506f25071.png` foi
  rejeitada por pequenas marcas semelhantes a inscrição no microfone.
- Não houve rejeição reportada para `exam-ielts`, `exam-toeic`,
  `exam-duolingo`, `writing-lab`, `vocabulary-lab` ou `presentation-lab`.

## 6. Checksums das fontes aprovadas

| Experiência | SHA-256 da fonte `1672 × 941` |
|---|---|
| `exam-cambridge` | `5ec9b8d2ed5872db3d558684ec57b8fe06c89dd1fd368b0baa0128c64317bc15` |
| `exam-toefl` | `64181260e8ce3b53a1036b661e41d3ee811f998d93ea87686fa7dbefa840ed51` |
| `exam-ielts` | `3b675400f80c8590b1414246610252d95a39d0f7805b66ea61cf36e30ca8382d` |
| `exam-toeic` | `8453c798b481fd77ab61305c261c66b7de96592c7c2b66537ecce5605891c8eb` |
| `exam-duolingo` | `a6fcefd9c24d871b0d5112bb1a34c02da6646d6190c96b98263e32f45fe3305d` |
| `listening-lab` | `a728b8ceacbec887f9030d6613f1be1a65afe21a56aef70846ad53a1dbca61a0` |
| `pronunciation-lab` | `ea77771918ccbbf80e2eef43b958148edd2d33b882e682a0626dfbd4430c7361` |
| `writing-lab` | `31cdd7bffcb74aa954ce9c743d52e9b0963ad5ea189658873366878fa4c49702` |
| `vocabulary-lab` | `96ab55324962ee649d01e14b1e57679b465aa7d10940ec9830d26f48c53dacfa` |
| `presentation-lab` | `cee854dbb73ac55e5f71b1564ef089bb119f052a02cfa896627bd3d55305954a` |

## 7. Checksums e orçamento dos WebPs

| Experiência | Desktop: bytes / SHA-256 | Mobile: bytes / SHA-256 |
|---|---|---|
| `exam-cambridge` | 81.762 / `373af4b139edac3758071879c794451afdcaf84caa0d8ce04959dc4b96392b50` | 38.242 / `688a1926116452746306720c0aa67f790b4e93787a9e15c9622dfad054d08e43` |
| `exam-toefl` | 75.962 / `83ff1f067209efc1382ec3ac736c56ab153669e045fe8c9f1ccf72fbc0593c77` | 42.626 / `20ceb502ea7e76dd75a9a31da13e44a0cd876a7e7c0d7666b699c81becf8fcc0` |
| `exam-ielts` | 75.990 / `4f221c48a062207d45c5a6c040f0f26f119f94561443f65ccbdd627abd0bbc77` | 39.316 / `3a5749e66232e28d433f609f695cc65c09e609ee76a29a76b2e91c0968058f76` |
| `exam-toeic` | 55.432 / `d557360183555d4f1fda72c3c1084f715d7abaa9b2cc1f489ff82f196772ca17` | 30.244 / `efac6eb29b586e38e46bced720c5710519ff5309e867a2b3f08389852ef6754d` |
| `exam-duolingo` | 42.238 / `3dae9089c6e8f9cd17c4ca517b7fb00d0a29900cf5038e7bd3ba2f07b6637c2f` | 19.214 / `1d27c40da778b3224eab514df1cb6840d96c4400250340323c68c1ee2e9d180e` |
| `listening-lab` | 88.694 / `47c78d7f2bf13c2cc7da8fbeec84340a1e924fb7085676f265f1e9c567bc477b` | 54.392 / `3aa5fe898afa6ba264023bc97de293c277b0ba6ec42abcf1c216d322f70fa584` |
| `pronunciation-lab` | 53.438 / `e8e29b402c7571803ac23d8d172b8518106cd0f213bbc73b5600e3800a2f7343` | 31.546 / `1777972f5b87628d0be86f507d642b7a6fbf9c3c03dd868573d6231280a7527f` |
| `writing-lab` | 51.874 / `af0947bf245b4775eb08dcaa7abc165d7ac0952cc9ef5513199c4b003e237684` | 23.948 / `af7d7b7788c03f66897b9fa347f6deddfa9dab18cbbe7af16b48d51434106bd3` |
| `vocabulary-lab` | 55.590 / `257f75f59101d40709a131420d57859abaf4897c0de74f64de08be54a5e06ecb` | 35.748 / `b8be1192783bd92a839c2831117f24ad6ef180f8abd64538b0cea474713626dd` |
| `presentation-lab` | 41.846 / `45863e9a830520eaa28c179f1ecb3cb43f44f44fe3e574ef5fa5aafe050c1acb` | 26.480 / `fc85426ad26c1f03eed003ac9760e2c1117488c50402681a35457f5b89e701ff` |

Os nomes fingerprintados correspondem aos primeiros 12 caracteres do SHA-256
de cada WebP. Todos os arquivos respeitam as dimensões e os limites de bytes
definidos para desktop e mobile.

## 8. QA local concluído e rollout pendente

Gates locais concluídos:

- integração dos dez perfis no manifesto, com dimensões, bytes, SHA-256 e URLs
  fingerprintadas travados nos testes;
- inspeção visual das fontes, dos desktops e dos dez recortes mobile;
- 10/10 testes focais do manifesto e catálogo e 60/60 testes da suíte completa;
- typecheck sem erros e build de produção com a interface V2 ativa;
- 102/102 caminhos verificados em `public` e novamente no pacote `dist`, com
  fingerprint, bytes, SHA-256, decodificação WebP e integridade RIFF;
- QA responsivo dos dez cenários em desktop `1440 × 900` e mobile `390 × 844`,
  na mesma página e em uma única sessão headless;
- fundos desktop `1600 × 900`, fundos mobile `900 × 1200` e personagem
  `1024 × 1536` carregados corretamente, sem overflow horizontal, erro de página
  ou erro de console;
- uma única guia durante todo o ensaio e nenhuma sessão automatizada residual
  após o encerramento.

Ainda é necessário executar o processo completo de release, os smoke tests e a
verificação externa de produção antes de considerar o rollout concluído.

Nenhuma release, commit de origem ou backup de produção está registrado para o
lote V4 neste documento porque o rollout ainda não ocorreu.

Este lote elevou a cobertura local aprovada para 38
dos 56 cenários canônicos com bitmap próprio. Os outros 18 continuarão usando o
fallback visual determinístico até os lotes seguintes.
