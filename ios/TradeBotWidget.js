// TradeBot home-screen widget for iOS — runs in the free "Scriptable" app.
// Shows equity and realized P&L (today / 7 days), open positions with a
// stop→T3 progress bar and distance to stop / next target, the money at risk,
// and the coins at score +50 / −50 with why each can or can't enter yet.
// Reads the same public state files as the dashboard (state/demo/*.json on
// GitHub); it needs no keys and can't trade. Setup: see ios/README.md.

const RAW = 'https://raw.githubusercontent.com/alicetin1905-ux/TradeBot/main/state/demo/';
const DASHBOARD = 'https://alicetin1905-ux.github.io/TradeBot/';
let MIN_SCORE = 50; // replaced by the bot's live ENTRY_MIN_SCORE once account.json loads
const H4 = 4 * 3600 * 1000;

const C = {
  bg: new Color('#0d1117'), text: new Color('#e6edf3'), dim: new Color('#8b949e'), track: new Color('#30363d'),
  green: new Color('#3fb950'), red: new Color('#f85149'), amber: new Color('#d29922'),
};

// Live mark price per open coin — the same source the dashboard uses (Bybit,
// OKX as fallback), so the widget's P&L matches it instead of the bot's last
// sync (which can be up to 5 minutes old).
const OKX_ALIAS = { '1000PEPEUSDT': { id: 'PEPE-USDT-SWAP', mult: 1000 }, '1000BONKUSDT': { id: 'BONK-USDT-SWAP', mult: 1000 } };
async function liveMark(sym) {
  try {
    const r = new Request('https://api.bybit.com/v5/market/tickers?category=linear&symbol=' + sym);
    r.timeoutInterval = 8;
    const d = await r.loadJSON();
    const t = d.retCode === 0 && d.result && d.result.list && d.result.list[0];
    if (t && +t.markPrice > 0) return +t.markPrice;
  } catch (e) { /* try OKX */ }
  try {
    const a = OKX_ALIAS[sym] || { id: sym.replace(/USDT$/, '') + '-USDT-SWAP', mult: 1 };
    const r = new Request('https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=' + a.id);
    r.timeoutInterval = 8;
    const d = await r.loadJSON();
    if (d.code === '0' && d.data && d.data[0]) return +d.data[0].markPx * a.mult;
  } catch (e) { /* keep the bot's last value */ }
  return null;
}

// price with the coin's own decimals (from its tick size), e.g. 0.5565 / 0.01732
function fmtPrice(p, x) {
  const dec = p.tickSize ? Math.max(0, Math.round(-Math.log10(p.tickSize))) : (x >= 100 ? 2 : x >= 1 ? 4 : 6);
  return x.toFixed(Math.min(dec, 8));
}

const markOf = (p) => p._mark || p.markPrice || p.entry;
// P&L the way the dashboard computes it: (mark − entry) × direction × open size
const pnlOf = (p) => p._mark ? (p._mark - p.entry) * p.bias * p.qtyRemaining : (p.unrealisedPnl || 0);

async function load(name) {
  const r = new Request(RAW + name + '.json?_=' + Date.now());
  r.timeoutInterval = 15;
  return await r.loadJSON();
}

