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
