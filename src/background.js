/* Quiet X — service worker: stats, session clock, following-list import. */
importScripts('defaults.js');
const Q = globalThis.QX;

chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.local.get(['settings', 'migrations']);
  if (!cur.settings) {
    await chrome.storage.local.set({ settings: Q.DEFAULTS });
  } else {
    await migrate(cur.settings, cur.migrations || {});
  }
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

/* Changing a default does nothing for an existing install, whose settings were
   written at install time. Each migration runs once and never re-applies, so a
   deliberate choice by the user is not overwritten on a later update. */
async function migrate(settings, done) {
  const patch = {};

  if (!done.threadsOpenByDefault) {
    /* Opening a post is a deliberate act: show the whole conversation. */
    if (settings.filterStatusPages === true) patch.filterStatusPages = false;
    done.threadsOpenByDefault = true;
  }
  if (!done.adsAndTopics) {
    for (const [k, v] of Object.entries({
      hidePromoted: true, hideTopicTabs: true, hideTopicModules: true, hideTimelineTabs: false
    })) {
      if (settings[k] === undefined) patch[k] = v;
    }
    done.adsAndTopics = true;
  }

  if (Object.keys(patch).length) await Q.setSettings(patch);
  await chrome.storage.local.set({ migrations: done });
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    if (msg && msg.type === 'qx-tick') {
      const row = await Q.bumpStats({
        seconds: msg.seconds || 0,
        shown: msg.shown || 0,
        hidden: msg.hidden || 0
      });
      respond(row);
      return;
    }
    if (msg && msg.type === 'qx-open') {
      await Q.bumpStats({ opens: 1 });
      respond({ ok: true });
      return;
    }
    if (msg && msg.type === 'qx-diag') {
      try { respond(await runDiagnostics()); } catch (e) { respond({ error: String((e && e.message) || e) }); }
      return;
    }
    if (msg && msg.type === 'qx-import') {
      try {
        const res = await importFollowing();
        respond(res);
      } catch (e) {
        respond({ error: String((e && e.message) || e) });
      }
      return;
    }
    respond({ ok: false });
  })();
  return true; /* async */
});

/* ---------------- following-list import ---------------- */

function scrapeFollowing() {
  return new Promise(resolve => {
    const found = new Map();
    const started = Date.now();
    let idleRounds = 0;

    function harvest() {
      const before = found.size;
      for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
        let handle = null;
        for (const a of cell.querySelectorAll('a[href^="/"]')) {
          const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
          if (m) { handle = m[1].toLowerCase(); break; }
        }
        if (!handle || found.has(handle)) continue;
        let name = '';
        const nm = cell.querySelector('[data-testid="UserCell"] span, span');
        if (nm) name = (nm.textContent || '').trim().slice(0, 60);
        found.set(handle, name);
      }
      return found.size - before;
    }

    const step = setInterval(() => {
      const added = harvest();
      idleRounds = added > 0 ? 0 : idleRounds + 1;
      const atEnd = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 200);
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      const timeUp = Date.now() - started > 150000;
      if (timeUp || (idleRounds >= 10 && atEnd) || idleRounds >= 20) {
        clearInterval(step);
        harvest();
        resolve(Array.from(found, ([handle, name]) => ({ handle, name })));
      }
    }, 900);
  });
}

function probeHandle() {
  const el = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')
    || document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  if (!el) return null;
  const href = el.getAttribute('href');
  if (href) { const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/); if (m) return m[1].toLowerCase(); }
  const m2 = (el.textContent || '').match(/@([A-Za-z0-9_]{1,15})/);
  return m2 ? m2[1].toLowerCase() : null;
}

function waitForTab(tabId) {
  return new Promise(resolve => {
    const done = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        setTimeout(resolve, 2500);
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 30000);
  });
}