const short = (s) => s.replace(/USDT$/, '').replace(/^1000/, '');
const money = (n, d = 0) => (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toFixed(d);
const pct = (n, d = 1) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(d) + '%';
const col = (n) => (n > 0 ? C.green : n < 0 ? C.red : C.dim);

function text(stack, s, size, color, weight) {
  const t = stack.addText(String(s));
  t.font = weight === 'bold' ? Font.boldSystemFont(size) : weight === 'mono' ? Font.boldMonospacedSystemFont(size) : Font.systemFont(size);
  t.textColor = color || C.text;
  t.lineLimit = 1;
  return t;
}

function stage(p) {
  if (p.filled && p.filled.t2) return 'T2✓';
  if (p.filled && p.filled.t1) return 'T1✓';
  return '';
}

// position of a price on the original-stop → T3 line (0..1), same for longs and shorts
function along(p, price) {
  const lo = p.initialStop != null ? p.initialStop : p.stop;
  const u = (price - lo) / (p.t3 - lo);
  return Math.max(0, Math.min(1, u));
}

// Width of the widget's content area in points. iOS doesn't tell a script
// its widget size, so it's looked up from the screen width (Apple's sizes).
function contentWidth() {
  const sw = Device.screenSize().width;
  const table = { 440: 364, 430: 364, 428: 364, 414: 360, 402: 338, 393: 338, 390: 338, 375: 329, 360: 329, 320: 292 };
  const w = table[sw] || (sw >= 428 ? 364 : sw >= 390 ? 338 : 329);
  return w - 28; // minus the 14pt side padding
}

// stop → T3 line: red tick = stop, white = entry, grey ticks = targets (green
// once filled), dot = price, coloured fill = entry → price. With labels, SL /
// T1 / T2 / T3 are written under their ticks.
function progressBar(p, mark, w, labels) {
  const lh = labels ? 9 : 0, bh = 8, h = bh + lh;
  const dc = new DrawContext();
  dc.size = new Size(w, h);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const x = (price) => along(p, price) * w;
  const mid = bh / 2;
  dc.setFillColor(C.track);
  dc.fillRect(new Rect(0, mid - 1.5, w, 3));
  const a = x(p.entry), b = x(mark);
  dc.setFillColor(b >= a ? C.green : C.red);
  dc.fillRect(new Rect(Math.min(a, b), mid - 1.5, Math.abs(b - a), 3));
  const f = p.filled || {};
  const ticks = [
    [p.t1, f.t1 ? C.green : C.dim, 'T1'], [p.t2, f.t2 ? C.green : C.dim, 'T2'], [p.t3, f.t3 ? C.green : C.dim, 'T3'],
    [p.entry, C.text, null], [p.stop, C.red, 'SL'],
  ];
  for (const [price, c, name] of ticks) {
    const tx = Math.max(0, Math.min(w - 2, x(price) - 1));
    dc.setFillColor(c);
    dc.fillRect(new Rect(tx, 0, 2, bh));
    if (labels && name) {
      dc.setFont(Font.boldSystemFont(7));
      dc.setTextColor(c);
      dc.setTextAlignedCenter();
      const lx = Math.max(0, Math.min(w - 16, tx - 7));
      dc.drawTextInRect(name, new Rect(lx, bh, 16, lh));
    }
  }
  dc.setFillColor(C.text);
  dc.fillEllipse(new Rect(Math.max(0, Math.min(w - 7, b - 3.5)), mid - 3.5, 7, 7));
  return { img: dc.getImage(), w, h };
}

// distance (%) from the mark to the stop and to the next unfilled target
function distances(p, mark) {
  const toStop = (mark - p.stop) * p.bias / mark * 100;
  const next = !p.filled.t1 ? ['T1', p.t1] : !p.filled.t2 ? ['T2', p.t2] : ['T3', p.t3];
  return { toStop, nextName: next[0], toNext: (next[1] - mark) * p.bias / mark * 100 };
}

// what the open book is worth if every stop fills now (banked partials included)
function stopOutValue(pos, trades) {
  let v = 0;
  for (const p of pos) {
    const banked = trades.filter((t) => t.symbol === p.symbol && t.openedAt === p.openedAt).reduce((s, t) => s + t.pnl, 0);
    v += banked + p.qtyRemaining * (p.stop - p.entry) * p.bias;
  }
  return v;
}

function realized(trades) {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const wk = Date.now() - 7 * 24 * 3600 * 1000;
  let today = 0, week = 0, all = 0;
  for (const t of trades) {
    all += t.pnl;
    if (t.closedAt >= t0.getTime()) today += t.pnl;
    if (t.closedAt >= wk) week += t.pnl;
  }
  return { today, week, all };
}

function countdown() {
  const ms = Math.ceil(Date.now() / H4) * H4 - Date.now();
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000);
  return h ? h + 'h ' + m + 'm' : m + 'm';
}

// why a strong coin isn't open yet, from the bot's own `wait` field plus slot limits
// (t = full wording, s = short wording for the narrow medium column)
function readiness(s, pos, account) {
  const st = account.settings || {};
  const maxOpen = st.MAX_OPEN_POSITIONS || 5, maxDir = st.MAX_SAME_DIRECTION || 4;
  const dir = s.score > 0 ? 1 : -1;
  if (pos.length >= maxOpen) return { t: 'slots full', s: 'full', c: C.amber };
  if (pos.filter((p) => p.bias === dir).length >= maxDir) return { t: (dir > 0 ? 'long' : 'short') + ' limit ' + maxDir + '/' + maxDir, s: (dir > 0 ? 'long' : 'short') + ' max', c: C.amber };
  switch (s.wait) {
    case 'used': return { t: 'signal used', s: 'used', c: C.dim };
    case 'stale': return { t: 'next 4H close ' + countdown(), s: 'next 4H', c: C.amber };
    case 'chase': return { t: 'ran too far', s: 'too far', c: C.amber };
    case 'fib': return { t: 'Fib check', s: 'Fib', c: C.amber };
    case 'btc': return { t: 'BTC blocks', s: 'BTC', c: C.red };
    case 'weak': return { t: 'below ' + MIN_SCORE, s: '<' + MIN_SCORE, c: C.dim };
    default: return { t: 'READY', s: 'READY', c: C.green };
  }
}

