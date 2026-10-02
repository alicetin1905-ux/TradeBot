// TradeBot home-screen widget for iOS — runs in the free "Scriptable" app.
// Shows equity and realized P&L (today / 7 days), open positions with a
// stop→T3 progress bar and distance to stop / next target, the money at risk,
// and the coins at score +50 / −50 with why each can or can't enter yet.
// Reads the same public state files as the dashboard (state/demo/*.json on
// GitHub); it needs no keys and can't trade. Setup: see ios/README.md.

const RAW = 'https://raw.githubusercontent.com/alicetin1905-ux/TradeBot/main/state/demo/';
const DASHBOARD = 'https://alicetin1905-ux.github.io/TradeBot/';
const MIN_SCORE = 50; // same as ENTRY_MIN_SCORE
const H4 = 4 * 3600 * 1000;

const C = {
  bg: new Color('#0d1117'), text: new Color('#e6edf3'), dim: new Color('#8b949e'), track: new Color('#30363d'),
  green: new Color('#3fb950'), red: new Color('#f85149'), amber: new Color('#d29922'),
};

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

function progressBar(p, mark, w, h) {
  const dc = new DrawContext();
  dc.size = new Size(w, h);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const x = (price) => along(p, price) * w;
  dc.setFillColor(C.track);
  dc.fillRect(new Rect(0, h / 2 - 1.5, w, 3));
  const a = x(p.entry), b = x(mark);
  dc.setFillColor(b >= a ? C.green : C.red);
  dc.fillRect(new Rect(Math.min(a, b), h / 2 - 1.5, Math.abs(b - a), 3));
  [[p.t1, C.dim], [p.t2, C.dim], [p.t3, C.dim], [p.entry, C.text], [p.stop, C.red]].forEach(([price, c]) => {
    dc.setFillColor(c);
    dc.fillRect(new Rect(Math.max(0, Math.min(w - 1.5, x(price) - 0.75)), 0, 1.5, h));
  });
  dc.setFillColor(C.text);
  dc.fillEllipse(new Rect(Math.max(0, Math.min(w - 5, b - 2.5)), h / 2 - 2.5, 5, 5));
  return dc.getImage();
}

// distance (%) from the mark to the stop and to the next unfilled target
function distances(p, mark) {
  const toStop = (mark - p.stop) * p.bias / mark * 100;
  const next = !p.filled.t1 ? ['T1', p.t1] : !p.filled.t2 ? ['T2', p.t2] : ['T3', p.t3];
  return { toStop, nextName: next[0], toNext: (next[1] - mark) * p.bias / mark * 100 };
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
  text(box, 'OPEN ' + pos.length + '/' + o.maxOpen, 9, C.dim, 'bold');
  if (!pos.length) text(box, 'no open positions', 11, C.dim);
  const sorted = pos.slice().sort((a, b) => (b.unrealisedPnl || 0) - (a.unrealisedPnl || 0));
  sorted.slice(0, o.max).forEach((p) => {
    const mark = p.markPrice || p.entry;
    const row = box.addStack(); row.centerAlignContent();
    text(row, (p.bias > 0 ? '▲ ' : '▼ ') + short(p.symbol), 12, p.bias > 0 ? C.green : C.red, 'bold');
    row.addSpacer(5);
    text(row, stage(p) || (p.breakeven ? 'BE' : ''), 9, C.amber);
    row.addSpacer(5);
    if (o.bar) {
      const img = row.addImage(progressBar(p, mark, 60, 10));
      img.imageSize = new Size(60, 10);
    }
    row.addSpacer();
    text(row, money(p.unrealisedPnl || 0, 1), 12, col(p.unrealisedPnl || 0), 'mono');
    if (o.detail) {
      const d = distances(p, mark);
      text(box.addStack(), 'stop ' + pct(-d.toStop) + '  ·  ' + d.nextName + ' ' + pct(d.toNext), 9, C.dim);
    }
  });
  if (pos.length > o.max) text(box, '+' + (pos.length - o.max) + ' more', 10, C.dim);
}

