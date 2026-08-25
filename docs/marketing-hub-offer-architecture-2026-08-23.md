# Arquitetura comercial do Wise Wolf Hub

## Tese da experiência

O Wise Wolf Hub é a porta de entrada para a infraestrutura que ajuda professores e escolas de inglês a ensinar, engajar alunos e crescer. A página inicial direciona o comprador; as páginas por público explicam a transformação; as páginas de módulo comprovam como cada parte funciona.

A identidade visual continua sendo a do Wolfie. A referência da Flexge é usada para clareza de oferta, segmentação e ativação, não para copiar sua direção visual.

## Aprendizados aplicados da Flexge

- A home funciona como um roteador por público, não como catálogo exaustivo.
- Professor autônomo compra economia de tempo, qualidade e profissionalização.
- Escola compra padronização, retenção, controle e capacidade de crescer.
- Funcionalidades aparecem depois do resultado desejado.
- A venda é sustentada por onboarding, suporte, conteúdo e uma primeira vitória clara.
- Preço direto faz sentido para a entrada do professor; operação escolar exige qualificação e implantação.

Fontes primárias consultadas:

- https://flexge.com/
- https://flexge.com/pt/professores-particulares/
- https://flexge.com/pt/centro-idiomas/
- https://flexge.com/pt/funcionalidades/
- https://knowledge.flexge.com/pt-br/primeiros-passos-flexge
- https://knowledge.flexge.com/pt-br/onboarding-do-aluno
- https://knowledge.flexge.com/pt-br/faq-novo-modelo-comercial
- https://knowledge.flexge.com/pt-br/como-funcionam-as-licencas-extras

## Arquitetura de marca

### Wise Wolf Hub

Marca guarda-chuva, descoberta e roteamento. Não é um plano e não tenta vender todos os públicos com o mesmo CTA.

### Wise Wolf para Professores

Jornada de entrada para o professor autônomo. Começa em autoatendimento com preparação pedagógica e pode evoluir para uma operação acompanhada.

### Wise Wolf para Escolas

Jornada institucional. Conecta comercial, pedagógico, entrega e backoffice por meio de diagnóstico e implantação assistida.

### Wolfie AI Tutor

Produto individual no domínio próprio e experiência de prática que pode integrar ofertas B2B conforme o escopo contratado.

### Biblioteca e Educador IA

Módulos e páginas de aquisição. Eles comprovam a proposta para o professor, mas não competem como marcas de mesmo nível com o Hub ou o School OS.

## Organização por resultado

1. **Ensinar:** biblioteca, planejamento com IA, materiais e trilhas.
2. **Engajar:** portal, atividades, acompanhamento e prática com o Wolfie.
3. **Crescer:** CRM, follow-up, aula experimental, matrícula, contratos e automações disponíveis.
4. **Operar:** agenda, presença, reposição, equipe, financeiro, permissões e branding.

Segurança, isolamento de tenant, auditoria, billing e fulfillment formam a camada de confiança. Essa camada deve aparecer perto da decisão de compra sem substituir os benefícios no topo das páginas.

## Rotas comerciais

- `/hub`: visão geral com duas escolhas principais.
- `/hub/professores`: proposta, fluxo, planos pedagógicos e evolução para Professor Negócio.
- `/hub/escolas`: proposta institucional, módulos, diagnóstico e implantação.
- `/hub/biblioteca`: página nichada do módulo Biblioteca.
- `/hub/educador-ia`: página nichada do módulo Educador IA.
- `/hub/wolfie`: experiência individual do Wolfie.
- `/hub/saas-escolar`: aprofundamento técnico-comercial do School OS.

No domínio dedicado, as mesmas páginas são servidas sem o prefixo `/hub`.

## Oferta para professores

### Professor Essencial

Biblioteca organizada para preparação individual.

### Professor Pro

Biblioteca e Educador IA para planejar com mais contexto.

### Professor Studio

Preparação pedagógica e prática com o Wolfie no Hub.

### Professor Negócio

Evolução assistida para quem precisa de CRM, contratos, pagamentos e gestão de alunos. Não deve aparecer como três planos paralelos aos planos pedagógicos até catálogo, provisionamento e contratos estarem unificados.

## Oferta para escolas

### Escola Operação

Agenda, alunos, equipe, presença, contratos e implantação do ambiente.

### Escola Crescimento

Acrescenta fluxo comercial, experimental, automações e experiência pedagógica conforme diagnóstico.

### Escola Completa

Acrescenta financeiro, RH, inteligência executiva e escopo ampliado.

Os nomes representam uma estrutura de proposta, não preços públicos. O valor institucional depende de alunos ativos, usuários, módulos, integrações e nível de acompanhamento.

## Jornada de aquisição e entrega

### Professor

1. Anúncio ou conteúdo por dor específica.
2. Landing page de módulo ou página para professores.
3. Demonstração de uma tarefa real.
4. Teste sem cartão quando disponível.
5. Primeira aula preparada.
6. Escolha de plano e checkout.
7. Liberação somente após confirmação do pagamento.
8. Entrega transacional por e-mail e WhatsApp.
9. Evolução assistida para Professor Negócio quando houver necessidade operacional.

### Escola

1. Conteúdo ou campanha por gargalo de operação.
2. Página para escolas com tour do fluxo.
3. Diagnóstico com alunos, professores, unidades, ferramentas e principal gargalo.
4. Demonstração adaptada.
5. Proposta e contrato.
6. Criação e configuração do ambiente.
7. Migração e treinamento por etapas.
8. Validação de papéis e isolamento antes da abertura.
9. Acompanhamento de adoção e expansão.

## Limites de promessa

Pode ser vendido agora:

- Wolfie individual;
- Biblioteca e Educador IA no escopo efetivamente liberado;
- School OS em implantação assistida;
- CRM, experimental, agenda, contratos, presença e financeiro dentro do escopo validado.

Deve permanecer como piloto ou implantação acompanhada:

- Teaching Studio com trilhas e perfis integrados ao Hub;
- licença institucional do Wolfie por assento;
- integrações próprias por tenant;
- operação SaaS amplamente self-service.

Não deve ser anunciado como concluído:

- publicação automática real de landing pages;
- otimização real de copy quando a interface ainda usa simulação;
- domínio próprio com TLS automático;
- BYOK ativo para integrações;
- Academia completa no produto Hub.

## Indicadores de evolução

- tempo até a primeira aula preparada;
- conclusão do onboarding;
- uso semanal de Biblioteca, IA e Wolfie;
- conversão da descoberta para plano pago;
- tempo entre diagnóstico e demonstração escolar;
- ativação por módulo após implantação;
- conversão e comparecimento de aulas experimentais;
- inadimplência, renovação e expansão de licenças;
- incidentes de autorização ou acesso cruzado, com meta de zero.