function positionRows(box, pos, trades, o) {
  if (o.label) text(box, 'OPEN ' + pos.length + '/' + o.maxOpen, 9, C.dim, 'bold');
  if (!pos.length) text(box, 'no open positions', 11, C.dim);
  const sorted = pos.slice().sort((a, b) => pnlOf(b) - pnlOf(a));
  sorted.slice(0, o.max).forEach((p, i) => {
    const mark = markOf(p);
    if (i) box.addSpacer(o.gap);
    const row = box.addStack(); row.centerAlignContent();
    text(row, (p.bias > 0 ? '▲ ' : '▼ ') + short(p.symbol), 12, p.bias > 0 ? C.green : C.red, 'bold');
    if (o.price) {
      row.addSpacer(6);
      text(row, fmtPrice(p, mark), 11, C.text, 'mono');
    }
    row.addSpacer(5);
    text(row, stage(p) || (p.breakeven ? 'BE' : ''), 9, C.amber);
    row.addSpacer();
    if (o.detail) {
      const d = distances(p, mark);
      text(row, 'SL ' + pct(-d.toStop) + ' · ' + d.nextName + ' ' + pct(d.toNext), 9, C.dim);
      row.addSpacer(8);
    }
    text(row, money(pnlOf(p), 1), 12, col(pnlOf(p)), 'mono');
    if (o.bar) {
      box.addSpacer(2);
      const bar = progressBar(p, mark, o.width, o.labels);
      const img = box.addImage(bar.img);
      img.imageSize = new Size(bar.w, bar.h);
    }
  });
  for (const w of o.pending || []) {
    const row = box.addStack(); row.centerAlignContent();
    text(row, '⏳ ' + short(w.symbol) + ' ' + (w.bias > 0 ? 'long' : 'short') + ' limit ' + fmtPrice(w, w.price), 10, C.amber);
  }
  if (o.more !== false && pos.length > o.max) text(box, '+' + (pos.length - o.max) + ' more', 10, C.dim);
}

function strongRows(box, strong, pos, account, o) {
  text(box, 'SCORE ±' + MIN_SCORE + ' · NOT OPEN', 9, C.dim, 'bold');
  if (!strong.length) text(box, 'none right now', 11, C.dim);
  const shown = strong.slice(0, o.max), per = o.perRow || 1;
  for (let i = 0; i < shown.length; i += per) {
    const row = box.addStack(); row.centerAlignContent();
    shown.slice(i, i + per).forEach(([sym, s], k) => {
      if (k) row.addSpacer(14);
      const cell = row.addStack(); cell.centerAlignContent();
      text(cell, short(sym) + ' ', 11, C.text, 'bold');
      text(cell, (s.score > 0 ? '+' : '') + s.score, 11, s.score > 0 ? C.green : C.red, 'mono');
      if (o.reason) {
        cell.addSpacer(6);
        const r = readiness(s, pos, account);
        text(cell, per > 1 ? r.s : r.t, 10, r.c, r.s === 'READY' ? 'bold' : null);
      }
      if (per === 1) row.addSpacer();
    });
    if (per > 1) row.addSpacer();
  }
  if (strong.length > o.max) text(box, '+' + (strong.length - o.max) + ' more', 10, C.dim);
}

// Lock Screen / StandBy widgets (iOS 16+): tiny, monochrome, text only.
const LOCK = ['accessoryInline', 'accessoryCircular', 'accessoryRectangular'];

