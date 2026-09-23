/* Member Health Score. Shared by the browser app and the daily cron.
   Rules are from the approved build spec (23 Sep 2026). */
(function (root) {
  var DAY = 86400000;
  function d(s) { return Date.parse(String(s).slice(0, 10) + 'T00:00:00Z'); }
  function days(a, b) { return Math.round((d(b) - d(a)) / DAY); }
  function num(x) { return Number(x) || 0; }
  var RANK = { red: 3, amber: 2, green: 1, nodata: 0 };

  function band(v, green, amberMin) {        // higher is better
    if (v >= green) return 'green';
    if (v >= amberMin) return 'amber';
    return 'red';
  }

  /**
   * member: {induction_date}
   * tasks:  [{status, due_date, rating, done_on}]
   * palms:  [{period_from, period_to, a, one2one, rgi, rgo, rri, rro}]  (this member only)
   * today:  'YYYY-MM-DD'
   */
  function computeHealth(member, tasks, palms, today) {
    var signals = [];
    function add(key, label, value, level, note) {
      signals.push({ key: key, label: label, value: value, level: level, note: note || '' });
    }

    // ---- PALMS signals (monthly files only, not stale) ----
    var monthly = (palms || []).filter(function (r) {
      return days(r.period_from, r.period_to) <= 35;
    }).sort(function (x, y) { return d(y.period_to) - d(x.period_to); });
    var latest = monthly[0];
    var usable = latest && days(latest.period_to, today) <= 45;

    if (!usable) {
      var why = latest ? 'Latest PALMS is older than 45 days' : 'No monthly PALMS uploaded yet';
      add('absences', 'Absences (last month)', '-', 'nodata', why);
      add('one2one', '1-2-1s (last month)', '-', 'nodata', why);
      add('recv', 'Referrals received (60 days)', '-', 'nodata', why);
      add('given', 'Referrals given (60 days)', '-', 'nodata', why);
    } else {
      var partial = member.induction_date && d(member.induction_date) > d(latest.period_from) + 7 * DAY;
      if (partial) {
        add('absences', 'Absences (last month)', num(latest.a), 'nodata', 'Joined mid-month');
        add('one2one', '1-2-1s (last month)', num(latest.one2one), 'nodata', 'Joined mid-month');
      } else {
        var a = num(latest.a);
        add('absences', 'Absences (last month)', a, a === 0 ? 'green' : a === 1 ? 'amber' : 'red');
        var o = num(latest.one2one);
        add('one2one', '1-2-1s (last month)', o, band(o, 4, 2));
      }

      var prev = monthly[1];
      var hasPrev = prev && d(prev.period_to) >= d(latest.period_from) - 3 * DAY;
      var tenure = member.induction_date ? days(member.induction_date, latest.period_to) : 999;
      if (tenure <= 42) {
        add('recv', 'Referrals received (60 days)', '-', 'nodata', 'Under 6 weeks in BNI');
        add('given', 'Referrals given (60 days)', '-', 'nodata', 'Under 6 weeks in BNI');
      } else {
        var recv = num(latest.rri) + num(latest.rro) + (hasPrev ? num(prev.rri) + num(prev.rro) : 0);
        var given = num(latest.rgi) + num(latest.rgo) + (hasPrev ? num(prev.rgi) + num(prev.rgo) : 0);
        var lr = band(recv, 2, 1), lg = band(given, 2, 1);
        var n = hasPrev ? '' : 'Only 1 month of PALMS, so red is shown as amber';
        if (!hasPrev) { if (lr === 'red') lr = 'amber'; if (lg === 'red') lg = 'amber'; }
        add('recv', 'Referrals received (60 days)', recv, lr, n);
        add('given', 'Referrals given (60 days)', given, lg, n);
      }
    }

    // ---- App signals ----
    var overdue = (tasks || []).filter(function (t) {
      return t.status === 'open' && d(t.due_date) < d(today);
    }).length;
    add('overdue', 'Overdue journey tasks', overdue, overdue === 0 ? 'green' : overdue <= 2 ? 'amber' : 'red');

    var rated = (tasks || []).filter(function (t) { return t.status === 'done' && t.rating; })
      .sort(function (x, y) { return d(y.done_on || '1970-01-01') - d(x.done_on || '1970-01-01'); });
    if (rated.length) {
      var r = num(rated[0].rating);
      add('rating', 'Latest member rating (1 to 5)', r, r >= 4 ? 'green' : r === 3 ? 'amber' : 'red');
    } else {
      add('rating', 'Latest member rating (1 to 5)', '-', 'nodata', 'No rating yet');
    }

    // ---- Overall ----
    var reds = signals.filter(function (s) { return s.level === 'red'; }).length;
    var ambers = signals.filter(function (s) { return s.level === 'amber'; }).length;
    var known = signals.filter(function (s) { return s.level !== 'nodata'; }).length;
    var ratingRed = signals.some(function (s) { return s.key === 'rating' && s.level === 'red'; });
    var status;
    if (!known) status = 'nodata';
    else if (reds >= 2 || ratingRed) status = 'red';
    else if (reds === 1 || ambers >= 2) status = 'amber';
    else status = 'green';

    var reasons = signals.filter(function (s) { return s.level === 'red' || s.level === 'amber'; })
      .sort(function (x, y) { return RANK[y.level] - RANK[x.level]; })
      .map(function (s) { return s.label + ': ' + s.value; });

    return { status: status, signals: signals, reasons: reasons };
  }

  var api = { computeHealth: computeHealth, days: days };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Health = api;
})(typeof window !== 'undefined' ? window : this);
