# Piloto InfiniteTap e restauração

O sistema normal continua em `/`. O piloto administrativo fica em `/tap-test.html`.
O piloto usa o mesmo caixa e estoque: a cobrança é real; apenas preparar o pedido
não registra venda nem envia itens à cozinha. Após conferência manual, a venda
é lançada como Digital, com referência InfiniteTap no campo de observação.

## Versão anterior preservada em 21/09/2026

- Commit: `842e46ef26394af70946403648235ed2c577fdc7`
- Tag publicada: `pre-infinitetap-20260921`
- Worker: `controle-adega`
- Versão Cloudflare anterior: `d3d9d0b2-b3d3-479d-ac67-683e97760682`
- Deployment anterior: 17/09/2026, 23:14:53 UTC.

Para voltar imediatamente ao deploy anterior, em `cloudflare/`:

```powershell
npx.cmd wrangler rollback d3d9d0b2-b3d3-479d-ac67-683e97760682 --message "Restaurar sistema anterior ao piloto InfiniteTap"
```

Isso restaura código e assets; não restaura nem apaga dados D1. Não há migração
neste piloto. Pedidos do teste confirmados continuam no histórico. Pendências Tap
ficam guardadas, mas não aparecem na interface antiga. Confira-as antes da volta.
Para uma restauração permanente, reverta o commit do piloto no Git e publique pela
pipeline; assim, a próxima publicação não reintroduzirá o piloto.

## Teste no celular

1. Abra `/tap-test.html` no navegador do celular e entre com a senha administrativa.
2. Informe a InfiniteTag da conta recebedora. Selecione produtos e débito ou crédito.
3. Prepare o pedido e confira conta e valor. Marque que ainda não foi pago e abra InfinitePay.
4. Conclua a cobrança por aproximação no aplicativo. É dinheiro real, com as taxas da conta.
5. Verifique se o app voltou à página e trouxe NSU/autorização. Caso não volte,
   reabra o piloto no navegador. As pendências são recuperadas do servidor.
6. Confira o recebimento na conta InfinitePay, informe os dados do comprovante e
   registre a venda. Esse passo altera caixa, estoque e fila da cozinha.
7. Se não houve pagamento, descarte a pendência. Isso NÃO faz estorno no provedor.

Fonte: https://www.infinitepay.io/checkout-tap (consultada em 21/09/2026).
A documentação exemplifica retorno por esquema de app nativo. O retorno HTTPS
usado pelo piloto ainda precisa ser validado em Android/iPhone reais. Não é uma
integração de leitura NFC no navegador, nem contém SDK nativo.

## Limites intencionais

- A documentação de Tap não especifica confirmação autenticada servidor a servidor.
  NSU/autorização recebidos por URL não são tratados como prova de recebimento.
  A verificação é explicitamente manual, por administrador, inclusive se houver retorno.
- Primeiro piloto: vendas diretas, débito e crédito à vista, sem pagamentos de fiado,
  parcelamento ou estorno automático. Não altera o checkout normal.
- Valor e itens são preservados pelo servidor; mudanças de preço não alteram a
  cobrança preparada. Estoque é movimentado apenas na confirmação.
- Confirmações usam guardas únicas na mesma transação SQLite/D1 para evitar
  duplicar receita e baixa de estoque. O mesmo comprovante não pode registrar duas vendas.
- Resolver pendências antes de fechar o caixa; a confirmação não transfere a venda
  silenciosamente para um novo caixa. Se já foi pago, não cobrar novamente.
- Sem teste físico de cartão durante desenvolvimento. Abertura do app, NFC e retorno
  ao navegador só podem ser considerados validados após teste no aparelho do operador.
