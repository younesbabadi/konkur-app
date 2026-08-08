// سرور حل‌یار — احراز هویت با OTP، اشتراک با زرین‌پال، سهمیه‌ی روزانه از دیتابیس

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { pool, initDb, dbEnabled } = require('./db');
const { sendOtpSms } = require('./sms');
const { requestPayment, verifyPayment } = require('./zarinpal');

// سهمیه‌ی روزانه در حافظه — فقط برای وقتی که دیتابیس وصل نیست (حالت ساده)
const memoryUsage = new Map(); // key: identifier, value: { date, count }

const app = express();
app.set('trust proxy', true); // برای گرفتن IP واقعی کاربر پشت پراکسی Railway
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const DAILY_FREE_LIMIT = parseInt(process.env.DAILY_FREE_LIMIT || '8', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const SUBSCRIPTION_PRICE_TOMAN = parseInt(process.env.SUBSCRIPTION_PRICE_TOMAN || '99000', 10);
const PORT = process.env.PORT || 3000;

if (!GEMINI_API_KEY) console.warn('⚠️  GEMINI_API_KEY تنظیم نشده — چت کار نمی‌کنه.');
if (!process.env.DATABASE_URL) console.warn('ℹ️  DATABASE_URL تنظیم نشده — حالت ساده بدون لاگین/اشتراک فعاله.');
if (!process.env.ZARINPAL_MERCHANT_ID) console.warn('ℹ️  ZARINPAL_MERCHANT_ID تنظیم نشده — خرید اشتراک هنوز فعال نیست.');

// ---------------------------------------------------------------
// ابزارهای کمکی
// ---------------------------------------------------------------
function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/\s|-/g, '');
  if (p.startsWith('+98')) p = '0' + p.slice(3);
  if (p.startsWith('98')) p = '0' + p.slice(2);
  if (!/^09\d{9}$/.test(p)) return null;
  return p;
}
function signToken(user) {
  return jwt.sign({ uid: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
}
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'برای این کار باید وارد بشی.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    req.userPhone = payload.phone;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'نشست منقضی شده، دوباره وارد شو.' });
  }
}
// نسخه‌ی اختیاری: اگه توکن معتبر بود کاربر رو تشخیص می‌ده، وگرنه بدون خطا رد می‌شه (کاربر مهمان)
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.userId = payload.uid;
      req.userPhone = payload.phone;
    } catch (e) { /* توکن نامعتبر رو نادیده بگیر، مهمون حساب کن */ }
  }
  next();
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function quotaIdentifier(req) { return req.userId ? `user:${req.userId}` : `ip:${req.ip}`; }

async function getSubscription(userId) {
  if (!dbEnabled || !userId) return { active: false };
  const r = await pool.query('SELECT status, expires_at FROM subscriptions WHERE user_id=$1', [userId]);
  if (!r.rows.length) return { active: false };
  const row = r.rows[0];
  const active = row.status === 'active' && row.expires_at && new Date(row.expires_at) > new Date();
  return { active, expiresAt: row.expires_at };
}
async function getTodayUsage(identifier) {
  if (!dbEnabled) {
    const entry = memoryUsage.get(identifier);
    return entry && entry.date === todayStr() ? entry.count : 0;
  }
  const r = await pool.query('SELECT count FROM usage_daily WHERE identifier=$1 AND day=$2', [identifier, todayStr()]);
  return r.rows.length ? r.rows[0].count : 0;
}
async function incrementUsage(identifier) {
  if (!dbEnabled) {
    const today = todayStr();
    const entry = memoryUsage.get(identifier);
    if (!entry || entry.date !== today) memoryUsage.set(identifier, { date: today, count: 1 });
    else entry.count += 1;
    return;
  }
  await pool.query(
    `INSERT INTO usage_daily (identifier, day, count) VALUES ($1, $2, 1)
     ON CONFLICT (identifier, day) DO UPDATE SET count = usage_daily.count + 1`,
    [identifier, todayStr()]
  );
}