function strongRows(box, strong, pos, account, o) {
  text(box, 'SCORE ±' + MIN_SCORE + ' · NOT OPEN', 9, C.dim, 'bold');
  if (!strong.length) text(box, 'none right now', 11, C.dim);
  strong.slice(0, o.max).forEach(([sym, s]) => {
    const row = box.addStack(); row.centerAlignContent();
    text(row, short(sym) + ' ', 11, C.text, 'bold');
    text(row, (s.score > 0 ? '+' : '') + s.score, 11, s.score > 0 ? C.green : C.red, 'mono');
    if (o.reason) {
      row.addSpacer();
      const r = readiness(s, pos, account);
      text(row, o.long ? r.t : r.s, 10, r.c, r.s === 'READY' ? 'bold' : null);
    }
  });
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
  const upnl = pos.reduce((s, p) => s + (p.unrealisedPnl || 0), 0);
  const equity = account.exchangeEquity != null ? account.exchangeEquity : account.balance;
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
    const openTxt = pos.slice().sort((x, y) => (y.unrealisedPnl || 0) - (x.unrealisedPnl || 0)).slice(0, 3)
      .map((p) => (p.bias > 0 ? '▲' : '▼') + short(p.symbol) + ' ' + money(p.unrealisedPnl || 0).replace('$', '')).join(' ');
    t(w, openTxt || 'no open positions', 11);
    const strongTxt = strong.slice(0, 3).map(([sym, s]) => short(sym) + ' ' + (s.score > 0 ? '+' : '') + s.score).join('  ');
    t(w, '≥50: ' + (strongTxt || 'none'), 11);
  }
  return w;
}

function build(data) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = DASHBOARD;
  w.setPadding(12, 14, 12, 14);
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  const fam = config.widgetFamily || 'medium';
  const small = fam === 'small', large = fam === 'large' || fam === 'extraLarge';

  if (!data) {
    text(w, 'TradeBot', 15, C.text, 'bold');
    text(w, 'No data — check connection', 12, C.dim);
    return w;
  }
  const { account, positions, scores, tradesFile } = data;
  const pos = Object.values(positions || {});
  const trades = Array.isArray(tradesFile) ? tradesFile : (tradesFile && tradesFile.trades) || [];
  const upnl = pos.reduce((s, p) => s + (p.unrealisedPnl || 0), 0);
  const equity = account.exchangeEquity != null ? account.exchangeEquity : account.balance;
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
  if (start && !small) text(sub, pct((equity - start) / start * 100) + ' total', 10, C.dim);
  if (large) text(w.addStack(), '7 days ' + money(R.week) + '  ·  realized ' + money(R.all), 10, C.dim);
  w.addSpacer(6);

  if (fam === 'medium') {
    // two columns: positions left, strong coins right
    const body = w.addStack(); body.layoutHorizontally();
    const left = body.addStack(); left.layoutVertically();
    body.addSpacer();
    const right = body.addStack(); right.layoutVertically();
    positionRows(left, pos, trades, { maxOpen, max: 3, bar: true, detail: false });
    strongRows(right, strong, pos, account, { max: 3, reason: true, long: false });
  } else {
    positionRows(w, pos, trades, { maxOpen, max: small ? 2 : 6, bar: !small, detail: large });
    w.addSpacer(6);
    strongRows(w, strong, pos, account, { max: small ? 2 : 8, reason: !small, long: true });
  }

  // money at risk: what the book is worth if every stop fills now (banked partials included)
  if (pos.length && !small) {
    let stopOut = 0;
    for (const p of pos) {
      const banked = trades.filter((t) => t.symbol === p.symbol && t.openedAt === p.openedAt).reduce((s, t) => s + t.pnl, 0);
      stopOut += banked + p.qtyRemaining * (p.stop - p.entry) * p.bias;
    }
    w.addSpacer(4);
    const line = w.addStack(); line.centerAlignContent();
    text(line, stopOut < 0 ? 'at risk ' : 'locked in ', 10, C.dim);
    text(line, money(stopOut), 10, col(stopOut), 'bold');
    text(line, '  if all stops hit', 10, C.dim);
    line.addSpacer();
    text(line, (maxOpen - pos.length) + ' slot' + (maxOpen - pos.length === 1 ? '' : 's') + ' free', 10, C.dim);
  }

  // footer: BTC filter, next entry check, time
  w.addSpacer();
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
  const [account, positions, scores, tradesFile] = await Promise.all([load('account'), load('positions'), load('scores'), load('trades')]);
  data = { account, positions, scores, tradesFile };
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
