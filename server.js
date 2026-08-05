// سرور دستیار درسی کنکور
// این فایل کلید API را امن نگه می‌دارد؛ کلید هرگز به مرورگر کاربر فرستاده نمی‌شود.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // برای عکس‌های base64 حجم بیشتری لازم است

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const DAILY_FREE_LIMIT = parseInt(process.env.DAILY_FREE_LIMIT || '8', 10);
const PORT = process.env.PORT || 3000;

if (!GEMINI_API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY تنظیم نشده — فایل .env را از روی .env.example بساز و کلید را بگذار.');
}

// ---------------------------------------------------------------
// محدودیت ساده‌ی روزانه (در حافظه). برای تولید واقعی با تعداد کاربر بالا
// این بخش را به دیتابیس (مثلاً Redis یا Postgres) منتقل کن، چون این نسخه
// با ری‌استارت شدن سرور یا اجرای چند instance پاک/ناهماهنگ می‌شود.
// ---------------------------------------------------------------
const usageStore = new Map(); // key: identifier, value: { count, date }

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function checkAndConsumeQuota(identifier) {
  const today = todayKey();
  const entry = usageStore.get(identifier);
  if (!entry || entry.date !== today) {
    usageStore.set(identifier, { date: today, count: 1 });
    return { allowed: true, remaining: DAILY_FREE_LIMIT - 1 };
  }
  if (entry.count >= DAILY_FREE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  return { allowed: true, remaining: DAILY_FREE_LIMIT - entry.count };
}

// ---------------------------------------------------------------
// پرامپت سیستمی بر اساس پایه و رشته
// ---------------------------------------------------------------
function buildSystemPrompt(gradeLabel, majorLabel) {
  return `تو یک دستیار آموزشی برای دانش‌آموز پایه ${gradeLabel} رشته ${majorLabel} در ایران هستی و داری برای کنکور آماده‌اش می‌کنی.
قوانین پاسخ‌دهی:
- همیشه به فارسی و با فرمول‌نویسی ریاضی استاندارد (بین علامت $ برای فرمول‌های داخل خط و $$ برای فرمول‌های جدا) جواب بده.
- سوالات را دقیقاً طبق روش و ترتیب مطرح‌شده در کتاب‌های درسی همان پایه و رشته حل کن، نه با روش‌های دانشگاهی یا خارج از چارچوب کنکور.
- اگر عکس سوال فرستاده شد، اول متن سوال را از روی عکس بخوان و دقیق بازنویسی کن، بعد حل کن.
- مراحل حل را کامل و گام‌به‌گام بنویس، نه فقط جواب نهایی.
- مختصر و کاربردی بنویس، از حاشیه‌روی غیرضروری پرهیز کن.
(توجه: این یک نسخه‌ی اولیه است و متن واقعی کتاب‌های درسی هنوز به‌عنوان منبع در اختیارت قرار نگرفته — بر اساس دانش عمومی از سرفصل‌های رسمی این پایه/رشته جواب بده.)`;
}

// ---------------------------------------------------------------
// مسیر اصلی چت
// ---------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'سرور هنوز کلید API ندارد. فایل .env را تنظیم کن.' });
    }

    const { grade, major, messages, image } = req.body;
    if (!grade || !major || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'درخواست ناقص است.' });
    }

    // شناسه‌ی ساده برای محدودیت روزانه (IP). در نسخه‌ی واقعی از شناسه‌ی کاربر لاگین‌شده استفاده کن.
    const identifier = req.ip;
    const quota = checkAndConsumeQuota(identifier);
    if (!quota.allowed) {
      return res.status(429).json({
        error: `محدودیت روزانه‌ی ${DAILY_FREE_LIMIT} سوال رایگان تمام شده. فردا دوباره امتحان کن یا اشتراک بگیر.`,
      });
    }

    const contents = messages.map((m, idx) => {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      // فقط به آخرین پیام کاربر (اگر عکس داشت) عکس اضافه می‌شود
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
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt(grade, major) }] },
          contents,
        }),
      }
    );

    const data = await geminiRes.json();

    if (data.error) {
      console.error('Gemini error:', data.error);
      return res.status(502).json({ error: data.error.message || 'خطا در سرویس هوش مصنوعی' });
    }

    const candidate = data.candidates && data.candidates[0];
    const text =
      candidate && candidate.content && candidate.content.parts
        ? candidate.content.parts.map((p) => p.text || '').join('\n').trim()
        : '';

    return res.json({
      text: text || 'پاسخی دریافت نشد.',
      remainingToday: quota.remaining,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'خطای غیرمنتظره در سرور.' });
  }
});

// وضعیت باقیمانده‌ی سهمیه‌ی روزانه (برای نمایش تو UI)
app.get('/api/quota', (req, res) => {
  const identifier = req.ip;
  const entry = usageStore.get(identifier);
  const today = todayKey();
  const used = entry && entry.date === today ? entry.count : 0;
  res.json({ used, limit: DAILY_FREE_LIMIT, remaining: Math.max(0, DAILY_FREE_LIMIT - used) });
});

// سرو فایل‌های فرانت‌اند (همه‌ی فایل‌ها کنار همین server.js، بدون نیاز به پوشه‌ی جدا)
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`✅ سرور دستیار درسی کنکور رو پورت ${PORT} اجرا شد`);
});
