'use strict';
const Q = globalThis.QX;
let S = null;

const $ = sel => document.querySelector(sel);
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 2200);
}

/* ---------- generic setting binding ---------- */
function bind() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    const key = el.dataset.setting;
    const val = S[key];
    if (el.type === 'checkbox') el.checked = !!val;
    else if (el.tagName === 'TEXTAREA') el.value = Array.isArray(val) ? val.join('\n') : (val || '');
    else el.value = val;

    el.oninput = async () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'number') v = Number(el.value);
      else if (el.tagName === 'TEXTAREA') v = el.value.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
      else v = el.value;
      S = await Q.setSettings({ [key]: v });
    };
  }
}

/* ---------- allowlist ---------- */
function renderList() {
  const q = ($('#search').value || '').toLowerCase().replace(/^@/, '');
  const entries = Object.entries(S.allowlist)
    .filter(([h, v]) => !q || h.includes(q) || (v.name || '').toLowerCase().includes(q))
    .sort((a, b) => a[0].localeCompare(b[0]));
  $('#count').textContent = Object.keys(S.allowlist).length + ' accounts';

  const tbody = $('#list');
  tbody.textContent = '';
  for (const [handle, v] of entries) {
    const tr = document.createElement('tr');

    const td1 = document.createElement('td');
    td1.className = 'h';
    const a = document.createElement('a');
    a.href = 'https://x.com/' + handle;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = '@' + handle;
    td1.appendChild(a);

    const td2 = document.createElement('td');
    td2.className = 'n';
    td2.textContent = v.name || '';

    const mk = (field) => {
      const td = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!v[field];
      cb.onchange = async () => {
        S.allowlist[handle][field] = cb.checked;
        S = await Q.setSettings({ allowlist: S.allowlist });
      };
      td.appendChild(cb);
      return td;
    };

    const td5 = document.createElement('td');
    const rm = document.createElement('button');
    rm.className = 'btn ghost';
    rm.style.padding = '2px 9px';
    rm.textContent = '✕';
    rm.onclick = async () => {
      delete S.allowlist[handle];
      S = await Q.setSettings({ allowlist: S.allowlist });
      renderList();
    };
    td5.appendChild(rm);

    tr.append(td1, td2, mk('replies'), mk('reposts'), td5);
    tbody.appendChild(tr);
  }
}

async function addHandles(text) {
  const parts = String(text).split(/[\s,]+/).map(Q.normHandle).filter(Boolean);
  let n = 0;
  for (const h of parts) {
    if (S.allowlist[h]) continue;
    S.allowlist[h] = { name: '', added: Date.now(), manual: true, replies: S.defaultReplies, reposts: S.defaultReposts };
    n++;
  }
  S = await Q.setSettings({ allowlist: S.allowlist });
  renderList();
  toast(n ? 'Added ' + n + ' account' + (n > 1 ? 's' : '') : 'Already on the list');
}

/* ---------- stats ---------- */
async function renderStats() {
  const stats = await Q.getStats();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push([d, stats[d] || { seconds: 0, shown: 0, hidden: 0, opens: 0 }]);
  }
  const max = Math.max(60, ...days.map(([, r]) => r.seconds));
  const bars = $('#bars'); bars.textContent = '';
  const labels = $('#barlabels'); labels.textContent = '';
  const today = Q.DAY();
  for (const [d, r] of days) {
    const b = document.createElement('div');
    b.className = 'bar' + (d === today ? ' today' : '');
    b.style.height = Math.max(2, Math.round((r.seconds / max) * 100)) + '%';
    b.title = d + ' — ' + Math.round(r.seconds / 60) + ' min, ' + r.shown + ' posts shown, ' + r.hidden + ' hidden';
    bars.appendChild(b);
    const l = document.createElement('span');
    l.textContent = d.slice(8);
    labels.appendChild(l);
  }
  const t = days[days.length - 1][1];
  const week = days.slice(-7).reduce((a, [, r]) => a + r.seconds, 0);
  const hiddenAll = days.reduce((a, [, r]) => a + r.hidden, 0);
  const stat = $('#stat'); stat.textContent = '';
  const add = (big, small) => {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = big;
    const s = document.createElement('span'); s.textContent = small;
    d.append(b, s); stat.appendChild(d);
  };
  add(Math.round(t.seconds / 60) + ' min', 'on X today');
  add(Math.round(week / 60) + ' min', 'last 7 days');
  add(String(t.shown), 'posts shown today');
  add(String(hiddenAll), 'posts hidden, 14 days');
}

