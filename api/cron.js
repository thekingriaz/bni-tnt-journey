// Runs every day at 09:00 IST (Vercel cron) and does:
//   daily   : recompute every member's Health Score, alert HT group + create a recovery task when a member turns red
//   Monday  : weekly task list to each chapter HT group
//   1st     : monthly region summary to the region chat
// Admins can also trigger it from the app (Admin > Telegram) for testing.
const { rest, restAll, caller, telegram, telegramCheck, nowIST, addDays, fmt, readBody, send } = require('../lib/server');
const { computeHealth } = require('../lib/health');

function pct(done, total) { return total ? Math.round((done * 100) / total) : null; }

async function loadAll() {
  const [chapters, members, tasks, palms, health, cfg, sdc] = await Promise.all([
    rest('chapters?select=*&active=eq.true&order=name'),
    restAll('members?select=*&status=eq.active'),
    restAll('tasks?select=id,member_id,chapter_id,template_code,title,owner_role,due_date,status,rating,done_on'),
    restAll('palms_rows?select=member_id,a,one2one,rgi,rgo,rri,rro,palms_uploads(period_from,period_to)&member_id=not.is.null'),
    restAll('member_health?select=*'),
    rest('app_config?select=key,value'),
    restAll('sdc_reviews?select=chapter_id,review_month'),
  ]);
  const config = Object.fromEntries(cfg.map((c) => [c.key, c.value]));
  return { chapters, members, tasks, palms, health, config, sdc };
}

