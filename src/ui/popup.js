'use strict';
const Q = globalThis.QX;
const $ = s => document.querySelector(s);
let S = null, handle = null;

function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 1800);
}

const RESERVED = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings',
  'search', 'compose', 'bookmarks', 'lists', 'communities', 'jobs', 'topics', 'hashtag']);

function bind() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!S[key]; else el.value = S[key];
    el.oninput = async () => {
      const v = el.type === 'checkbox' ? el.checked : el.value;
      S = await Q.setSettings({ [key]: v });
      render();
    };
  }
}

function renderAcct() {
  if (!handle) { $('#acctPanel').hidden = true; return; }
  $('#acctPanel').hidden = false;
  const on = !!S.allowlist[handle];
  $('#acctHandle').textContent = '@' + handle;
  $('#acctState').textContent = on
    ? 'allowed' + (S.allowlist[handle].replies ? ' · replies' : '') + (S.allowlist[handle].reposts ? ' · reposts' : '')
    : 'not on your allowlist';
  const btn = $('#acctBtn');
  btn.textContent = on ? 'Remove' : 'Allow';
  btn.onclick = async () => {
    if (S.allowlist[handle]) delete S.allowlist[handle];
    else S.allowlist[handle] = { name: '', added: Date.now(), manual: true, replies: S.defaultReplies, reposts: S.defaultReposts };
    S = await Q.setSettings({ allowlist: S.allowlist });
    renderAcct();
  };
}

async function render() {
  const stats = await Q.getStats();
  const today = stats[Q.DAY()] || { seconds: 0, shown: 0, hidden: 0 };
  const st = await chrome.storage.local.get('bypassUntil');
  const bypass = (st.bypassUntil || 0) > Date.now();

  $('#status').textContent = !S.enabled
    ? 'Off — X behaves normally.'
    : bypass ? 'Overridden — filtering resumes shortly.'
      : Object.keys(S.allowlist).length + ' accounts allowed through.';

  const stat = $('#stat'); stat.textContent = '';
  const add = (big, small) => {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = big;
    const s = document.createElement('span'); s.textContent = small;
    d.append(b, s); stat.appendChild(d);
  };
  add(Math.round(today.seconds / 60) + 'm', 'today' + (S.timeBudgetEnabled ? ' / ' + S.timeBudget + 'm' : ''));
  add(String(today.shown), 'shown');
  add(String(today.hidden), 'hidden');
  renderAcct();
}

async function main() {
  S = await Q.getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && /^https:\/\/(x|twitter)\.com\//.test(tab.url)) {
    const seg = new URL(tab.url).pathname.split('/').filter(Boolean);
    if (seg.length >= 1 && /^[A-Za-z0-9_]{1,15}$/.test(seg[0]) && !RESERVED.has(seg[0].toLowerCase())) {
      handle = seg[0].toLowerCase();
    }
  }
  bind();
  render();

  $('#settings').onclick = () => chrome.runtime.openOptionsPage();
  $('#override').onclick = async () => {
    await chrome.storage.local.set({ bypassUntil: Date.now() + (S.bypassMinutes || 5) * 60000 });
    toast('Filtering paused for ' + (S.bypassMinutes || 5) + ' min');
    render();
  };
}
main();
