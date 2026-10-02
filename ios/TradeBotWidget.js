// TradeBot home-screen widget for iOS — runs in the free "Scriptable" app.
// Shows equity, open positions with live P&L, and the coins whose score is
// +50 or higher / -50 or lower. Reads the same public state files as the
// dashboard (state/demo/*.json on GitHub); it needs no keys and can't trade.
//
// Setup: see ios/README.md. Sizes: small, medium and large widgets all work;
// run the script inside Scriptable to preview it.

const RAW = 'https://raw.githubusercontent.com/alicetin1905-ux/TradeBot/main/state/demo/';
const DASHBOARD = 'https://alicetin1905-ux.github.io/TradeBot/';
const MIN_SCORE = 50; // same as ENTRY_MIN_SCORE

const C = {
  bg: new Color('#0d1117'), card: new Color('#161b22'), text: new Color('#e6edf3'), dim: new Color('#8b949e'),
  green: new Color('#3fb950'), red: new Color('#f85149'), amber: new Color('#d29922'),
};

async function load(name) {
  const r = new Request(RAW + name + '.json?_=' + Date.now());
  r.timeoutInterval = 15;
  return await r.loadJSON();
}

const short = (s) => s.replace(/USDT$/, '').replace(/^1000/, '');
const money = (n, d = 0) => (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toFixed(d);
const col = (n) => (n > 0 ? C.green : n < 0 ? C.red : C.dim);

function stage(p) {
  if (p.filled && p.filled.t2) return 'T2 ✓';
  if (p.filled && p.filled.t1) return 'T1 ✓';
  return '';
}

function text(stack, s, size, color, weight) {
  const t = stack.addText(String(s));
  t.font = weight === 'bold' ? Font.boldSystemFont(size) : weight === 'mono' ? Font.boldMonospacedSystemFont(size) : Font.systemFont(size);
  t.textColor = color || C.text;
  t.lineLimit = 1;
  return t;
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
  const { account, positions, scores } = data;
  const pos = Object.values(positions || {});
  const upnl = pos.reduce((s, p) => s + (p.unrealisedPnl || 0), 0);
  const equity = account.exchangeEquity != null ? account.exchangeEquity : account.balance;
  const start = account.startingBalance || 0;

  // header
  const head = w.addStack(); head.centerAlignContent();
  text(head, 'TradeBot', small ? 13 : 15, C.text, 'bold');
  head.addSpacer();
  text(head, '$' + equity.toFixed(0), small ? 13 : 15, col(equity - start), 'bold');
  const sub = w.addStack();
  text(sub, 'open ' + money(upnl), 11, col(upnl), 'bold');
  sub.addSpacer();
  if (start) text(sub, ((equity - start) / start * 100 >= 0 ? '+' : '') + ((equity - start) / start * 100).toFixed(1) + '% vs start', 10, C.dim);
  w.addSpacer(6);

  // open positions
  const maxPos = small ? 2 : large ? 8 : 3;
  text(w, 'OPEN ' + pos.length + '/' + ((account.settings && account.settings.MAX_OPEN_POSITIONS) || 5), 9, C.dim, 'bold');
  if (!pos.length) text(w, 'no open positions', 11, C.dim);
  pos.sort((a, b) => (b.unrealisedPnl || 0) - (a.unrealisedPnl || 0)).slice(0, maxPos).forEach((p) => {
    const row = w.addStack(); row.centerAlignContent();
    text(row, (p.bias > 0 ? '▲ ' : '▼ ') + short(p.symbol), 12, p.bias > 0 ? C.green : C.red, 'bold');
    row.addSpacer(6);
    if (!small) text(row, stage(p) || (p.breakeven ? 'BE' : ''), 10, C.amber);
    row.addSpacer();
    text(row, money(p.unrealisedPnl || 0, 1), 12, col(p.unrealisedPnl || 0), 'mono');
  });
  if (pos.length > maxPos) text(w, '+' + (pos.length - maxPos) + ' more', 10, C.dim);
  w.addSpacer(6);

  // coins at +50 / -50 that aren't already open
  const traded = new Set((account.settings && account.settings.SYMBOLS) || Object.keys(scores));
  const open = new Set(pos.map((p) => p.symbol));
  const strong = Object.entries(scores)
    .filter(([sym, s]) => traded.has(sym) && !open.has(sym) && s && s.score != null && Math.abs(s.score) >= MIN_SCORE)
    .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score));
  text(w, 'SCORE ±' + MIN_SCORE + ' · NOT OPEN', 9, C.dim, 'bold');
  if (!strong.length) text(w, 'none right now', 11, C.dim);
  const maxStrong = small ? 3 : large ? 10 : 4;
  const per = small ? 1 : 2; // coins per line
  const shown = strong.slice(0, maxStrong);
  for (let i = 0; i < shown.length; i += per) {
    const row = w.addStack(); row.centerAlignContent();
    shown.slice(i, i + per).forEach(([sym, s], k) => {
      if (k) row.addSpacer(12);
      text(row, short(sym) + ' ', 11, C.text, 'bold');
      text(row, (s.score > 0 ? '+' : '') + s.score, 11, s.score > 0 ? C.green : C.red, 'mono');
    });
  }
  if (strong.length > maxStrong) text(w, '+' + (strong.length - maxStrong) + ' more', 10, C.dim);

  // BTC filter + age
  w.addSpacer();
  const foot = w.addStack(); foot.centerAlignContent();
  const btc = scores.BTCUSDT;
  if (btc && btc.score != null && !small) {
    text(foot, 'BTC filter ' + (btc.score > 0 ? '+' : '') + btc.score, 10, C.dim);
  }
  foot.addSpacer();
  const t = new Date();
  text(foot, t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 10, C.dim);
  return w;
}

let data = null;
try {
  const [account, positions, scores] = await Promise.all([load('account'), load('positions'), load('scores')]);
  data = { account, positions, scores };
} catch (e) { console.error(e); }

const widget = build(data);
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
