// Gives the browser the public Supabase URL + anon key (both are safe to expose).
const { send, SB_URL, SB_ANON } = require('../lib/server');

module.exports = async (req, res) => {
  if (!SB_URL || !SB_ANON) return send(res, 500, { error: 'SUPABASE_URL or SUPABASE_ANON_KEY is not set in Vercel' });
  send(res, 200, { url: SB_URL, anonKey: SB_ANON });
};