function buildLock(fam, data) {
  const w = new ListWidget();
  w.url = DASHBOARD;
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  const t = (box, s, size, weight) => {
    const x = box.addText(String(s));
    x.font = weight === 'bold' ? Font.boldSystemFont(size) : Font.systemFont(size);
    x.lineLimit = 1;
    x.minimumScaleFactor = 0.6; // shrink instead of cutting off on the narrow Lock Screen
    return x;
  };
  if (!data) { t(w, 'TradeBot: no data', 12); return w; }
  const { account, positions, scores, tradesFile } = data;
  const pos = Object.values(positions || {});
  const trades = Array.isArray(tradesFile) ? tradesFile : (tradesFile && tradesFile.trades) || [];
  const upnl = pos.reduce((s, p) => s + (pnlOf(p)), 0);
  const equity = account.balance + upnl; // same as the dashboard: balance + live open P&L
  const maxOpen = (account.settings && account.settings.MAX_OPEN_POSITIONS) || 5;
  const traded = new Set((account.settings && account.settings.SYMBOLS) || Object.keys(scores));
  const open = new Set(pos.map((p) => p.symbol));
  const strong = Object.entries(scores)
    .filter(([sym, s]) => traded.has(sym) && !open.has(sym) && s && s.score != null && Math.abs(s.score) >= MIN_SCORE)
    .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score));

  if (fam === 'accessoryInline') {
    t(w, 'TB $' + equity.toFixed(0) + ' · ' + money(upnl) + ' · ' + pos.length + '/' + maxOpen, 12);
  } else if (fam === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    w.addSpacer();
    const a = w.addStack(); a.addSpacer(); t(a, money(upnl), 15, 'bold'); a.addSpacer();
    const b = w.addStack(); b.addSpacer(); t(b, pos.length + '/' + maxOpen + ' open', 9); b.addSpacer();
    w.addSpacer();
  } else {
    // rectangular: equity + open P&L, open coins, strong coins (3 short lines)
    const R = realized(trades);
    t(w, '$' + equity.toFixed(0) + '  open ' + money(upnl) + '  day ' + money(R.today), 12, 'bold');
    const openTxt = pos.slice().sort((x, y) => pnlOf(y) - pnlOf(x)).slice(0, 3)
      .map((p) => (p.bias > 0 ? '▲' : '▼') + short(p.symbol) + ' ' + money(pnlOf(p)).replace('$', '')).join(' ');
    t(w, openTxt || 'no open positions', 11);
    const strongTxt = strong.slice(0, 3).map(([sym, s]) => short(sym) + ' ' + (s.score > 0 ? '+' : '') + s.score).join('  ');
    t(w, '≥' + MIN_SCORE + ': ' + (strongTxt || 'none'), 11);
  }
  return w;
}

// what the book is worth if every stop fills now, and free slots
function riskLine(w, pos, trades, maxOpen, small) {
  if (!pos.length || small) return;
  const stopOut = stopOutValue(pos, trades);
  w.addSpacer(4);
  const line = w.addStack(); line.centerAlignContent();
  text(line, stopOut < 0 ? 'at risk ' : 'locked in ', 10, C.dim);
  text(line, money(stopOut), 10, col(stopOut), 'bold');
  text(line, '  if all stops hit', 10, C.dim);
  line.addSpacer();
  text(line, (maxOpen - pos.length) + ' slot' + (maxOpen - pos.length === 1 ? '' : 's') + ' free', 10, C.dim);
}

