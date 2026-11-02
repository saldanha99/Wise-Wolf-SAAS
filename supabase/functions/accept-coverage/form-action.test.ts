/// <reference lib="deno.ns" />

/**
 * Página HTML servida por edge function não pode montar o `action` do
 * formulário a partir de `new URL(req.url).pathname`. Dentro do container o
 * caminho chega SEM o `/functions/v1` (o Kong tira o prefixo antes de repassar),
 * e o navegador postava para `https://api…/accept-coverage` — a rota do painel
 * do Kong, que responde 401 com Basic Auth. Em 17/10/2026 a professora abria o
 * convite de cobertura, tocava em "Confirmar" e recebia um pedido de usuário e
 * senha; nenhum aceite por link chegava à função.
 *
 * O desenho certo é o do convite de treinamento: `<form method="post">` sem
 * `action`, que posta para a própria URL do link. Precisa de --allow-read.
 */

const PAGES = [
  "../accept-coverage/index.ts",
  "../claim-coverage/index.ts",
  "../teacher-training-invite/page.ts",
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

for (const relative of PAGES) {
  Deno.test(`${relative}: o formulário posta para a própria URL do link`, async () => {
    // Comentários saem da conta: a nota que explica o defeito cita o caminho.
    const source = (await Deno.readTextFile(new URL(relative, import.meta.url)))
      .replace(/^\s*\/\/.*$/gm, "");
    const forms = source.match(/<form\b[^>]*>/g) ?? [];
    assert(forms.length > 0, `${relative} perdeu o formulário de resposta`);
    for (const form of forms) {
      assert(
        !/\baction\s*=/.test(form),
        `${relative}: <form> com action (${form}) — o caminho visto pela função não tem /functions/v1 e cai no Basic Auth do Kong`,
      );
    }
    assert(
      !/actionPath|url\.pathname/.test(source),
      `${relative}: caminho interno da requisição voltou a ser usado na página`,
    );
  });
}
