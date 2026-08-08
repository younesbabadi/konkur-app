// اتصال به دیتابیس Postgres — اختیاری. اگه DATABASE_URL تنظیم نشده باشه،
// سرور بدون دیتابیس (بدون لاگین/اشتراک، فقط با سهمیه‌ی رایگان در حافظه) کار می‌کنه.
const { Pool } = require('pg');

const dbEnabled = !!process.env.DATABASE_URL;

const pool = dbEnabled
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false,
    })
  : null;

async function initDb() {
  if (!dbEnabled) {
    console.log('ℹ️  DATABASE_URL تنظیم نشده — حالت ساده (بدون لاگین/اشتراک، فقط سهمیه‌ی رایگان روزانه) فعاله.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INT DEFAULT 0,
      verified BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'inactive',
      plan TEXT,
      expires_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      authority TEXT,
      ref_id TEXT,
      amount INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      identifier TEXT NOT NULL,
      day DATE NOT NULL,
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (identifier, day)
    );
  `);
  console.log('✅ جدول‌های دیتابیس آماده‌ان');
}

module.exports = { pool, initDb, dbEnabled };