function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) { const k = x[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

function ownerLabel(t, member) {
  if (t.owner_role === 'Mentor' && member.mentor_name) return `mentor: ${member.mentor_name}`;
  return t.owner_role;
}

function weeklyText(ch, chMembers, tasksByMember, today, appUrl) {
  const weekEnd = addDays(today, 6);
  const over = [], due = [];
  for (const m of chMembers) {
    for (const t of tasksByMember.get(m.id) || []) {
      if (t.status !== 'open') continue;
      const line = `- ${m.full_name} (${ownerLabel(t, m)}): ${t.title}, due ${fmt(t.due_date)}`;
      if (t.due_date < today) over.push([t.due_date, line]);
      else if (t.due_date <= weekEnd) due.push([t.due_date, line]);
    }
  }
  over.sort((a, b) => (a[0] < b[0] ? -1 : 1)); due.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const cap = (list) => {
    const shown = list.slice(0, 25).map((x) => x[1]);
    if (list.length > 25) shown.push(`...and ${list.length - 25} more in the app`);
    return shown.join('\n');
  };
  let text = `${ch.name} | New Member Journey | Week of ${fmt(today)}\n\n`;
  if (!over.length && !due.length) {
    text += 'No overdue tasks and nothing due this week. Well done, team!';
  } else {
    text += `Overdue (${over.length})\n${over.length ? cap(over) : '- None'}\n\n`;
    text += `Due this week (${due.length})\n${due.length ? cap(due) : '- None'}`;
  }
  if (appUrl) text += `\n\nUpdate here: ${appUrl}`;
  return text;
}

module.exports = async (req, res) => {
  try {
    // --- who is calling ---
    const secret = process.env.CRON_SECRET;
    const auth = req.headers.authorization || '';
    const isCron = secret && auth === `Bearer ${secret}`;
    let body = {};
    if (!isCron) {
      const me = await caller(req);
      if (!me || me.role !== 'admin') return send(res, 403, { error: 'Not allowed' });
      body = req.method === 'POST' ? await readBody(req) : {};
    }

    // --- ping: check the bot can reach every HT group, without posting anything ---
    if (!isCron && body.mode === 'ping') {
      const chapters = await rest('chapters?select=name,telegram_chat_id&active=eq.true&order=name');
      const out = [];
      for (const c of chapters) {
        const r = await telegramCheck(c.telegram_chat_id);
        out.push({ chapter: c.name, chat_id: c.telegram_chat_id, bot_can_reach: !!(r && r.ok), title: r && r.result ? r.result.title : null, error: r && r.ok ? null : r && r.description });
      }
      return send(res, 200, { reachable: out.filter((x) => x.bot_can_reach).length, of: out.length, chapters: out });
    }

    const { date: today, dow, dom } = nowIST();
    const data = await loadAll();
    const appUrl = data.config.app_url || '';
    const regionChat = data.config.region_chat_id || '';
    const tasksByMember = groupBy(data.tasks, 'member_id');
    const palmsByMember = groupBy(
      data.palms.map((p) => ({ ...p, period_from: p.palms_uploads.period_from, period_to: p.palms_uploads.period_to })),
      'member_id'
    );
    const prevHealth = new Map(data.health.map((h) => [h.member_id, h]));
    const chById = new Map(data.chapters.map((c) => [c.id, c]));
    const log = { today, health_updated: 0, red_alerts: [], weekly: [], monthly: null };

    const mode = body.mode || 'auto';
    const dryRun = !!body.dry_run;                 // test sends go to region chat only
    // PAUSE SWITCH: nothing goes to chapter HT groups until an admin sets Telegram to Live.
    const live = String(data.config.telegram_live || 'false') === 'true';
    log.telegram_live = live;
    if (!live && !(dryRun && mode === 'weekly')) {
      log.paused = 'Telegram is PAUSED. No health alerts, weekly lists or summaries were sent. Switch to Live in Admin when ready.';
      return send(res, 200, log);
    }
    const doDaily = isCron || mode === 'daily';
    const doWeekly = (isCron && dow === 1) || mode === 'weekly';
    const doMonthly = (isCron && dom === 1) || mode === 'monthly';

    // --- daily: health + red alerts ---
    if (doDaily) {
      const upserts = [];
      for (const m of data.members) {
        const h = computeHealth(m, tasksByMember.get(m.id) || [], palmsByMember.get(m.id) || [], today);
        const prev = prevHealth.get(m.id);
        const row = {
          member_id: m.id, chapter_id: m.chapter_id, status: h.status,
          reasons: h.reasons.join('; '), computed_at: new Date().toISOString(),
          red_alerted_at: prev ? prev.red_alerted_at : null,
        };
        if (h.status === 'red' && (!prev || prev.status !== 'red')) {
          const ch = chById.get(m.chapter_id);
          const text = `RED ALERT | ${ch ? ch.name : ''}\n\n${m.full_name} has turned red on the New Member Journey.\n\nWhy:\n- ${h.reasons.join('\n- ')}\n\nA recovery 1-1 with the mentor${m.mentor_name ? ' (' + m.mentor_name + ')' : ''} and a Head Table member is due by ${fmt(addDays(today, 7))}.${appUrl ? '\n\n' + appUrl : ''}`;
          const tg = await telegram(ch && ch.telegram_chat_id, text);
          await rest('tasks?on_conflict=member_id,template_code', {
            method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
            body: [{ member_id: m.id, chapter_id: m.chapter_id, template_code: `R-${today}`, seq: 200,
              title: 'Recovery 1-1 (member turned red)', owner_role: 'Mentor + Head Table', due_date: addDays(today, 7) }],
          });
          row.red_alerted_at = new Date().toISOString();
          log.red_alerts.push({ member: m.full_name, chapter: ch && ch.name, telegram_ok: !!(tg && tg.ok) });
        }
        upserts.push(row);
      }
      for (let i = 0; i < upserts.length; i += 500) {
        await rest('member_health?on_conflict=member_id', {
          method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: upserts.slice(i, i + 500),
        });
      }
      log.health_updated = upserts.length;
    }

    // --- weekly: task list per chapter ---
    if (doWeekly) {
      const membersByCh = groupBy(data.members, 'chapter_id');
      for (const ch of data.chapters) {
        if (body.chapter_id && Number(body.chapter_id) !== ch.id) continue;
        const list = membersByCh.get(ch.id) || [];
        if (!list.length) continue;
        const text = weeklyText(ch, list, tasksByMember, today, appUrl);
        const target = dryRun ? regionChat : ch.telegram_chat_id;
        const tg = await telegram(target, (dryRun ? '[TEST] ' : '') + text);
        log.weekly.push({ chapter: ch.name, sent_to: target, telegram_ok: !!(tg && tg.ok), error: tg && tg.ok ? null : tg && tg.description });
      }
    }

    // --- monthly: region summary ---
    if (doMonthly) {
      const lastMonthEnd = addDays(today.slice(0, 8) + '01', -1);
      const lastMonthStart = lastMonthEnd.slice(0, 8) + '01';
      const healthNow = new Map((await restAll('member_health?select=member_id,status')).map((h) => [h.member_id, h.status]));
      const rows = data.chapters.map((ch) => {
        const ts = data.tasks.filter((t) => t.chapter_id === ch.id && t.status !== 'na' && t.due_date >= lastMonthStart && t.due_date <= lastMonthEnd);
        const done = ts.filter((t) => t.status === 'done').length;
        const mem = data.members.filter((m) => m.chapter_id === ch.id);
        const reds = mem.filter((m) => healthNow.get(m.id) === 'red').length;
        const reviewed = data.sdc.some((s) => s.chapter_id === ch.id && s.review_month === lastMonthStart);
        return { name: ch.name, pct: pct(done, ts.length), reds, members: mem.length, reviewed };
      }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
      let text = `BNI TNT | New Member Journey | Region summary for ${fmt(lastMonthStart)} to ${fmt(lastMonthEnd)}\n\nChapters by task completion:\n`;
      rows.filter((r) => r.members > 0).forEach((r, i) => {
        text += `${i + 1}. ${r.name}: ${r.pct === null ? 'no tasks due' : r.pct + '%'}, ${r.reds} red of ${r.members}${r.reviewed ? '' : ', SDC review NOT logged'}\n`;
      });
      const below = rows.filter((r) => r.pct !== null && r.pct < 70).map((r) => r.name);
      if (below.length) text += `\nBelow 70%: ${below.join(', ')}`;
      if (appUrl) text += `\n\n${appUrl}`;
      const tg = await telegram(regionChat, text);
      log.monthly = { sent_to: regionChat, telegram_ok: !!(tg && tg.ok), error: tg && tg.ok ? null : tg && tg.description };
    }

    send(res, 200, log);
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
};
