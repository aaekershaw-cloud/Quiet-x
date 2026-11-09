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

  if (!done.mirrorDefaults) {
    /* The user asked for this explicitly: every allowed account shows posts,
       replies and reposts unless they change it later. */
    const allowlist = Object.assign({}, settings.allowlist || {});
    for (const h of Object.keys(allowlist)) {
      allowlist[h] = Object.assign({}, allowlist[h], { replies: true, reposts: true });
    }
    patch.allowlist = allowlist;
    patch.defaultReplies = true;
    patch.defaultReposts = true;
    if (settings.mirrorFollowing === undefined) patch.mirrorFollowing = true;
    if (settings.showReplyContext === undefined) patch.showReplyContext = true;
    done.mirrorDefaults = true;
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

/* Runs in the page. Waits for the list to actually render before scrolling, and
   scrolls whichever element is really scrollable (the window on a normal layout,
   a container on others), rather than assuming the window. Returns diagnostics so
   an empty result can explain itself. */
function scrapeFollowing() {
  return new Promise(resolve => {
    const found = new Map();
    const started = Date.now();
    const diag = { url: location.href, waitedMs: 0, scrolls: 0, cellsSeen: 0, scroller: 'window', loggedOut: false, emptyState: false };
    let idleRounds = 0;

    const cells = () => document.querySelectorAll('[data-testid="UserCell"]');

    function harvest() {
      const before = found.size;
      for (const cell of cells()) {
        let handle = null;
        for (const a of cell.querySelectorAll('a[href^="/"]')) {
          const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
          if (m) { handle = m[1].toLowerCase(); break; }
        }
        if (!handle || found.has(handle)) continue;
        let name = '';
        const nm = cell.querySelector('span');
        if (nm) name = (nm.textContent || '').trim().slice(0, 60);
        found.set(handle, name);
      }
      diag.cellsSeen = Math.max(diag.cellsSeen, cells().length);
      return found.size - before;
    }

    /* what actually scrolls on this page */
    function pickScroller() {
      const doc = document.scrollingElement || document.documentElement;
      if (doc && doc.scrollHeight > doc.clientHeight + 50) { diag.scroller = 'window'; return null; }
      let el = cells()[0];
      while (el && el !== document.body) {
        const st = getComputedStyle(el);
        if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 50) {
          diag.scroller = 'container';
          return el;
        }
        el = el.parentElement;
      }
      diag.scroller = 'window(fallback)';
      return null;
    }

    function scrollOn(el) {
      const amount = Math.round((el ? el.clientHeight : window.innerHeight) * 0.85);
      if (el) el.scrollTop += amount; else window.scrollBy(0, amount);
      diag.scrolls++;
    }

    function atBottom(el) {
      if (el) return el.scrollTop + el.clientHeight >= el.scrollHeight - 200;
      return window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;
    }

    function finish() {
      harvest();
      resolve({ handles: Array.from(found, ([handle, name]) => ({ handle, name })), diag });
    }

    /* wait for the list to render before touching the scroll position */
    const wait = setInterval(() => {
      diag.waitedMs = Date.now() - started;
      diag.loggedOut = !!document.querySelector('[data-testid="loginButton"], a[href="/i/flow/login"]');
      const empty = document.querySelector('[data-testid="emptyState"]');
      if (empty) diag.emptyState = true;

      if (cells().length) {
        clearInterval(wait);
        const scroller = pickScroller();
        const step = setInterval(() => {
          const added = harvest();
          idleRounds = added > 0 ? 0 : idleRounds + 1;
          const end = atBottom(scroller);
          scrollOn(scroller);
          const timeUp = Date.now() - started > 150000;
          if (timeUp || (idleRounds >= 10 && end) || idleRounds >= 25) {
            clearInterval(step);
            finish();
          }
        }, 900);
        return;
      }
      if (diag.loggedOut || diag.emptyState || diag.waitedMs > 25000) {
        clearInterval(wait);
        finish();
      }
    }, 700);
  });
}

/* Runs in the page. Reports what it can see rather than just a handle, so a
   failure can say WHY. Deliberately does not rely on the left nav: X collapses it
   at narrow window widths and moves the profile link into a "More" menu, which is
   why this worked on a wide window and not on a laptop one. */