// ---------------------------------------------------------------
// احراز هویت: ارسال و تایید کد OTP
// ---------------------------------------------------------------
app.post('/api/auth/request-otp', async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'خرید اشتراک هنوز فعال نشده — بعداً امتحان کن.' });
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'شماره موبایل معتبر نیست.' });

    // جلوگیری از اسپم: اگه کد فعال و تازه‌ای هست، صبر کن
    const recent = await pool.query(
      `SELECT created_at FROM otp_codes WHERE phone=$1 AND created_at > now() - interval '45 seconds' ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (recent.rows.length) return res.status(429).json({ error: 'یکم صبر کن، همین الان یه کد فرستادیم.' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await pool.query(
      `INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, now() + interval '2 minutes')`,
      [phone, code]
    );
    await sendOtpSms(phone, code);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ارسال کد ناموفق بود.' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'خرید اشتراک هنوز فعال نشده — بعداً امتحان کن.' });
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();
    if (!phone || !code) return res.status(400).json({ error: 'اطلاعات ناقصه.' });

    const r = await pool.query(
      `SELECT id, attempts FROM otp_codes WHERE phone=$1 AND verified=false AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'کد منقضی شده، دوباره درخواست بده.' });
    const otpRow = r.rows[0];
    if (otpRow.attempts >= 5) return res.status(400).json({ error: 'تعداد تلاش زیاد بود، دوباره درخواست کد بده.' });

    const match = await pool.query(`SELECT id FROM otp_codes WHERE id=$1 AND code=$2`, [otpRow.id, code]);
    if (!match.rows.length) {
      await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1`, [otpRow.id]);
      return res.status(400).json({ error: 'کد اشتباهه.' });
    }
    await pool.query(`UPDATE otp_codes SET verified=true WHERE id=$1`, [otpRow.id]);

    let userRes = await pool.query('SELECT id, phone FROM users WHERE phone=$1', [phone]);
    let user;
    if (userRes.rows.length) {
      user = userRes.rows[0];
    } else {
      const inserted = await pool.query('INSERT INTO users (phone) VALUES ($1) RETURNING id, phone', [phone]);
      user = inserted.rows[0];
      await pool.query('INSERT INTO subscriptions (user_id, status) VALUES ($1, $2)', [user.id, 'inactive']);
    }

    const token = signToken(user);
    res.json({ token, user: { phone: user.phone } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ورود ناموفق بود.' });
  }
});

// ---------------------------------------------------------------
// اطلاعات حساب کاربر (برای تب اکانت)
// ---------------------------------------------------------------
app.get('/api/me', optionalAuth, async (req, res) => {
  if (!req.userId) return res.json({ guest: true, subscription: { active: false }, price: SUBSCRIPTION_PRICE_TOMAN });
  const sub = await getSubscription(req.userId);
  const used = await getTodayUsage(quotaIdentifier(req));
  res.json({
    guest: false,
    phone: req.userPhone,
    subscription: sub,
    price: SUBSCRIPTION_PRICE_TOMAN,
    quota: sub.active
      ? { unlimited: true }
      : { unlimited: false, used, limit: DAILY_FREE_LIMIT, remaining: Math.max(0, DAILY_FREE_LIMIT - used) },
  });
});

// ---------------------------------------------------------------
// پرداخت / اشتراک با زرین‌پال
// ---------------------------------------------------------------
app.post('/api/payment/create', requireAuth, async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'خرید اشتراک هنوز فعال نشده — بعداً امتحان کن.' });
  try {
    const callbackUrl = `${APP_BASE_URL}/api/payment/callback`;
    const { authority, payUrl } = await requestPayment({
      amountToman: SUBSCRIPTION_PRICE_TOMAN,
      description: 'اشتراک یک‌ماهه حل‌یار',
      callbackUrl,
      mobile: req.userPhone,
    });
    await pool.query(
      'INSERT INTO payments (user_id, authority, amount, status) VALUES ($1, $2, $3, $4)',
      [req.userId, authority, SUBSCRIPTION_PRICE_TOMAN, 'pending']
    );
    res.json({ payUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ساخت لینک پرداخت ناموفق بود.' });
  }
});

app.get('/api/payment/callback', async (req, res) => {
  const { Authority, Status } = req.query;
  const redirectBase = `${APP_BASE_URL}/app.html`;
  try {
    if (Status !== 'OK' || !Authority) {
      await pool.query('UPDATE payments SET status=$1 WHERE authority=$2', ['failed', Authority]);
      return res.redirect(`${redirectBase}?payment=failed`);
    }
    const paymentRow = await pool.query('SELECT * FROM payments WHERE authority=$1', [Authority]);
    if (!paymentRow.rows.length) return res.redirect(`${redirectBase}?payment=failed`);
    const payment = paymentRow.rows[0];

    const result = await verifyPayment({ amountToman: payment.amount, authority: Authority });
    if (!result.ok) {
      await pool.query('UPDATE payments SET status=$1 WHERE id=$2', ['failed', payment.id]);
      return res.redirect(`${redirectBase}?payment=failed`);
    }

    await pool.query('UPDATE payments SET status=$1, ref_id=$2 WHERE id=$3', ['paid', String(result.refId), payment.id]);
    await pool.query(
      `INSERT INTO subscriptions (user_id, status, plan, expires_at)
       VALUES ($1, 'active', 'monthly', now() + interval '30 days')
       ON CONFLICT (user_id) DO UPDATE SET status='active', plan='monthly',
         expires_at = GREATEST(COALESCE(subscriptions.expires_at, now()), now()) + interval '30 days'`,
      [payment.user_id]
    );
    res.redirect(`${redirectBase}?payment=success`);
  } catch (err) {
    console.error(err);
    res.redirect(`${redirectBase}?payment=failed`);
  }
});

// ---------------------------------------------------------------
// پرامپت سیستمی
// ---------------------------------------------------------------
function buildSystemPrompt(gradeLabel, majorLabel) {
  return `تو یک دستیار آموزشی برای دانش‌آموز پایه ${gradeLabel} رشته ${majorLabel} در ایران هستی و داری برای کنکور آماده‌اش می‌کنی.
قوانین پاسخ‌دهی:
- همیشه به فارسی و با فرمول‌نویسی ریاضی استاندارد (بین علامت $ برای فرمول‌های داخل خط و $$ برای فرمول‌های جدا) جواب بده.
- سوالات را دقیقاً طبق روش و ترتیب مطرح‌شده در کتاب‌های درسی همان پایه و رشته حل کن، نه با روش‌های دانشگاهی یا خارج از چارچوب کنکور.
- اگر عکس سوال فرستاده شد، اول متن سوال را از روی عکس بخوان و دقیق بازنویسی کن، بعد حل کن.
- مراحل حل را کامل و گام‌به‌گام بنویس، نه فقط جواب نهایی.
- مختصر و کاربردی بنویس، از حاشیه‌روی غیرضروری پرهیز کن.`;
}

// ---------------------------------------------------------------
// مسیر اصلی چت — حالا نیاز به لاگین داره و سهمیه از دیتابیسه
// ---------------------------------------------------------------
app.post('/api/chat', optionalAuth, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'سرور هنوز کلید API ندارد.' });

    const { grade, major, messages, image } = req.body;
    if (!grade || !major || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'درخواست ناقص است.' });
    }

    const sub = await getSubscription(req.userId);
    let remainingAfter = null;
    if (!sub.active) {
      const identifier = quotaIdentifier(req);
      const used = await getTodayUsage(identifier);
      if (used >= DAILY_FREE_LIMIT) {
        return res.status(429).json({ error: `محدودیت روزانه‌ی ${DAILY_FREE_LIMIT} سوال رایگان تمام شده. برای ادامه اشتراک بگیر.`, quotaExceeded: true });
      }
      await incrementUsage(identifier);
      remainingAfter = DAILY_FREE_LIMIT - (used + 1);
    }

    const contents = messages.map((m, idx) => {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      if (idx === messages.length - 1 && m.role === 'user' && image) {
        parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
      }
      if (parts.length === 0) parts.push({ text: 'لطفاً این سوال را طبق کتاب درسی حل کن.' });
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: buildSystemPrompt(grade, major) }] }, contents }),
      }
    );
    const data = await geminiRes.json();
    if (data.error) {
      console.error('Gemini error:', data.error);
      return res.status(502).json({ error: data.error.message || 'خطا در سرویس هوش مصنوعی' });
    }
    const candidate = data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map((p) => p.text || '').join('\n').trim()
      : '';

    res.json({ text: text || 'پاسخی دریافت نشد.', remainingToday: sub.active ? null : remainingAfter, unlimited: sub.active });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطای غیرمنتظره در سرور.' });
  }
});

// وضعیت سهمیه (بدون نیاز به لاگین هم قابل چک نیست دیگه — استفاده از /api/me)
app.get('/api/quota', optionalAuth, async (req, res) => {
  const sub = await getSubscription(req.userId);
  if (sub.active) return res.json({ unlimited: true, used: 0, limit: null, remaining: null });
  const used = await getTodayUsage(quotaIdentifier(req));
  res.json({ unlimited: false, used, limit: DAILY_FREE_LIMIT, remaining: Math.max(0, DAILY_FREE_LIMIT - used) });
});

app.use(express.static(__dirname));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ سرور حل‌یار رو پورت ${PORT} اجرا شد`));
  })
  .catch((err) => {
    console.error('❌ اتصال به دیتابیس ناموفق بود:', err);
    process.exit(1);
  });
