# Controle financeiro da adega

Aplicação web publicada em Cloudflare Workers, com arquivos estáticos servidos por Workers Assets e persistência em banco D1.

## Objetivo

Centralizar operações de controle financeiro e de estoque da adega em uma aplicação web com API no Worker, banco relacional e migrações SQL versionadas.

## Funcionalidades

As funcionalidades são implementadas em `cloudflare/src/worker.js` e `cloudflare/public/app.js`, incluindo operações da aplicação, controle de sessão e acesso aos dados persistidos.

## Tecnologias utilizadas

- JavaScript
- Cloudflare Workers e Workers Assets
- Cloudflare D1
- SQL
- Wrangler
- HTML e CSS

## Estrutura do projeto

```text
cloudflare/
├── migrations/       Migrações SQL do D1
├── public/           Interface estática
├── src/worker.js     Worker, API e regras da aplicação
├── package.json      Scripts e dependência do Wrangler
└── wrangler.toml     Configuração do deploy
```

## Como executar

Requisitos: Node.js e Wrangler.

```bash
git clone https://github.com/souza1caue/Adega-controle-financeiro.git
cd Adega-controle-financeiro/cloudflare
npm install
```

Para desenvolvimento local, crie `cloudflare/.dev.vars` com os valores de `ADMIN_PASSWORD` e `SESSION_SECRET`. Esse arquivo não deve ser versionado.

```bash
npm run dev
```

Os comandos `npm run check`, `npm run db:local`, `npm run db:remote` e `npm run deploy` estão definidos no `package.json`; os dois últimos exigem acesso ao ambiente Cloudflare correto.

## Imagens ou demonstração

A aplicação possui imagens versionadas usadas pela interface. Uma captura de tela documentada permanece como pendência.

## Próximas melhorias

- Adicionar testes automatizados para as rotas e regras de negócio.
- Documentar o modelo completo das tabelas D1.
- Revisar os campos de autenticação e garantir que nenhum valor sensível apareça no frontend.

## Autor

Cauê Souza  
LinkedIn: https://www.linkedin.com/in/caue-alves-dados  
GitHub: https://github.com/souza1caue
