# Diagramação editorial de livros

O script recria um PDF com texto selecionável, uma folha A4 horizontal por página original. Os temas `hub` e `school` usam o mesmo conteúdo e aplicam a identidade visual correspondente. O script não acessa bibliotecas publicadas ou serviços de geração.

Use Python com PyMuPDF e Pillow, Node.js com `puppeteer-core` e um Chromium instalado. Se o Puppeteer estiver fora do repositório, passe o caminho absoluto para seu módulo JavaScript em `--puppeteer-module`. Use `--help` para ver as opções.

```sh
flock /data/OpenBot/Shared/render.lock python scripts/livros-editoriais/render.py \
  original.pdf /caminho/fora-do-repositorio \
  --theme hub --chromium /caminho/chromium \
  --opener 4=unidade-1.webp --context 7=contexto-1.webp
```

A pasta de saída deve conter `capa.webp` e as artes horizontais geradas no Codex. Repita `--opener` para cada unidade e `--context` para as páginas ilustradas. Use a numeração impressa do original. Cabeçalhos corridos, rodapés de licença e fólios recebem nova diagramação.

O script só grava `livro.pdf`, `contato.png` e `previa-capa.png` depois de conferir a quantidade e a orientação das páginas, a cobertura textual por página e os limites da área impressa. Antes de publicar, confira no original a sequência de leitura, as tabelas, as alternativas e os vínculos entre exercícios e gabarito. A conferência automática não demonstra a associação correta entre esses itens.

## Piloto v2 com repaginação

`render_v2.py` usa a mesma infraestrutura de impressão com uma diagramação de fluxo. As artes, em WebP horizontal, ficam na pasta de saída, com nomes `capa.webp` e `orig-NN.webp`, em que NN é a folha original à qual a imagem pertence.

```sh
flock /data/OpenBot/Shared/render.lock python scripts/livros-editoriais/render_v2.py \
  original.pdf /caminho/fora-do-repositorio \
  --theme hub --level C1 --chromium /caminho/chromium
```

A v2 inclui no PDF marcadores para as referências originais e gera as folhas de contato a 30%, a prévia de capa e `paginas.json`. O importador de tabelas da edição escola está calibrado para o PDF do piloto Travel Survival English A2. Antes de habilitá-lo para outros livros, mapeie as tabelas por fonte ou use o conteúdo estruturado oficial.
