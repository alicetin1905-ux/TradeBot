// Phone alerts via ntfy (https://ntfy.sh): one push per trade event — entry,
// T1/T2 fill, exit. Subscribe to the topic in the ntfy app to receive them.
//
// Topic: NTFY_TOPIC from the environment / .env, else config.NOTIFY.NTFY_TOPIC;
// NTFY_TOPIC=off turns alerts off. The topic name is effectively the password
// (anyone who knows it can read and post), but everything it carries is also
// on the public dashboard. A failed push is logged and never stops a run.
'use strict';

const config = require('../config');

const LABEL = (symbol) => symbol.replace('USDT', '');

function px(x) {
  const a = Math.abs(x);
  const dp = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : 5;
  return (+x).toFixed(dp);
}
function money(x) { return `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`; }

// Turns run events into ntfy messages. Events that repeat or carry no news
// (holds, flats, info lines, the "P&L record pending" placeholder that is
// followed by the real exit) are left out.
function messagesFor(events, st) {
  const out = [];
  for (const ev of events) {
    const coin = LABEL(ev.symbol || '');
    if (ev.type === 'enter') {
      const dir = ev.bias === 1 ? 'LONG' : 'SHORT';
      out.push({
        title: `${coin} ${dir} opened`,
        message: `Entry ${px(ev.entry)} · SL ${px(ev.stop)}\nT1 ${px(ev.t1)} · T2 ${px(ev.t2)} · T3 ${px(ev.t3)}\nMargin $${ev.margin.toFixed(0)} · loss at stop $${ev.riskAmt.toFixed(0)} · score ${ev.score}`,
        tags: [ev.bias === 1 ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'],
      });
    } else if (ev.type === 'partial') {
      out.push({
        title: `${coin} ${ev.reason.split(',')[0]} ${money(ev.pnl)}`,
        message: `${ev.reason} @ ${px(ev.price)}`,
        tags: ['dart'],
      });
    } else if (ev.type === 'exit' && !/record pending/.test(ev.reason)) {
      out.push({
        title: `${coin} closed ${money(ev.pnl)}`,
        message: `${ev.reason}${ev.price ? ' @ ' + px(ev.price) : ''}`,
        tags: [ev.pnl >= 0 ? 'white_check_mark' : 'x'],
      });
    }
  }
  if (out.length && st) {
    const open = Object.keys(st.positions).length;
    const foot = `\nBalance $${st.account.balance.toFixed(2)} · ${open}/${config.PORTFOLIO.MAX_OPEN_POSITIONS} open`;
    for (const m of out) m.message += foot;
  }
  return out;
}

function topic() {
  const t = (process.env.NTFY_TOPIC || config.NOTIFY.NTFY_TOPIC || '').trim();
  return /^(off|none|false|0)?$/i.test(t) ? null : t;
}

async function send(events, st, opts) {
  return push(messagesFor(events, st), opts);
}

// Posts ready-made { title, message, tags } messages; returns how many went out.
async function push(messages, { fetchImpl = fetch, log = console.log } = {}) {
  const t = topic();
  if (!t) return 0;
  let sent = 0;
  for (const m of messages) {
    try {
      const res = await fetchImpl(config.NOTIFY.SERVER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: t, click: config.NOTIFY.CLICK_URL, ...m }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sent++;
    } catch (err) {
      log(`ntfy push failed (${m.title}): ${err.message}`);
    }
  }
  return sent;
}

module.exports = { send, push, messagesFor, topic };