function build(data) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = DASHBOARD;
  const fam = config.widgetFamily || 'medium';
  const small = fam === 'small', large = fam === 'large' || fam === 'extraLarge';
  w.setPadding(fam === 'medium' ? 10 : 12, 14, fam === 'medium' ? 10 : 12, 14);
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

  if (!data) {
    text(w, 'TradeBot', 15, C.text, 'bold');
    text(w, 'No data — check connection', 12, C.dim);
    return w;
  }
  const { account, positions, scores, tradesFile } = data;
  const pos = Object.values(positions || {});
  const trades = Array.isArray(tradesFile) ? tradesFile : (tradesFile && tradesFile.trades) || [];
  const upnl = pos.reduce((s, p) => s + (pnlOf(p)), 0);
  const equity = account.balance + upnl; // same as the dashboard: balance + live open P&L
  const pend = (data.pending || []).slice(0, large ? 3 : 1);
  const start = account.startingBalance || 0;
  const R = realized(trades);
  const maxOpen = (account.settings && account.settings.MAX_OPEN_POSITIONS) || 5;

  const traded = new Set((account.settings && account.settings.SYMBOLS) || Object.keys(scores));
  const open = new Set(pos.map((p) => p.symbol));
  const strong = Object.entries(scores)
    .filter(([sym, s]) => traded.has(sym) && !open.has(sym) && s && s.score != null && Math.abs(s.score) >= MIN_SCORE)
    .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score));

  // header: equity, open P&L, realized today (+7 days on large)
  const head = w.addStack(); head.centerAlignContent();
  text(head, 'TradeBot', small ? 13 : 15, C.text, 'bold');
  head.addSpacer();
  text(head, '$' + equity.toFixed(0), small ? 13 : 15, col(equity - start), 'bold');
  const sub = w.addStack();
  text(sub, 'open ' + money(upnl), 11, col(upnl), 'bold');
  sub.addSpacer(8);
  text(sub, 'today ' + money(R.today), 11, col(R.today), 'bold');
  sub.addSpacer();
  if (fam === 'medium' && pos.length) {
    const so = stopOutValue(pos, trades);
    text(sub, (so < 0 ? 'risk ' : 'locked ') + money(so) + ' · ' + pos.length + '/' + maxOpen, 10, C.dim);
  } else if (start && !small) text(sub, pct((equity - start) / start * 100) + ' total', 10, C.dim);
  if (large) text(w.addStack(), '7 days ' + money(R.week) + '  ·  realized ' + money(R.all), 10, C.dim);
  w.addSpacer(6);

  const W = contentWidth();
  if (fam === 'medium') {
    positionRows(w, pos, trades, { maxOpen, max: 3, bar: true, labels: false, detail: false, price: true, width: W, gap: 3, more: false, pending: pos.length < 3 ? pend : [] });
    w.addSpacer(4);
    // strong coins on one line, with the reason for the strongest
    const line = w.addStack(); line.centerAlignContent();
    text(line, '±' + MIN_SCORE + ' ', 10, C.dim, 'bold');
    if (!strong.length) text(line, 'none', 10, C.dim);
    strong.slice(0, 4).forEach(([sym, s]) => {
      text(line, short(sym) + ' ', 10, C.text, 'bold');
      text(line, (s.score > 0 ? '+' : '') + s.score + '  ', 10, s.score > 0 ? C.green : C.red, 'mono');
    });
    line.addSpacer();
    if (strong.length) { const r = readiness(strong[0][1], pos, account); text(line, r.s, 10, r.c, r.s === 'READY' ? 'bold' : null); }
  } else {
    positionRows(w, pos, trades, { label: true, maxOpen, max: small ? 2 : 5, bar: !small, labels: large, detail: large, price: !small, pending: small ? [] : pend, width: W, gap: large ? 4 : 1 });
    riskLine(w, pos, trades, maxOpen, small);
    // strong coins sit at the bottom; the fewer positions are open, the more of them fit
    w.addSpacer();
    const rows = large ? Math.max(2, 7 - pos.length) : 6;
    strongRows(w, strong, pos, account, { max: small ? 2 : large ? rows * 2 : 6, reason: !small, long: true, perRow: large ? 2 : 1 });
  }

  if (fam === 'medium') return w;

  // footer: BTC filter, next entry check, time
  w.addSpacer(6);
  const foot = w.addStack(); foot.centerAlignContent();
  const btc = scores.BTCUSDT;
  if (btc && btc.score != null && !small) text(foot, 'BTC filter ' + (btc.score > 0 ? '+' : '') + btc.score, 10, C.dim);
  foot.addSpacer();
  text(foot, small ? '' : 'next 4H ' + countdown() + ' · ', 10, C.dim);
  text(foot, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 10, C.dim);
  return w;
}

let data = null;
try {
  const [account, positions, scores, tradesFile, pending] = await Promise.all([load('account'), load('positions'), load('scores'), load('trades'), load('pending').catch(() => ({}))]);
  data = { account, positions, scores, tradesFile, pending: Object.values(pending || {}) };
  await Promise.all(Object.values(positions || {}).map(async (p) => { p._mark = await liveMark(p.symbol); }));
  if (account.settings && account.settings.ENTRY_MIN_SCORE) MIN_SCORE = account.settings.ENTRY_MIN_SCORE;
} catch (e) { console.error(e); }

const family = config.widgetFamily || 'medium';
const widget = LOCK.includes(family) ? buildLock(family, data) : build(data);
if (config.runsInWidget) Script.setWidget(widget);
else if (family === 'small') await widget.presentSmall();
else if (family === 'accessoryRectangular') await widget.presentAccessoryRectangular();
else if (family === 'accessoryCircular') await widget.presentAccessoryCircular();
else if (family === 'accessoryInline') await widget.presentAccessoryInline();
else await widget.presentMedium();
Script.complete();
