// InfiniteTap's public app-to-app contract. HTTPS return is a pilot on real devices.
export function tapLink(payment, origin) {
  if (payment.status !== 'pending') throw new Error('Esta cobrança já foi encerrada.');
  const back = new URL('/tap-test.html', origin);
  back.searchParams.set('tap_order', payment.id);
  const params = new URLSearchParams({
    amount: String(payment.total_cents), payment_method: payment.card_method,
    installments: '1', order_id: payment.id, result_url: back.href,
    app_client_referrer: 'ControleAdega', handle: payment.handle, af_force_deeplink: 'true'
  });
  return `infinitepaydash://infinitetap-app?${params}`;
}

export function tapReturn(search) {
  const params = new URLSearchParams(search);
  const requested = params.get('tap_order'), returned = params.get('order_id');
  if (!requested && !returned) return null;
  if (!requested || returned && returned !== requested) return { error: 'O retorno não corresponde ao pedido. Confira a cobrança pendente.' };
  if (params.has('warning') || params.has('error')) return { id: requested, error: 'O aplicativo retornou um aviso. Confira o resultado no InfinitePay.' };
  return { id: requested, nsu: params.get('nsu') || '', aut: params.get('aut') || '' };
}