/* ---------- wiring ---------- */
async function renderLastSync() {
  const { lastMirrorSync } = await chrome.storage.local.get('lastMirrorSync');
  const el = $('#lastSync');
  if (!el) return;
  if (!lastMirrorSync) { el.textContent = 'never synced'; return; }
  const mins = Math.round((Date.now() - lastMirrorSync) / 60000);
  el.textContent = mins < 60 ? 'synced ' + mins + 'm ago'
    : mins < 1440 ? 'synced ' + Math.round(mins / 60) + 'h ago'
      : 'synced ' + Math.round(mins / 1440) + 'd ago';
}

async function main() {
  S = await Q.getSettings();
  bind();
  renderList();
  renderStats();
  renderLastSync();

  $('#search').oninput = renderList;
  $('#addBtn').onclick = () => { addHandles($('#add').value); $('#add').value = ''; };
  $('#add').onkeydown = e => { if (e.key === 'Enter') $('#addBtn').click(); };

  $('#repliesAll').onclick = async () => {
    for (const h of Object.keys(S.allowlist)) S.allowlist[h].replies = true;
    S = await Q.setSettings({ allowlist: S.allowlist }); renderList(); toast('Replies on for everyone');
  };
  $('#repliesNone').onclick = async () => {
    for (const h of Object.keys(S.allowlist)) S.allowlist[h].replies = false;
    S = await Q.setSettings({ allowlist: S.allowlist }); renderList(); toast('Replies off for everyone');
  };
  $('#clear').onclick = async () => {
    if (!confirm('Remove every account from the allowlist? Your timeline will be empty.')) return;
    S = await Q.setSettings({ allowlist: {} }); renderList();
  };

  $('#import').onclick = async () => {
    const btn = $('#import');
    btn.disabled = true; btn.textContent = 'Syncing… leave the tab alone';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'qx-import' });
      if (!res || res.error) toast(res && res.error ? res.error : 'Import failed');
      else {
        S = await Q.getSettings();
        renderList();
        const bits = [res.added + ' added'];
        if (res.removed) bits.push(res.removed + ' removed');
        bits.push(res.scanned + ' scanned');
        toast(bits.join(', '));
        if (res.pruneSkipped) {
          toast('Scrape looked incomplete, so nothing was removed — try again when X is not rate-limiting.');
        }
        renderLastSync();
      }
    } catch (e) {
      toast('Import failed: ' + e.message);
    }
    btn.disabled = false; btn.textContent = 'Sync with my following list';
  };

  $('#export').onclick = async () => {
    const data = await chrome.storage.local.get(null);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'quiet-x-settings.json';
    a.click();
  };
  $('#importFile').onclick = () => $('#file').click();
  $('#file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (obj.settings) await chrome.storage.local.set({ settings: Object.assign({}, Q.DEFAULTS, obj.settings) });
      if (obj.stats) await chrome.storage.local.set({ stats: obj.stats });
      S = await Q.getSettings();
      bind(); renderList(); renderStats();
      toast('Settings restored');
    } catch (err) { toast('That file did not parse'); }
  };
  $('#diag').onclick = async () => {
    const btn = $('#diag');
    btn.disabled = true; btn.textContent = 'Checking…';
    const res = await chrome.runtime.sendMessage({ type: 'qx-diag' });
    const out = $('#diagOut');
    out.hidden = false; $('#copyDiag').hidden = false;
    if (res && res.error) {
      out.value = res.error;
    } else {
      const lines = [
        'url: ' + res.url,
        'posts on screen: ' + res.articles,
        'states: ' + JSON.stringify(res.states),
        'html flags: ' + JSON.stringify(res.htmlFlags),
        'settings: ' + JSON.stringify(res.settingsSummary),
        'allowlist size: ' + res.allowlistSize,
        'authors unreadable: ' + res.unresolved,
        'cell→article depth: ' + JSON.stringify(res.cellToArticleDepth),
        '',
        'visible authors NOT on your list (these are the leaks):',
        (res.visibleNotOnList && res.visibleNotOnList.length ? res.visibleNotOnList.join(', ') : 'none'),
        '',
        'posts painted despite a hide/stub state (CSS failing):',
        JSON.stringify(res.leaking, null, 1)
      ];
      out.value = lines.join('\n');
    }
    btn.disabled = false; btn.textContent = 'Check the open timeline';
  };
  $('#copyDiag').onclick = () => {
    navigator.clipboard.writeText($('#diagOut').value).then(() => toast('Report copied'));
  };

  $('#reset').onclick = async () => {
    if (!confirm('Reset all settings, allowlist and stats?')) return;
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ settings: Q.DEFAULTS });
    S = await Q.getSettings();
    bind(); renderList(); renderStats();
    toast('Back to defaults');
  };
}
main();
