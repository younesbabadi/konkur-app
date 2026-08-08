// اتصال به درگاه زرین‌پال (API v4) برای درخواست و وریفای پرداخت
const ZP_BASE = process.env.ZARINPAL_SANDBOX === 'true'
  ? 'https://sandbox.zarinpal.com/pg/v4/payment'
  : 'https://api.zarinpal.com/pg/v4/payment';
const ZP_STARTPAY = process.env.ZARINPAL_SANDBOX === 'true'
  ? 'https://sandbox.zarinpal.com/pg/StartPay'
  : 'https://www.zarinpal.com/pg/StartPay';

async function requestPayment({ amountToman, description, callbackUrl, mobile }) {
  const res = await fetch(`${ZP_BASE}/request.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      merchant_id: process.env.ZARINPAL_MERCHANT_ID,
      amount: amountToman,
      currency: 'IRT', // مبلغ به تومان
      description,
      callback_url: callbackUrl,
      metadata: mobile ? { mobile } : undefined,
    }),
  });
  const data = await res.json();
  if (!data.data || !data.data.authority) {
    console.error('خطای درخواست پرداخت زرین‌پال:', data.errors || data);
    throw new Error('درخواست پرداخت ناموفق بود');
  }
  return { authority: data.data.authority, payUrl: `${ZP_STARTPAY}/${data.data.authority}` };
}

async function verifyPayment({ amountToman, authority }) {
  const res = await fetch(`${ZP_BASE}/verify.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      merchant_id: process.env.ZARINPAL_MERCHANT_ID,
      amount: amountToman,
      currency: 'IRT',
      authority,
    }),
  });
  const data = await res.json();
  const code = data.data && data.data.code;
  if (code === 100 || code === 101) {
    return { ok: true, refId: data.data.ref_id };
  }
  return { ok: false, raw: data };
}

module.exports = { requestPayment, verifyPayment };