function probeHandle() {
  const out = { handle: null, loggedOut: false, url: location.href, tried: [] };
  const grab = (el, label) => {
    if (out.handle || !el) return;
    const href = el.getAttribute && el.getAttribute('href');
    if (href) {
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m) { out.handle = m[1].toLowerCase(); out.tried.push(label + ':href'); return; }
    }
    const t = (el.textContent || '').match(/@([A-Za-z0-9_]{1,15})/);
    if (t) { out.handle = t[1].toLowerCase(); out.tried.push(label + ':text'); }
  };

  /* 1. the nav, when it is there */
  grab(document.querySelector('[data-testid="AppTabBar_Profile_Link"]'), 'navProfile');
  grab(document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'), 'accountSwitcher');

  /* 2. avatar containers carry the handle in their own testid:
        data-testid="UserAvatar-Container-<handle>" */
  if (!out.handle) {
    const own = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] [data-testid^="UserAvatar-Container-"]')
      || document.querySelector('[data-testid="tweetTextarea_0"]') && document
        .querySelector('[data-testid^="UserAvatar-Container-"]');
    const id = own && own.getAttribute('data-testid');
    const m = id && id.match(/^UserAvatar-Container-([A-Za-z0-9_]{1,15})$/);
    if (m && m[1] !== 'unknown') { out.handle = m[1].toLowerCase(); out.tried.push('avatarTestid'); }
  }

  /* 3. the composer's own avatar links to your profile */
  if (!out.handle) {
    const composer = document.querySelector('[data-testid="tweetTextarea_0"]');
    const box = composer && composer.closest('div[role="group"], form, section, div');
    if (box) grab(box.querySelector('a[href^="/"][role="link"]'), 'composer');
  }

  /* 4. the account menu / profile button by aria-label */
  if (!out.handle) {
    grab(document.querySelector('a[aria-label="Profile"], a[href^="/"][aria-label*="Profile"]'), 'ariaProfile');
  }

  out.loggedOut = !!document.querySelector('[data-testid="loginButton"], a[href="/i/flow/login"], a[href="/login"]')
    || /\/i\/flow\/login|^https:\/\/x\.com\/?$/.test(location.href) && !document.querySelector('[data-testid="primaryColumn"]');
  return out;
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
  const s = await Q.getSettings();
  const stored = await chrome.storage.local.get('ownHandle');
  let handle = (s.myHandle && Q.normHandle(s.myHandle)) || stored.ownHandle || null;
  let probe = null;

  /* Tell the content script an import is running, so the door pause and the daily
     lockout do not sit on top of the tab we are driving. */
  await chrome.storage.local.set({ qxImporting: true });
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: 'https://x.com/home', active: true });
    await waitForTab(tab.id);

    if (!handle) {
      for (let i = 0; i < 8 && !handle; i++) {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probeHandle });
        probe = (r && r.result) || null;
        if (probe && probe.handle) handle = probe.handle;
        else if (probe && probe.loggedOut) break;
        if (!handle) await new Promise(res => setTimeout(res, 1500));
      }
    }

    if (!handle) {
      if (probe && probe.loggedOut) {
        return { error: 'This Chrome profile is not signed in to X. Sign in, then sync again.' };
      }
      return {
        error: 'Could not read your handle from the page (X hides the profile link when the window is narrow). '
          + 'Type your handle into "Your X handle" in settings and sync again.',
        needsHandle: true,
        probe
      };
    }
    await chrome.storage.local.set({ ownHandle: handle });

    await chrome.tabs.update(tab.id, { url: 'https://x.com/' + handle + '/following' });
    await waitForTab(tab.id);

    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeFollowing });
    const result = (res && res.result) || {};
    const list = result.handles || [];
    const diag = result.diag || {};

    if (!list.length) {
      if (diag.loggedOut) return { error: 'X signed you out while loading your following list. Sign in and try again.', diag };
      if (diag.emptyState) {
        return { error: 'X showed an empty following list for @' + handle + '. If that handle is wrong, correct it in settings.', diag };
      }
      return {
        error: 'Loaded @' + handle + "'s following list but found no accounts on it"
          + (diag.cellsSeen ? '' : ' (the list never rendered — X may be rate-limiting this profile).')
          + ' Try again in a few minutes.',
        diag
      };
    }

    const allowlist = Object.assign({}, s.allowlist);
    const scraped = new Set(list.map(x => x.handle));
    let added = 0;
    for (const { handle: h, name } of list) {
      if (h === handle) continue;
      if (allowlist[h]) { if (name && !allowlist[h].name) allowlist[h].name = name; continue; }
      allowlist[h] = {
        name: name || '', added: Date.now(), via: 'follow',
        replies: s.defaultReplies, reposts: s.defaultReposts
      };
      added++;
    }

    /* Mirror mode: accounts you no longer follow come off the list. A partial scrape
       (rate limit, scroll cut short) must never wipe the list, so prune only when the
       scrape found at least half of what we already had. */
    let removed = 0, pruneSkipped = false;
    if (s.mirrorFollowing) {
      const mirrored = Object.keys(allowlist).filter(h => !allowlist[h].manual);
      if (scraped.size >= Math.floor(mirrored.length * 0.5) && scraped.size > 0) {
        for (const h of mirrored) {
          if (!scraped.has(h) && h !== handle) { delete allowlist[h]; removed++; }
        }
      } else {
        pruneSkipped = true;
      }
    }

    await Q.setSettings({ allowlist });
    await chrome.storage.local.set({ lastMirrorSync: Date.now() });
    return {
      added, removed, pruneSkipped, handle,
      total: Object.keys(allowlist).length, scanned: list.length, diag
    };
  } finally {
    await chrome.storage.local.set({ qxImporting: false });
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
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
  /* where is the search box, and if it is not visible, what is hiding it */
  const SEARCH_SEL = '[data-testid="SearchBox_Search_Input"], [data-testid="searchIconButton"], '
    + '[role="search"], form[action="/search"], [aria-label="Search and explore"]';
  const boxes = document.querySelectorAll(SEARCH_SEL);
  out.search = { found: boxes.length, visible: false, hiddenBy: null, chain: [] };
  if (boxes.length) {
    const box = boxes[0];
    const r = box.getBoundingClientRect();
    out.search.visible = r.width > 0 && r.height > 0;
    let n = box, hops = 0;
    while (n && n !== document.documentElement && hops < 25) {
      const cs = getComputedStyle(n);
      const qx = n.getAttributeNames().filter(a => a.startsWith('data-qx-'));
      const testid = n.getAttribute('data-testid');
      if (qx.length || testid) {
        out.search.chain.push({
          testid: testid || null,
          qx: qx.map(a => a + '=' + n.getAttribute(a)),
          display: cs.display
        });
      }
      if (!out.search.hiddenBy && (cs.display === 'none' || cs.visibility === 'hidden')) {
        out.search.hiddenBy = {
          testid: testid || null, tag: n.tagName.toLowerCase(),
          display: cs.display, visibility: cs.visibility,
          qx: qx.map(a => a + '=' + n.getAttribute(a)),
          className: (n.className || '').toString().slice(0, 80)
        };
      }
      n = n.parentElement; hops++;
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
