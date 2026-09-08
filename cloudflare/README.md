# Controle da Adega

Aplicacao oficial executada em Cloudflare Workers, com arquivos estaticos servidos
por Workers Assets e persistencia no banco D1.

Producao: <https://controle-adega.cauealves382.workers.dev>

## Comandos

- `npm run dev`: inicia o ambiente local.
- `npm run check`: valida o bundle sem publicar.
- `npm run db:local`: aplica as migracoes no D1 local.
- `npm run db:remote`: aplica as migracoes no D1 de producao.
- `npm run deploy`: publica a aplicacao.

Para desenvolvimento local, crie `cloudflare/.dev.vars` com
`ADMIN_PASSWORD` e `SESSION_SECRET`. Esse arquivo nao deve ser versionado.

O banco de producao ja esta configurado em `wrangler.toml`. Novas alteracoes de
estrutura devem ser adicionadas como migracoes numeradas em `migrations/`.

## Validação do estoque simplificado

- `npm test` (Node.js 22.13+): testa a API com SQLite em memória, incluindo migração,
  vendas sem saldo, comanda/fiado, cancelamentos, reposição, custos e permissões.
- A flag `ALLOW_SALES_WITHOUT_STOCK`, em `src/worker.js`, está habilitada e é exposta
  em `stock_policy.allow_sales_without_stock` para os avisos da interface.
- Vendas podem deixar saldo negativo; cada baixa nessas condições registra
  `stock_shortage`. Entradas, devoluções e inventário regularizam o saldo.
- Em Estoque → Cadastrar itens, nome e quantidade (inclusive zero) bastam por item.
  Custo é opcional; categoria, unidade e mínimo ficam em Mais opções. O responsável
  é informado uma vez por lote. O vínculo de consumo continua no Cardápio.
- Para publicar esta versão, aplicar primeiro `npm run db:remote` (migração 0003,
  que preserva saldos e datas) e depois `npm run deploy`. Para ambiente local,
  usar `npm run db:local` antes de `npm run dev`.
