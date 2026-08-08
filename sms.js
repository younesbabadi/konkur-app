// ارسال پیامک کد تایید — پیش‌فرض کاوه‌نگار (Lookup/Verify API)
// اگه KAVENEGAR_API_KEY ست نشده باشه (مثلاً موقع تست لوکال)، کد رو تو کنسول چاپ می‌کنه
// به‌جای ارسال واقعی، تا بدون هزینه‌ی پیامک هم بشه تست کرد.

async function sendOtpSms(phone, code) {
  const apiKey = process.env.KAVENEGAR_API_KEY;
  const template = process.env.KAVENEGAR_TEMPLATE || 'verify';

  if (!apiKey) {
    console.log(`📱 [حالت تست بدون پیامک واقعی] کد تایید ${phone}: ${code}`);
    return { ok: true, dev: true };
  }

  const url = `https://api.kavenegar.com/v1/${apiKey}/verify/lookup.json?receptor=${encodeURIComponent(phone)}&token=${encodeURIComponent(code)}&template=${encodeURIComponent(template)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || (data.return && data.return.status !== 200)) {
    console.error('خطای ارسال پیامک:', data);
    throw new Error('ارسال پیامک ناموفق بود');
  }
  return { ok: true };
}

module.exports = { sendOtpSms };
