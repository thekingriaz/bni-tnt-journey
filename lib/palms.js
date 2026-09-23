/* Parses the BNI Connect "Chapter > Summary PALMS Report" export (.xls XML) after SheetJS
   has turned it into rows (sheet_to_json header:1). Shared by browser and tests. */
(function (root) {
  function firstVal(row) {
    for (var i = 1; i < row.length; i++) if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return row[i];
    return '';
  }
  function toISO(v) {
    if (v === '' || v === null || v === undefined) return null;
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    if (v instanceof Date) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0, 10);
    var s = String(v).trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
    if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    return null;
  }
  function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }

  function parsePalms(rows) {
    var out = { chapter: null, from: null, to: null, members: [], errors: [] };
    var header = -1;
    for (var i = 0; i < rows.length; i++) {
      var c0 = String(rows[i][0] || '').trim();
      if (c0 === 'Chapter:') out.chapter = String(firstVal(rows[i])).trim();
      else if (c0 === 'From:') out.from = toISO(firstVal(rows[i]));
      else if (c0 === 'To:') out.to = toISO(firstVal(rows[i]));
      else if (c0 === 'First Name') { header = i; break; }
    }
    if (header < 0) { out.errors.push('Could not find the "First Name" header row. Is this a Chapter Summary PALMS Report?'); return out; }
    if (!out.from || !out.to) out.errors.push('Could not read the From / To dates.');
    var idx = {};
    rows[header].forEach(function (h, j) { h = String(h).trim(); if (h && idx[h] === undefined) idx[h] = j; });
    ['Last Name', 'P', 'A', 'RGI', 'RGO', 'RRI', 'RRO', '1-2-1'].forEach(function (k) {
      if (idx[k] === undefined) out.errors.push('Missing column: ' + k);
    });
    if (out.errors.length) return out;
    for (var r = header + 1; r < rows.length; r++) {
      var row = rows[r];
      var first = String(row[0] || '').trim();
      if (!first || first === 'Visitors' || first === 'BNI' || first === 'Total') continue;
      var g = function (k) { return idx[k] === undefined ? 0 : n(row[idx[k]]); };
      out.members.push({
        palms_name: (first + ' ' + String(row[idx['Last Name']] || '').trim()).trim(),
        p: g('P'), a: g('A'), l: g('L'), m: g('M'), s: g('S'),
        rgi: g('RGI'), rgo: g('RGO'), rri: g('RRI'), rro: g('RRO'), v: g('V'),
        one2one: g('1-2-1'), tyfcb: g('TYFCB'), ceu: g('CEU')
      });
    }
    return out;
  }

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function tokens(s) { return norm(s).split(' ').filter(Boolean).sort().join(' '); }

  // Suggest a member for a PALMS name: exact, then same words in any order, then a saved link.
  function matchMember(palmsName, members, links) {
    var link = (links || []).find(function (l) { return norm(l.palms_name) === norm(palmsName); });
    if (link) return { member_id: link.member_id, how: 'linked' };
    var ex = members.find(function (m) { return norm(m.full_name) === norm(palmsName); });
    if (ex) return { member_id: ex.id, how: 'exact' };
    var tk = members.find(function (m) { return tokens(m.full_name) === tokens(palmsName); });
    if (tk) return { member_id: tk.id, how: 'words' };
    return null;
  }

  var api = { parsePalms: parsePalms, matchMember: matchMember, toISO: toISO, norm: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Palms = api;
})(typeof window !== 'undefined' ? window : this);