async function importFollowing() {
  const store = await chrome.storage.local.get('ownHandle');
  let handle = store.ownHandle || null;

  const tab = await chrome.tabs.create({ url: 'https://x.com/home', active: true });
  await waitForTab(tab.id);

  if (!handle) {
    for (let i = 0; i < 10 && !handle; i++) {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probeHandle });
      handle = r && r.result;
      if (!handle) await new Promise(r2 => setTimeout(r2, 1500));
    }
  }
  if (!handle) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    return { error: 'Could not work out your handle — make sure you are signed in to X, then try again.' };
  }
  await chrome.storage.local.set({ ownHandle: handle });

  await chrome.tabs.update(tab.id, { url: 'https://x.com/' + handle + '/following' });
  await waitForTab(tab.id);

  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeFollowing });
  const list = (res && res.result) || [];

  const s = await Q.getSettings();
  const allowlist = Object.assign({}, s.allowlist);
  let added = 0;
  for (const { handle: h, name } of list) {
    if (h === handle) continue;
    if (allowlist[h]) { if (name && !allowlist[h].name) allowlist[h].name = name; continue; }
    allowlist[h] = { name: name || '', added: Date.now(), replies: s.defaultReplies, reposts: s.defaultReposts };
    added++;
  }
  await Q.setSettings({ allowlist });
  await chrome.tabs.remove(tab.id).catch(() => {});
  return { added, total: Object.keys(allowlist).length, scanned: list.length, handle };
}

/* ---------------- diagnostics ---------------- */

function probePage() {
  const out = {
    url: location.href,
    htmlFlags: {},
    articles: 0,
    states: {},
    visibleAuthors: [],
    leaking: [],
    unresolved: 0,
    cellToArticleDepth: []
  };
  for (const a of document.documentElement.getAttributeNames()) {
    if (a.startsWith('data-qx-')) out.htmlFlags[a] = document.documentElement.getAttribute(a);
  }
  const arts = document.querySelectorAll('article[data-testid="tweet"]');
  out.articles = arts.length;
  for (const art of arts) {
    const cell = art.closest('div[data-testid="cellInnerDiv"]');
    const target = cell || art;
    const state = target.getAttribute('data-qx-state') || 'pending';
    out.states[state] = (out.states[state] || 0) + 1;

    if (cell) {
      let d = 0, n = art;
      while (n && n !== cell && d < 12) { n = n.parentElement; d++; }
      out.cellToArticleDepth.push(d);
    }

    const nameEl = art.querySelector('[data-testid="User-Name"]');
    let handle = null;
    if (nameEl) {
      for (const a of nameEl.querySelectorAll('a[href^="/"]')) {
        const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
        if (m) { handle = m[1].toLowerCase(); break; }
      }
    }
    if (!handle) out.unresolved++;

    const rect = art.getBoundingClientRect();
    const painted = rect.height > 0 && getComputedStyle(art).display !== 'none'
      && getComputedStyle(target).visibility !== 'hidden';
    if (painted) {
      if (handle && out.visibleAuthors.length < 40) out.visibleAuthors.push(handle);
      if (state !== 'allow' && out.leaking.length < 20) {
        out.leaking.push({ handle: handle || '?', state, display: getComputedStyle(art).display });
      }
    }
  }
  const dep = out.cellToArticleDepth;
  out.cellToArticleDepth = dep.length
    ? { min: Math.min(...dep), max: Math.max(...dep), sample: dep.slice(0, 8) }
    : null;
  return out;
}

async function runDiagnostics() {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  if (!tabs.length) return { error: 'Open an X timeline tab first, then run this again.' };
  const tab = tabs.find(t => /\/home/.test(t.url)) || tabs[0];
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probePage });
  const probe = (res && res.result) || {};
  const s = await Q.getSettings();
  const allow = s.allowlist || {};
  probe.allowlistSize = Object.keys(allow).length;
  const own = (await chrome.storage.local.get('ownHandle')).ownHandle;
  probe.visibleNotOnList = (probe.visibleAuthors || []).filter(h => !allow[h] && h !== own);
  probe.settingsSummary = {
    enabled: s.enabled, scope: s.scope, showPlaceholders: s.showPlaceholders,
    hideForYou: s.hideForYou, forceFollowing: s.forceFollowing
  };
  return probe;
}
