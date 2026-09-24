// Server-side helpers for the Vercel functions. No npm dependencies.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');

async function rest(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`REST ${opts.method || 'GET'} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// Fetch every row, 1000 at a time (Supabase caps a response at 1000 rows).
async function restAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`REST GET ${path} -> ${res.status}: ${text}`);
    const rows = JSON.parse(text);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function authAdmin(path, opts = {}) {
  const res = await fetch(`${SB_URL}/auth/v1/admin/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

// Returns {id,email,role,chapter_id} for the caller's bearer token, or null.
async function caller(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const token = h.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const res = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON || SB_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  const prof = await rest(`profiles?user_id=eq.${user.id}&select=role,chapter_id`);
  if (!prof.length) return null;
  return { id: user.id, email: user.email, role: prof[0].role, chapter_id: prof[0].chapter_id };
}

async function telegram(chatId, text) {
  if (!TG_TOKEN || !chatId) return { ok: false, description: 'missing token or chat id' };
  const res = await fetch(`${TG_BASE}/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  try { return await res.json(); } catch (e) { return { ok: false, description: String(e) }; }
}

// Read-only check: can the bot see this chat? (posts nothing)
async function telegramCheck(chatId) {
  if (!TG_TOKEN || !chatId) return { ok: false, description: 'missing token or chat id' };
  const res = await fetch(`${TG_BASE}/bot${TG_TOKEN}/getChat?chat_id=${encodeURIComponent(chatId)}`);
  try { return await res.json(); } catch (e) { return { ok: false, description: String(e) }; }
}

// Current date in India (YYYY-MM-DD) plus weekday (0 = Sunday) and day of month.
function nowIST() {
  const t = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { date: t.toISOString().slice(0, 10), dow: t.getUTCDay(), dom: t.getUTCDate() };
}
function addDays(iso, n) {
  const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
}
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmt(iso) { const [y, m, d] = iso.split('-'); return `${Number(d)} ${MON[Number(m) - 1]}`; }

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return await new Promise((resolve) => {
    let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = { rest, restAll, authAdmin, caller, telegram, telegramCheck, nowIST, addDays, fmt, readBody, send, SB_URL, SB_ANON };
