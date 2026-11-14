// Token Radar's dashboard (radar-3). It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders three views over one dataset: the ranked board, the comparable universe
// the prices come from, and the method that turns the snapshot into both. Every farm plan,
// reason and risk on a protocol's card is the exact string board.json carries: the page
// generates nothing of its own, so what a reader sees is what the gate checked. No network.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var rows = DATA.rows;
  var state = { q: '', category: 'all', chain: 'all', watch: false, view: 'board', sort: 'rank', dir: 1, selected: null };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return 'n/a';
    return (n > 0 ? '+' : '') + Number(n).toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.round(days) + 'd';
  }
  function fmtMult(n) { return Number(n).toFixed(3) + 'x'; }

  // The board's log scale for the range whiskers: every row's low..high on one shared axis.
  var loMin = Math.min.apply(null, rows.map(function (r) { return r.implied_low_usd; }));
  var hiMax = Math.max.apply(null, rows.map(function (r) { return r.implied_high_usd; }));
  var logLo = Math.log10(Math.max(1, loMin)), logHi = Math.log10(hiMax);
  function pos(v) { return ((Math.log10(Math.max(1, v)) - logLo) / (logHi - logLo)) * 100; }

  function categories() {
    var seen = {};
    rows.forEach(function (r) { if (r.category) seen[r.category] = 1; });
    return Object.keys(seen).sort();
  }
  function chains() {
    var seen = {};
    rows.forEach(function (r) { r.chains.forEach(function (c) { seen[c] = 1; }); });
    return Object.keys(seen).sort();
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  var SORTS = {
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; },
    change: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
    age: function (r) { return r.age_days === null ? -1 : r.age_days; },
    implied: function (r) { return r.implied_value_usd; },
    score: function (r) { return r.score; },
  };
  function sorted(list) {
    var key = SORTS[state.sort] || SORTS.rank;
    return list.slice().sort(function (a, b) {
      var x = key(a), y = key(b);
      var d = x < y ? -1 : x > y ? 1 : 0;
      if (d === 0) d = a.rank - b.rank;
      return d * state.dir;
    });
  }

  function headerHtml() {
    var g = DATA.global_comps;
    return '<header class="top"><div class="logo">TOKEN<b>RADAR</b></div>' +
      '<div class="tagline">Pre-token protocols priced from the snapshot\'s own traded comparables — every rank carries its range, its evidence and its farm plan.</div>' +
      '<div class="modelbadge">model ' + esc(DATA.model_version) + ' · snapshot ' + esc(DATA.as_of) + '</div></header>' +
      '<div class="stats">' +
      '<div class="stat"><div class="v">' + DATA.protocols_scanned + '</div><div class="k">protocols scanned</div></div>' +
      '<div class="stat"><div class="v">' + DATA.tokenized_seen + '</div><div class="k">tokens already trading (the comparables)</div></div>' +
      '<div class="stat"><div class="v"><em>' + DATA.board_size + '</em></div><div class="k">pre-token protocols ranked</div></div>' +
      '<div class="stat"><div class="v">' + DATA.watchlist_size + '/' + DATA.watchlist_size + '</div><div class="k">house watchlist covered</div></div>' +
      '<div class="stat"><div class="v">' + fmtMult(g.use_median) + '</div><div class="k">median price of $1 of TVL, all categories</div></div>' +
      '<div class="stat"><div class="v">' + DATA.early_size + '</div><div class="k">early picks below the $50M floor</div></div>' +
      '</div>';
  }

  function tabsHtml() {
    function tab(id, label) {
      return '<button role="tab" data-view="' + id + '" aria-selected="' + (state.view === id) + '">' + label + '</button>';
    }
    return '<nav class="tabs" role="tablist">' + tab('board', 'The board') + tab('comps', 'Comparables') + tab('method', 'Method') + '</nav>';
  }

  function boardHtml() {
    var list = sorted(filtered());
    var catOpts = '<option value="all">All categories</option>' + categories().map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var chainOpts = '<option value="all">All chains</option>' + chains().map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    function th(key, label, cls) {
      var arrow = state.sort === key ? ' <span class="arrow">' + (state.dir === 1 ? '▲' : '▼') + '</span>' : '';
      return '<th class="sortable ' + (cls || '') + '" data-sort="' + key + '">' + label + arrow + '</th>';
    }
    var body = list.map(function (r) {
      var segL = pos(r.implied_low_usd), segW = Math.max(1.5, pos(r.implied_high_usd) - segL), dotL = pos(r.implied_value_usd);
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' +
        (r.on_watchlist ? '<span class="badge watch">WATCHLIST</span>' : '<span class="badge early">EARLY</span>') +
        '<div class="pcat">' + esc(r.category || 'Uncategorized') + ' · ' + r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</div></td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num hidem">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num"><b>' + fmtUsd(r.implied_value_usd) + '</b><div class="rangebar"><div class="seg" style="left:' + segL.toFixed(1) + '%;width:' + segW.toFixed(1) + '%"></div><div class="dot" style="left:calc(' + dotL.toFixed(1) + '% - 5px)"></div></div>' +
        '<div class="rangetxt">' + fmtUsd(r.implied_low_usd) + ' – ' + fmtUsd(r.implied_high_usd) + '</div></td>' +
        '<td class="scorecell"><span class="num">' + r.score + '</span><div class="scorebar"><i style="width:' + r.score + '%"></i></div></td>' +
        '<td class="plancell hidem"><b>$' + r.plan.capital_usd + '</b> · ' + r.plan.hold_days + 'd hold</td>' +
        '<td class="' + (r.risks.length ? 'riskn' : 'riskn none') + '">' + (r.risks.length ? '⚑ ' + r.risks.length : '—') + '</td></tr>';
    }).join('');
    return '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search name, slug, category…" value="' + esc(state.q) + '">' +
      '<select id="fcat">' + catOpts + '</select>' +
      '<select id="fchain">' + chainOpts + '</select>' +
      '<label class="check"><input type="checkbox" id="fwatch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label>' +
      '<span class="count">' + list.length + ' of ' + rows.length + ' ranked</span></div>' +
      '<table class="board"><thead><tr>' + th('rank', '#') + th('name', 'Protocol') + th('tvl', 'TVL', 'num') +
      th('change', '7d', 'num') + th('age', 'Age', 'num hidem') + th('implied', 'Implied value (base · range)', 'num') +
      th('score', 'Score') + '<th class="hidem">Farm plan</th><th>Risks</th></tr></thead><tbody>' + body + '</tbody></table>' +
      (list.length === 0 ? '<p class="pcat">No protocol matches these filters.</p>' : '');
  }

  function detailHtml(r) {
    var m = r.model, c = r.components;
    var recomputed = Math.round(r.tvl_usd * m.comp_median_multiple * m.growth_multiplier * m.maturity_multiplier * m.chain_multiplier * m.capture_multiplier);
    var delta = r.implied_value_usd === 0 ? 0 : Math.abs(recomputed - r.implied_value_usd) / r.implied_value_usd * 100;
    function comp(label, v, weight) {
      return '<div class="comp"><span>' + label + ' <span class="pcat">(' + weight + ')</span></span><div class="bar"><i style="width:' + Math.round(v * 100) + '%"></i></div><span class="val">' + Math.round(v * 100) + '</span></div>';
    }
    var steps = r.farm_steps.map(function (s) {
      var at = s.lastIndexOf(' Cost: ');
      var text = at > 0 ? s.slice(0, at) : s;
      var ct = at > 0 ? s.slice(at + 1) : '';
      return '<li>' + esc(text) + (ct ? '<span class="ct"><b>' + esc(ct) + '</b></span>' : '') + '</li>';
    }).join('');
    return '<div class="dwrap"><div class="dhead"><h2>' + esc(r.name) + '</h2>' +
      (r.on_watchlist ? '<span class="badge watch">WATCHLIST</span>' : '<span class="badge early">EARLY RADAR</span>') +
      '<button class="close" id="dclose">Close ✕</button></div>' +
      '<div class="dmeta">Rank #' + r.rank + ' of ' + rows.length + ' · ' + esc(r.category || 'Uncategorized') + ' · ' + esc(r.model.family) +
      ' · live on ' + r.chains.map(esc).join(', ') + ' · tracked since ' + esc(r.listed_at || 'unreported') + ' (' + fmtAge(r.age_days) + ') · records no token yet</div>' +
      '<div class="dgrid">' +
      '<div class="dcard"><div class="v">' + fmtUsd(r.implied_value_usd) + '</div><div class="k">implied value, base case</div></div>' +
      '<div class="dcard"><div class="v">' + fmtUsd(r.implied_low_usd) + ' – ' + fmtUsd(r.implied_high_usd) + '</div><div class="k">range (comparables\' P25–P75)</div></div>' +
      '<div class="dcard"><div class="v">' + fmtUsd(r.tvl_usd) + '</div><div class="k">TVL · ' + fmtPct(r.change_7d) + ' in 7d</div></div>' +
      '<div class="dcard"><div class="v">' + r.score + ' / 100</div><div class="k">audit score</div></div>' +
      '<div class="dcard"><div class="v">$' + r.plan.capital_usd + '</div><div class="k">farm plan capital · ' + r.plan.hold_days + 'd hold</div></div>' +
      '</div>' +
      '<h3 class="dsec">Why it ranks here — score components (percentiles inside the board)</h3>' +
      comp('Scale', c.scale, DATA.model.weights.scale) + comp('Momentum', c.momentum, DATA.model.weights.momentum) +
      comp('Maturity', c.maturity, DATA.model.weights.maturity) + comp('Reach', c.reach, DATA.model.weights.reach) +
      comp('Category fit', c.fit, DATA.model.weights.fit) + comp('Resilience', c.resilience, DATA.model.weights.resilience) +
      '<ul class="reasons">' + r.reasons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      '<h3 class="dsec">Farm plan — ' + r.farm_steps.length + ' steps, about $' + r.plan.capital_usd + ' of capital, ' + r.plan.hold_days + ' days</h3>' +
      '<ol class="plan">' + steps + '</ol>' +
      '<h3 class="dsec">What could make this wrong</h3>' +
      (r.risks.length ? '<ul class="risks">' + r.risks.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<p>None of the model\'s risk flags fire on this protocol\'s record.</p>') +
      '<h3 class="dsec">The model\'s working</h3>' +
      '<table class="work">' +
      '<tr><td>Comparable set: ' + esc(m.comp_group) + ' (' + m.comp_n + ' tokenized)</td><td>median ' + fmtMult(m.comp_median_multiple) + '</td></tr>' +
      '<tr><td>Comparables\' interquartile band (after shrinkage)</td><td>' + fmtMult(m.comp_p25_multiple) + ' – ' + fmtMult(m.comp_p75_multiple) + '</td></tr>' +
      '<tr><td>TVL base</td><td>' + fmtUsd(r.tvl_usd) + '</td></tr>' +
      '<tr><td>Growth adjustment (' + fmtPct(m.growth_pct) + ' clamped 7d)</td><td>× ' + m.growth_multiplier.toFixed(3) + '</td></tr>' +
      '<tr><td>Maturity adjustment (' + fmtAge(r.age_days) + ' tokenless)</td><td>× ' + m.maturity_multiplier.toFixed(3) + '</td></tr>' +
      '<tr><td>Reach adjustment (' + r.chains.length + ' chains)</td><td>× ' + m.chain_multiplier.toFixed(3) + '</td></tr>' +
      '<tr><td>Category capture (' + esc(m.family) + ')</td><td>× ' + m.capture_multiplier.toFixed(3) + '</td></tr>' +
      '<tr><td><b>Implied value</b></td><td><b>' + fmtUsd(r.implied_value_usd) + '</b></td></tr></table>' +
      '<div class="verify">Check it yourself: TVL × median multiple × the four adjustments, recomputed on this page from the figures above = <b>' + fmtUsd(recomputed) + '</b> — board.json carries <b>' + fmtUsd(r.implied_value_usd) + '</b> (Δ ' + delta.toFixed(2) + '%, the printed multiples are rounded to 4 places).</div></div>';
  }

  function compsHtml() {
    var cat = DATA.categories.map(function (s) {
      return '<tr><td>' + esc(s.group) + '</td><td class="num">' + s.n + '</td><td class="num">' + fmtMult(s.median) + '</td>' +
        '<td class="num">' + fmtMult(s.p25) + ' – ' + fmtMult(s.p75) + '</td><td class="num"><b>' + fmtMult(s.use_median) + '</b></td></tr>';
    }).join('');
    var top = DATA.comps.slice(0, 40).map(function (c) {
      return '<tr><td><span class="pname">' + esc(c.name) + '</span><div class="pcat">' + esc(c.category || 'Uncategorized') + '</div></td>' +
        '<td class="num">' + fmtUsd(c.tvl_usd) + '</td><td class="num">' + fmtUsd(c.mcap_usd) + '</td><td class="num">' + fmtMult(c.multiple) + '</td></tr>';
    }).join('');
    return '<p class="method">These are the prices the board is built from: every protocol in the snapshot whose token already trades, ' +
      'and what the market pays for each dollar of its TVL. A pre-token protocol is priced from its own category\'s row, shrunk toward the ' +
      'all-market row when its category has few traded members, so no thin category can anchor a price on two tokens.</p>' +
      '<h3 class="dsec">Category evidence (market cap per $1 of TVL)</h3>' +
      '<table class="plain"><thead><tr><th>Category</th><th>Tokens</th><th>Median</th><th>P25 – P75</th><th>Used (shrunk)</th></tr></thead><tbody>' + cat + '</tbody></table>' +
      '<h3 class="dsec">The largest traded comparables</h3>' +
      '<table class="plain"><thead><tr><th>Protocol</th><th>TVL</th><th>Market cap</th><th>Multiple</th></tr></thead><tbody>' + top + '</tbody></table>';
  }

  function methodHtml() {
    var w = DATA.model.weights, g = DATA.global_comps;
    return '<div class="method"><p><b>The question.</b> What would a token be worth if this protocol issued one today, at the size ' +
      'its record has already reached? The snapshot is all any entrant gets — TVL, seven-day TVL change, chains, category, the day ' +
      'tracking began, and whether a token already trades — so the model is built from exactly those figures and nothing else.</p>' +
      '<div class="formula">implied = TVL × shrunk median(market cap ÷ TVL of the category\'s traded protocols) × growth × maturity × reach × capture</div>' +
      '<p><b>Comparables first.</b> ' + DATA.tokenized_seen + ' protocols in this snapshot already have tokens; across all of them the market ' +
      'pays a median ' + fmtMult(g.use_median) + ' per $1 of TVL (P25 ' + fmtMult(g.use_p25) + ', P75 ' + fmtMult(g.use_p75) + '). Each category\'s own ' +
      'median is shrunk toward that market-wide figure with weight ' + DATA.model.shrink_k + ' — a category with 30 traded protocols stands nearly ' +
      'alone; one with 2 borrows the market\'s evidence. The printed range is the category\'s P25–P75 band, padded ' + Math.round(DATA.model.range_pad * 100) + '% each side.</p>' +
      '<p><b>Adjustments.</b> Growth moves the price by ' + DATA.model.growth_weight + ' of the seven-day TVL change, clamped to [' + DATA.model.growth_floor + '%, +' + DATA.model.growth_cap + '%] ' +
      'so one hot week cannot crown a protocol. Maturity pays ' + DATA.model.maturity_floor + '–' + (DATA.model.maturity_floor + DATA.model.maturity_range).toFixed(2) + ' across ' + DATA.model.maturity_days + ' days of tokenless operation: ' +
      'the longer a protocol has run at size with no token, the more pent-up demand a launch prices. Reach adds ' + Math.round(DATA.model.chain_step * 100) + '% per extra chain up to ' + DATA.model.chain_max_steps + '. ' +
      'Capture is the one judgement call, by family: fee-earning cores ×1.08, bridges ×0.94, stable assets ×0.93, and so on — every row\'s card shows its own.</p>' +
      '<p><b>The audit score.</b> Rank follows implied value; the 0–100 score exists so a reader can audit the rank. It blends six percentiles ' +
      'measured inside the ranked board itself — scale ' + w.scale + ', momentum ' + w.momentum + ', maturity ' + w.maturity + ', reach ' + w.reach + ', category fit ' + w.fit + ', resilience ' + w.resilience + ' — ' +
      'and every card prints all six, the three strongest reasons in words, and the risk flags its own record triggers.</p>' +
      '<p><b>What the snapshot does not carry.</b> No fees, no revenue, no user counts, no developer activity, no points-program data. The model ' +
      'invents none of them: where a classic signal is missing, the card\'s risk list says the record cannot confirm it instead of printing a ' +
      'number nobody measured. Implied value is this entry\'s claim, never a prediction that a token will launch.</p></div>';
  }

  function render() {
    var html = headerHtml() + tabsHtml() + '<section class="view">' +
      (state.view === 'board' ? boardHtml() : state.view === 'comps' ? compsHtml() : methodHtml()) + '</section>' +
      '<footer class="foot">Token Radar · model ' + esc(DATA.model_version) + ' · data: ' + esc(DATA.source) + ' · the page runs offline; every figure on it is in board.json and data.js.</footer>';
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    wire();
    if (state.selected) openDetail(state.selected);
  }

  var dialog = null;
  function openDetail(slug) {
    var r = rows.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    state.selected = slug;
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'detail';
      document.body.appendChild(dialog);
      dialog.addEventListener('click', function (e) { if (e.target === dialog) { dialog.close(); state.selected = null; } });
      dialog.addEventListener('close', function () { state.selected = null; });
    }
    dialog.innerHTML = detailHtml(r);
    document.getElementById('dclose').addEventListener('click', function () { dialog.close(); });
    if (!dialog.open) dialog.showModal();
  }

  function wire() {
    app.querySelectorAll('nav.tabs button').forEach(function (b) {
      b.addEventListener('click', function () { state.view = b.getAttribute('data-view'); syncHash(); render(); });
    });
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; render(); var nq = document.getElementById('q'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); });
    var fc = document.getElementById('fcat');
    if (fc) fc.addEventListener('change', function () { state.category = fc.value; syncHash(); render(); });
    var fh = document.getElementById('fchain');
    if (fh) fh.addEventListener('change', function () { state.chain = fh.value; render(); });
    var fw = document.getElementById('fwatch');
    if (fw) fw.addEventListener('change', function () { state.watch = fw.checked; render(); });
    app.querySelectorAll('th.sortable').forEach(function (t) {
      t.addEventListener('click', function () {
        var k = t.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'name' || k === 'rank' ? 1 : -1; }
        render();
      });
    });
    app.querySelectorAll('tbody tr[data-slug]').forEach(function (tr) {
      tr.addEventListener('click', function () { var s = tr.getAttribute('data-slug'); syncHash(s); openDetail(s); });
    });
  }

  function syncHash(slug) {
    var parts = [];
    if (state.view !== 'board') parts.push('view=' + state.view);
    if (state.category !== 'all') parts.push('category=' + encodeURIComponent(state.category));
    if (slug) parts.push('p=' + encodeURIComponent(slug));
    history.replaceState(null, '', parts.length ? '#' + parts.join('&') : '#');
  }
  function readHash() {
    var h = (location.hash || '').replace(/^#/, '');
    h.split('&').forEach(function (kv) {
      var at = kv.indexOf('=');
      if (at < 0) return;
      var k = kv.slice(0, at), v = decodeURIComponent(kv.slice(at + 1));
      if (k === 'view' && (v === 'comps' || v === 'method' || v === 'board')) state.view = v;
      if (k === 'category') state.category = v;
      if (k === 'p') state.selected = v;
    });
  }

  readHash();
  render();
})();
