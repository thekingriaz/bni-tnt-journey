// Admin only: list chapter logins and set / reset a chapter password.
const { rest, authAdmin, caller, readBody, send } = require('../lib/server');

const DOMAIN = 'journey.bnitnt.in';

async function allUsers() {
  const r = await authAdmin('users?page=1&per_page=1000');
  if (!r.ok) throw new Error('Could not list users: ' + JSON.stringify(r.data));
  return (r.data && r.data.users) || r.data || [];
}

module.exports = async (req, res) => {
  try {
    const me = await caller(req);
    if (!me || me.role !== 'admin') return send(res, 403, { error: 'Admins only' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    const action = body.action || 'list';

    const chapters = await rest('chapters?select=id,name,username&order=name');
    const users = await allUsers();
    const byEmail = Object.fromEntries(users.map((u) => [String(u.email).toLowerCase(), u]));

    if (action === 'list') {
      return send(res, 200, {
        chapters: chapters.map((c) => {
          const u = byEmail[`${c.username}@${DOMAIN}`];
          return { ...c, login: `${c.username}`, exists: !!u, last_sign_in_at: u ? u.last_sign_in_at || null : null };
        }),
      });
    }

    if (action === 'set_password') {
      const ch = chapters.find((c) => c.id === Number(body.chapter_id));
      if (!ch) return send(res, 400, { error: 'Unknown chapter' });
      const pw = String(body.password || '');
      if (pw.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters' });
      const email = `${ch.username}@${DOMAIN}`;
      const existing = byEmail[email];
      let r;
      if (existing) {
        r = await authAdmin(`users/${existing.id}`, { method: 'PUT', body: { password: pw } });
      } else {
        r = await authAdmin('users', { method: 'POST', body: { email, password: pw, email_confirm: true } });
      }
      if (!r.ok) return send(res, 500, { error: 'Supabase refused: ' + JSON.stringify(r.data) });
      // make sure the profile exists even if the trigger was skipped
      const uid = existing ? existing.id : (r.data.id || (r.data.user && r.data.user.id));
      await rest('profiles?on_conflict=user_id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: [{ user_id: uid, role: 'chapter', chapter_id: ch.id, display_name: ch.name }],
      });
      return send(res, 200, { ok: true, created: !existing, login: ch.username });
    }

    send(res, 400, { error: 'Unknown action' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
};
