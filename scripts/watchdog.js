#!/usr/bin/env node
// Bot-down alarm, run by .github/workflows/watchdog.yml (not on the Mac, so
// it still works when the Mac is off). Reads when the bot last completed an
// hourly run (state/demo/account.json → updatedAt) and pushes an ntfy alert
// once it's older than NOTIFY.WATCHDOG_MAX_AGE_MIN, again every
// WATCHDOG_REPEAT_H while it stays down, and an all-clear when it's back.
// Remembers what it already sent in state/watchdog.json.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const notify = require('../src/notify');

const ROOT = path.join(__dirname, '..');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (e) { return d; } };

// Pure decision so it can be tested: returns { message|null, next watchdog state }.
function check({ lastRun, wd, now }) {
  const cfg = config.NOTIFY;
  const ageMin = (now - lastRun) / 60000;
  const down = ageMin > cfg.WATCHDOG_MAX_AGE_MIN;
  const hours = (ageMin / 60).toFixed(1);
  if (down) {
    const due = !wd.down || now - (wd.alertedAt || 0) >= cfg.WATCHDOG_REPEAT_H * 3600000;
    if (!due) return { message: null, wd };
    return {
      message: {
        title: 'TradeBot is not running',
        message: `No hourly run for ${hours}h (last ${new Date(lastRun).toISOString().slice(0, 16).replace('T', ' ')} UTC). ` +
          'Check that the Mac is on and awake. Open trades keep their stops and targets on Bybit.',
        tags: ['warning'], priority: 4,
      },
      wd: { down: true, alertedAt: now, since: wd.since || lastRun },
    };
  }
  if (wd.down) {
    return {
      message: { title: 'TradeBot is running again', message: `Last hourly run ${Math.round(ageMin)} min ago.`, tags: ['white_check_mark'] },
      wd: { down: false },
    };
  }
  return { message: null, wd };
}

async function main() {
  const account = read('state/demo/account.json', null);
  if (!account || !account.updatedAt) { console.log('no state/demo/account.json yet — nothing to watch'); return; }
  const wd = read('state/watchdog.json', { down: false });
  const res = check({ lastRun: account.updatedAt, wd, now: Date.now() });
  console.log(`last run ${new Date(account.updatedAt).toISOString()} · ${res.wd.down ? 'DOWN' : 'ok'}${res.message ? ' · sending: ' + res.message.title : ''}`);
  if (res.message) await notify.push([res.message]);
  if (JSON.stringify(res.wd) !== JSON.stringify(wd)) {
    fs.writeFileSync(path.join(ROOT, 'state/watchdog.json'), JSON.stringify(res.wd, null, 2) + '\n');
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { check };
