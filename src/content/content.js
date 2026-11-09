/* Quiet X — timeline filtering engine. Runs at document_start. */
(function () {
  'use strict';
  const Q = globalThis.QX;

  /* Default-deny from the very first paint; cleared in applyFlags() if the
     user has filtering off. Prevents a flash of unapproved posts. */
  try { document.documentElement.setAttribute('data-qx-filter', '1'); } catch (e) {}

  let S = null;
  let bypassUntil = 0;
  let ownHandle = null;
  let shownThisSession = 0;
  let stopped = false;
  let gatePassed = false;
  let lockedOut = false;
  let importing = false;   /* a sync is driving this tab: no gate, no lockout */

  const RESERVED = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings',
    'search', 'compose', 'bookmarks', 'lists', 'communities', 'jobs', 'topics', 'hashtag',
    'login', 'logout', 'signup', 'tos', 'privacy', 'about', 'intent', 'share', 'account']);

  const REPLY_RE = /^\s*(replying to|antwort(?:en)? an|en réponse à|respondiendo a|respondendo a|in risposta a|返信先|回覆|回复|답글)/i;
  const REPOST_RE = /(repost|retweet|reposteó|hat repostet|a reposté|リポスト|转推|轉推)/i;

  /* ---------------- route ---------------- */
  function route() {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    const seg = p.split('/').filter(Boolean);
    return {
      path: p,
      isHome: p === '/home' || p === '/',
      isStatus: /\/status\/\d+/.test(p),
      isProfile: seg.length === 1 && !RESERVED.has(seg[0].toLowerCase()),
      isSearch: p === '/search' || p === '/explore' || p.startsWith('/explore/'),
      isNotifications: p.startsWith('/notifications')
    };
  }

  function bypassActive() { return Date.now() < bypassUntil; }

  function filterActive() {
    if (!S || !S.enabled || bypassActive()) return false;
    const r = route();
    if (r.isProfile) return false;              // you went there on purpose
    if (r.isHome) return true;
    /* You clicked this post on purpose, so the conversation under it is yours to read.
       Independent of scope: opening a post means opening its replies. */
    if (r.isStatus) return S.filterStatusPages;
    /* Searching is deliberate, like opening a profile: show what you searched for.
       Independent of scope, so this does not depend on an unrelated setting. */
    if (r.isSearch) return S.filterSearch;
    if (S.scope === 'everywhere') return !r.isProfile;
    return false;
  }

  /* ---------------- <html> attribute flags ---------------- */
  function flag(name, value) {
    const el = document.documentElement;
    if (value === false || value === null || value === undefined || value === '' || value === 'off') {
      el.removeAttribute('data-qx-' + name);
    } else {
      el.setAttribute('data-qx-' + name, value === true ? '1' : String(value));
    }
  }

  function applyFlags() {
    if (!S) return;
    const on = S.enabled && !bypassActive();
    const r = route();
    flag('filter', filterActive());
    flag('home', on && r.isHome);
    flag('media', on ? S.mediaMode : 'off');
    flag('avatars', on && S.hideAvatars);
    flag('metrics', on && S.hideMetrics);
    flag('verified', on && S.hideVerifiedBadges);
    flag('badges', on && S.hideNotificationBadges);
    flag('sidebar', on && S.hideSidebar);
    flag('wtf', on && S.hideWhoToFollow);
    flag('premium', on && S.hidePremiumUpsell);
    flag('spaces', on && S.hideLiveSpaces);
    flag('explore', on && S.hideExploreNav);
    flag('grok', on && S.hideGrokNav);
    flag('dm', on && S.hideMessagesDrawer);
    flag('ads', on && S.hidePromoted);
    flag('topics', on && (S.hideTopicTabs || S.hideTopicModules));
    flag('tabbar', on && S.hideTimelineTabs);
    flag('gray', on && S.grayscale);
    flag('minimal', on && S.minimalMode);
    flag('stop', on && stopped && r.isHome);
  }

  /* ---------------- post inspection ---------------- */
  function handleFromLinks(scope) {
    if (!scope) return null;
    for (const a of scope.querySelectorAll('a[href^="/"]')) {
      const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m && !RESERVED.has(m[1].toLowerCase())) return m[1].toLowerCase();
    }
    return null;
  }

  /* Only ever read the author from the post header. Scanning the whole article
     would match an @mention in the body and wave a stranger's post through. */
  function authorHandle(article) {
    const nameEl = article.querySelector('[data-testid="User-Name"]');
    let h = handleFromLinks(nameEl);
    if (h) return h;
    h = handleFromLinks(article.querySelector('[data-testid="Tweet-User-Avatar"]'));
    if (h) return h;
    if (nameEl) {
      const t = (nameEl.textContent || '').match(/@([A-Za-z0-9_]{1,15})/);
      if (t) return t[1].toLowerCase();
    }
    return null;   /* unknown author: treated as "hide", never as "allow" */
  }

  function statusId(article) {
    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  function replyTargets(article) {
    const out = [];
    for (const div of article.querySelectorAll('div')) {
      const txt = (div.textContent || '').slice(0, 40);
      if (REPLY_RE.test(txt) && div.querySelector('a[href^="/"]')) {
        for (const a of div.querySelectorAll('a[href^="/"]')) {
          const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
          if (m) out.push(m[1].toLowerCase());
        }
        if (out.length) return out;
      }
    }
    return out;
  }

  function isReply(article) {
    const first = article.querySelector('div[dir]');
    if (first && REPLY_RE.test(first.textContent || '')) return true;
    return replyTargets(article).length > 0;
  }

  /* Who pressed repost. The label links to their profile; display names in the
     label are not handles, so an unlinked label leaves this unknown. */
  function reposterHandle(article) {
    const ctx = article.querySelector('[data-testid="socialContext"]');
    if (!ctx) return null;
    const link = (ctx.closest && ctx.closest('a[href^="/"]')) || ctx.querySelector('a[href^="/"]');
    if (!link) return null;
    const m = (link.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
    return m && !RESERVED.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
  }

  /* Your own account behaves like an allowlist entry with everything on. */
  function entryFor(handle) {
    if (!handle) return null;
    if (ownHandle && handle === ownHandle && S.allowOwnPosts) {
      return { name: 'you', replies: true, reposts: true };
    }
    return S.allowlist[handle] || null;
  }

  function isRepost(article) {
    const ctx = article.querySelector('[data-testid="socialContext"]');
    return !!ctx && REPOST_RE.test(ctx.textContent || '');
  }

  function isQuote(article) {
    return !!article.querySelector('div[role="link"][tabindex] [data-testid="tweetText"], div[role="link"] [data-testid="User-Name"]');
  }

  function isPromoted(article) {
    if (article.closest('[data-testid="placementTracking"]')) return true;
    const ctx = article.querySelector('[data-testid="socialContext"]');
    return !!ctx && /^(ad|promoted|anzeige|promocionado)\b/i.test((ctx.textContent || '').trim());
  }

  function matchedKeyword(article) {
    if (!S.muteKeywords || !S.muteKeywords.length) return null;
    const txt = (article.textContent || '').toLowerCase();
    for (const k of S.muteKeywords) if (k && txt.includes(k)) return k;
    return null;
  }

  /* returns {state:'allow'|'hide', handle, reason} or null when undecidable yet */
  function decide(article) {
    if (S.hidePromoted && isPromoted(article)) return { state: 'hide', handle: null, reason: 'promoted' };
    const handle = authorHandle(article);
    if (!handle) return null;

    /* shared filters, applied however a post earned its place */
    const extraFilters = (who) => {
      const kw = matchedKeyword(article);
      if (kw) return { state: 'hide', handle: who, reason: 'muted word "' + kw + '"' };
      if (S.hideQuotePosts && isQuote(article)) return { state: 'hide', handle: who, reason: 'quote post' };
      return null;
    };

    /* A repost belongs to whoever reposted it, not to whoever wrote it. If you
       allow their reposts you see it, and the original author gains nothing:
       their own posts stay hidden until you add them yourself. */
    if (isRepost(article)) {
      const reposter = reposterHandle(article);
      const rEntry = entryFor(reposter);
      const aEntry = entryFor(handle);
      let who = reposter || handle;
      let reason = null;

      let ok = false;
      if (rEntry) {
        if (rEntry.reposts) { ok = true; who = reposter; }
        else { reason = 'repost (reposts off for @' + reposter + ')'; who = reposter; }
      } else if (!reposter) {
        reason = 'repost, reposter not identifiable';
      } else {
        reason = 'reposted by @' + reposter + ', who is not on your list';
      }
      /* the original author being allowed is reason enough on its own */
      if (!ok && aEntry) { ok = true; who = handle; }
      if (!ok) return { state: 'hide', handle: who, reason: reason || 'repost from outside your list' };

      return extraFilters(who) || { state: 'allow', handle: who };
    }

    const entry = entryFor(handle);
    if (!entry) return { state: 'hide', handle, reason: 'not on allowlist' };

    const extra = extraFilters(handle);
    if (extra) return extra;

    if (isReply(article) && !entry.replies) {
      const targets = replyTargets(article);
      const selfThread = targets.length > 0 && targets.every(t => t === handle);
      if (!selfThread) return { state: 'hide', handle, reason: 'reply' };
    }
    return { state: 'allow', handle };
  }

  /* ---------------- stubs ---------------- */
  function addStub(cell, handle, reason) {
    if (cell.querySelector(':scope > .qx-stub')) return;
    const stub = document.createElement('div');
    stub.className = 'qx-stub';
    const label = document.createElement('span');
    label.textContent = handle ? '' : 'Hidden post';
    if (handle) {
      const b = document.createElement('b');
      b.textContent = '@' + handle;
      label.appendChild(b);
      label.appendChild(document.createTextNode(' hidden' + (reason ? ' — ' + reason : '')));
    } else if (reason) {
      label.textContent = 'Hidden — ' + reason;
    }
    stub.appendChild(label);
    if (handle) {
      const allow = document.createElement('button');
      allow.textContent = 'Allow';
      allow.addEventListener('click', e => { e.stopPropagation(); allowAccount(handle, false); });
      const allowR = document.createElement('button');
      allowR.textContent = '+ replies';
      allowR.addEventListener('click', e => { e.stopPropagation(); allowAccount(handle, true); });
      stub.appendChild(allow);
      stub.appendChild(allowR);
    }
    cell.insertBefore(stub, cell.firstChild);
  }

  async function allowAccount(handle, withReplies) {
    const s = await Q.getSettings();
    s.allowlist[handle] = Object.assign(
      { name: '', added: Date.now(), manual: true, replies: !!withReplies, reposts: s.defaultReposts },
      s.allowlist[handle] || {},
      withReplies ? { replies: true } : {}
    );
    await Q.setSettings({ allowlist: s.allowlist });
  }

  /* ---------------- main pass ---------------- */
  let hiddenCount = 0, shownCount = 0;

  function processAll() {
    if (!S) return;
    applyFlags();
    const active = filterActive();
    const r = route();

    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    let firstOnStatus = true;
    for (const article of articles) {
      const cell = article.closest('div[data-testid="cellInnerDiv"]');
      const target = cell || article;
      if (!active) { target.removeAttribute('data-qx-state'); continue; }

      /* on a post you opened, never hide the post itself */
      if (r.isStatus && firstOnStatus) {
        firstOnStatus = false;
        target.setAttribute('data-qx-state', 'allow');
        continue;
      }
      /* X recycles timeline nodes, so a cell already marked "allow" can be
         re-used for a different post. Re-decide whenever the post identity changes. */
      const key = statusId(article) || authorHandle(article) || '';
      if (target.getAttribute('data-qx-state') && target.dataset.qxKey && target.dataset.qxKey === key) continue;

      const d = decide(article);
      if (!d) {
        /* Author not readable yet. Keep the post invisible while we retry, and
           if it never resolves, hide it — default-deny, not default-allow. */
        const since = Number(target.dataset.qxPending || 0);
        if (!since) { target.dataset.qxPending = String(Date.now()); continue; }
        if (Date.now() - since < 8000) continue;
        target.dataset.qxKey = key;
        target.dataset.qxHandle = '-';
        target.setAttribute('data-qx-state', cell && S.showPlaceholders ? 'stub' : 'hide');
        if (cell && S.showPlaceholders) addStub(cell, null, 'author not readable');
        hiddenCount++;
        continue;
      }
      delete target.dataset.qxPending;
      target.dataset.qxKey = key;
      const oldStub = cell && cell.querySelector(':scope > .qx-stub');
      if (oldStub) oldStub.remove();
      target.dataset.qxHandle = d.handle || '-';

      if (d.state === 'allow') {
        if (r.isHome && S.postBudgetEnabled) {
          shownThisSession++;
          if (shownThisSession > S.postBudget) {
            stopped = true;
            target.setAttribute('data-qx-state', 'hide');
            showStopBanner();
            applyFlags();
            continue;
          }
        }
        target.setAttribute('data-qx-state', 'allow');
        shownCount++;
      } else {
        target.setAttribute('data-qx-state', cell && S.showPlaceholders ? 'stub' : 'hide');
        if (cell && S.showPlaceholders) addStub(cell, d.handle, d.reason);
        hiddenCount++;
      }
    }

    if (active) allowReplyContext();

    if (S.enabled && !bypassActive()) {
      markAds();
      markTopicModules();
      trimSidebar();
      protectSearch();
      handleTabs();
      injectProfileButton();
    }
  }

  /* ---------------- sidebar, minus the noise ---------------- */
  /* Hide only what is recognised as noise, never the column as a whole. The earlier
     version hid everything when it could not find a search box, which fails toward
     hiding search whenever X renders search as something unrecognised. Hiding a
     known list of modules fails the other way: an unknown module stays visible. */
  const SIDEBAR_NOISE = /(trend|what.?s happening|who to follow|you might like|relevant people|live on x|subscribe|premium|verified|today.?s news|footer)/i;
  const SEARCHISH = 'input, form, [role="search"], [aria-label*="search" i], [data-testid*="search" i]';

  /* A module's boundary: climb only through wrappers that hold nothing but this
     module (single-child), and never into anything search-like. So a hidden node
     can never contain a sibling module — known or unknown — let alone search. */
  function moduleOf(el, col) {
    let n = el;
    while (n.parentElement && n.parentElement !== col
           && n.parentElement.children.length === 1
           && !n.parentElement.querySelector(SEARCHISH)) {
      n = n.parentElement;
    }
    return n;
  }

  function trimSidebar() {
    /* clear the wholesale mode older versions set */
    document.querySelectorAll('[data-qx-sidebar-mode]').forEach(n => n.removeAttribute('data-qx-sidebar-mode'));
    const col = document.querySelector('[data-testid="sidebarColumn"]');
    if (!col) return;
    if (!S.hideSidebar) {
      col.querySelectorAll('[data-qx-hide="1"]').forEach(n => n.removeAttribute('data-qx-hide'));
      return;
    }
    const mark = (el) => {
      if (!el || el === col) return;
      if (el.matches(SEARCHISH) || el.querySelector(SEARCHISH)) return;
      el.setAttribute('data-qx-hide', '1');
    };
    for (const el of col.querySelectorAll('section[aria-label], div[aria-label], aside[aria-label], nav[aria-label]')) {
      const label = el.getAttribute('aria-label') || '';
      if (/search/i.test(label)) continue;
      if (SIDEBAR_NOISE.test(label)) mark(moduleOf(el, col));
    }
    for (const el of col.querySelectorAll('[data-testid="trend"], [data-testid="UserCell"], '
      + '[data-testid="super-upsell-UpsellCardRenderProperties"], a[href^="/i/premium"], a[href^="/i/verified"]')) {
      mark(moduleOf(el, col));
    }
  }

  /* Search moves around: in the right sidebar on a wide window, up into the top bar
     on a narrow one. Rather than knowing where it is, make it un-hideable — nothing
     this extension hides may contain it. Runs after every other sweep. */
  const SEARCH_SELECTORS = [
    '[data-testid="SearchBox_Search_Input"]',
    '[data-testid*="search" i]',
    '[role="search"]',
    'form[action="/search"]',
    'input[placeholder*="search" i]',
    'input[aria-label*="search" i]',
    'button[aria-label*="search" i]',
    'a[aria-label*="search" i]',
    '[aria-label="Search and explore"]'
  ].join(', ');

  function protectSearch() {
    let boxes;
    try { boxes = document.querySelectorAll(SEARCH_SELECTORS); } catch (e) { return; }
    for (const box of boxes) {
      /* Never reach into posts: a cashtag is a /search link, and un-hiding its
         ancestors would un-hide a promoted post that mentions $TSLA. */
      if (box.closest('article, [data-testid="cellInnerDiv"]')) continue;
      let n = box;
      while (n && n !== document.documentElement) {
        n.removeAttribute('data-qx-hide');
        n.removeAttribute('data-qx-topic');
        n.removeAttribute('data-qx-ad');
        n.setAttribute('data-qx-keep-search', '1');
        n = n.parentElement;
      }
    }
  }

  /* ---------------- thread context ---------------- */
  /* When an allowed account replies to someone, show what they replied to, so the
     reply is not stranded. This does not put that someone on your allowlist: their
     own posts stay hidden. */
  function allowReplyContext() {
    if (!S.showReplyContext) return;
    const cells = Array.from(document.querySelectorAll('div[data-testid="cellInnerDiv"]'));
    for (let i = 1; i < cells.length; i++) {
      const cell = cells[i];
      if (cell.getAttribute('data-qx-state') !== 'allow') continue;
      const art = cell.querySelector('article[data-testid="tweet"]');
      if (!art) continue;
      const targets = replyTargets(art);
      if (!targets.length) continue;

      const prev = cells[i - 1];
      if (prev.getAttribute('data-qx-state') === 'allow') continue;
      const pArt = prev.querySelector('article[data-testid="tweet"]');
      if (!pArt) continue;
      const pHandle = authorHandle(pArt);
      if (!pHandle || !targets.includes(pHandle)) continue;

      prev.setAttribute('data-qx-state', 'allow');
      prev.dataset.qxContext = '1';
      const stub = prev.querySelector(':scope > .qx-stub');
      if (stub) stub.remove();
    }
  }

  /* ---------------- mirror who you follow ---------------- */
  function handleForFollowButton(btn) {
    const cell = btn.closest('[data-testid="UserCell"]');
    if (cell) {
      const h = handleFromLinks(cell);
      if (h) return h;
    }
    const art = btn.closest('article[data-testid="tweet"]');
    if (art) {
      const h = authorHandle(art);
      if (h) return h;
    }
    const r = route();
    if (r.isProfile) return location.pathname.split('/').filter(Boolean)[0].toLowerCase();
    return null;
  }

  async function mirrorAdd(handle) {
    const s = await Q.getSettings();
    if (s.allowlist[handle]) return;
    s.allowlist[handle] = {
      name: '', added: Date.now(), via: 'follow',
      replies: s.defaultReplies, reposts: s.defaultReposts
    };
    await Q.setSettings({ allowlist: s.allowlist });
  }

  async function mirrorRemove(handle) {
    const s = await Q.getSettings();
    const e = s.allowlist[handle];
    if (!e || e.manual) return;        /* a hand-added account is yours, not the mirror's */
    delete s.allowlist[handle];
    await Q.setSettings({ allowlist: s.allowlist });
  }

  /* Follow and unfollow on X, and the allowlist tracks it. The button's testid
     carries a user id rather than a handle, so the handle comes from context; and
     we only act once the button has actually flipped, so a cancelled unfollow
     confirmation does not drop the account. */
  function watchFollowButtons() {
    document.addEventListener('click', (e) => {
      if (!S || !S.enabled || !S.mirrorFollowing) return;
      const btn = e.target && e.target.closest
        && e.target.closest('[data-testid$="-follow"], [data-testid$="-unfollow"]');
      if (!btn) return;
      const before = btn.getAttribute('data-testid') || '';
      const wasFollow = /-follow$/.test(before);
      const handle = handleForFollowButton(btn);
      if (!handle) return;

      let tries = 0;
      const t = setInterval(() => {
        tries++;
        const now = btn.getAttribute('data-testid') || '';
        const flipped = wasFollow ? /-unfollow$/.test(now) : /-follow$/.test(now);
        if (flipped) {
          clearInterval(t);
          if (wasFollow) mirrorAdd(handle); else mirrorRemove(handle);
        } else if (tries > 16) {
          clearInterval(t);
        }
      }, 250);
    }, true);
  }

  /* ---------------- ads anywhere on the page ---------------- */
  const AD_RE = /^\s*(ad|promoted|anzeige|gesponsert|publicidad|promocionado|sponsorisé|広告|プロモーション|广告)\b/i;
  /* X renders adjacent spans with no whitespace between them, so textContent of a
     whole trend reads like "SomethingPromoted by BrandCo". Test each element's own
     text instead of the concatenated blob. */
  const AD_LABEL_RE = /^(ad|promoted|sponsored|promoted by\b.*|anzeige|gesponsert|publicidad|promocionado|sponsorisé|広告|プロモーション|广告)$/i;

  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.trim();
  }

  function hasAdLabel(root) {
    if (AD_LABEL_RE.test(ownText(root))) return true;
    for (const el of root.querySelectorAll('span, div')) {
      if (AD_LABEL_RE.test(ownText(el))) return true;
    }
    return false;
  }

  function markAds() {
    if (!S.hidePromoted) return;

    /* promoted posts in any timeline */
    for (const pt of document.querySelectorAll('[data-testid="placementTracking"]')) {
      const cell = pt.closest('div[data-testid="cellInnerDiv"]') || pt;
      cell.setAttribute('data-qx-ad', '1');
    }
    /* "Ad" / "Promoted" label on a post */
    for (const ctx of document.querySelectorAll('[data-testid="socialContext"]')) {
      if (!AD_RE.test(ctx.textContent || '') && !hasAdLabel(ctx)) continue;
      const art = ctx.closest('article[data-testid="tweet"]');
      const cell = (art && art.closest('div[data-testid="cellInnerDiv"]')) || art;
      if (cell) cell.setAttribute('data-qx-ad', '1');
    }
    /* promoted trends in the sidebar / explore */
    for (const tr of document.querySelectorAll('[data-testid="trend"]')) {
      if (hasAdLabel(tr)) tr.setAttribute('data-qx-ad', '1');
    }
    /* promoted accounts in follow suggestions */
    for (const uc of document.querySelectorAll('[data-testid="UserCell"]')) {
      if (!hasAdLabel(uc)) continue;
      const cell = uc.closest('div[data-testid="cellInnerDiv"]') || uc;
      cell.setAttribute('data-qx-ad', '1');
    }
  }

  /* ---------------- followed topics ---------------- */
  const TOPIC_HEAD_RE = /^(topics|topics to follow|more topics|explore topics|discover topics|happening now|what's happening)/i;

  function markTopicModules() {
    if (!S.hideTopicModules) return;
    for (const h of document.querySelectorAll('[data-testid="primaryColumn"] [role="heading"], [data-testid="primaryColumn"] h2')) {
      const txt = (h.textContent || '').trim();
      if (!TOPIC_HEAD_RE.test(txt)) continue;
      const cell = h.closest('div[data-testid="cellInnerDiv"]');
      if (cell && !cell.querySelector('article[data-testid="tweet"]')) {
        cell.setAttribute('data-qx-topic', '1');
      }
    }
    /* horizontal pill rails that are not the main tab bar */
    for (const rail of document.querySelectorAll('[data-testid="ScrollSnap-List"]')) {
      if (rail.querySelector('[role="tab"]')) continue;   /* that's the tab bar */
      const cell = rail.closest('div[data-testid="cellInnerDiv"]') || rail;
      cell.setAttribute('data-qx-topic', '1');
    }
  }

  /* ---------------- For You tab ---------------- */
  function handleTabs() {
    if (!route().isHome) return;
    const list = document.querySelector('[data-testid="primaryColumn"] [role="tablist"]');
    if (!list) return;
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    if (tabs.length < 2) return;

    const forYou = tabs[0];
    const following = tabs[1];

    if (S.hideForYou) forYou.style.setProperty('display', 'none', 'important');
    else forYou.style.removeProperty('display');

    /* Anything past Following is a followed topic or a pinned list. */
    for (let i = 2; i < tabs.length; i++) {
      if (S.hideTopicTabs) tabs[i].setAttribute('data-qx-topic', '1');
      else tabs[i].removeAttribute('data-qx-topic');
    }

    if (S.forceFollowing && following.getAttribute('aria-selected') !== 'true') {
      const selected = tabs.find(t => t.getAttribute('aria-selected') === 'true');
      /* only redirect away from tabs we are hiding, so a tab you chose on purpose stays */
      const hiddenSelection = selected === forYou
        ? S.hideForYou
        : (selected && selected.hasAttribute('data-qx-topic'));
      if (hiddenSelection) following.click();
    }
  }

  /* ---------------- profile allow button ---------------- */
  function injectProfileButton() {
    const r = route();
    if (!r.isProfile) return;
    const handle = location.pathname.split('/').filter(Boolean)[0].toLowerCase();
    const anchor = document.querySelector('[data-testid="userActions"]')
      || document.querySelector('[data-testid$="-follow"]')
      || document.querySelector('[data-testid$="-unfollow"]');
    if (!anchor || !anchor.parentElement) return;
    let btn = document.getElementById('qx-profile-btn');
    const allowed = !!S.allowlist[handle];
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'qx-profile-btn';
      btn.className = 'qx-btn qx-ghost';
      btn.style.marginRight = '8px';
      btn.addEventListener('click', async e => {
        e.preventDefault();
        const s = await Q.getSettings();
        if (s.allowlist[handle]) delete s.allowlist[handle];
        else s.allowlist[handle] = { name: '', added: Date.now(), manual: true, replies: s.defaultReplies, reposts: s.defaultReposts };
        await Q.setSettings({ allowlist: s.allowlist });
      });
      anchor.parentElement.insertBefore(btn, anchor);
    }
    btn.textContent = allowed ? 'On timeline ✓' : 'Allow on timeline';
    btn.dataset.qxHandleFor = handle;
  }

  /* ---------------- banners & overlays ---------------- */
  function showStopBanner() {
    if (document.getElementById('qx-stop-banner')) return;
    const col = document.querySelector('[data-testid="primaryColumn"]');
    if (!col) return;
    const el = document.createElement('div');
    el.id = 'qx-stop-banner';
    el.className = 'qx-banner';
    el.innerHTML = '<b>Post budget reached.</b> You have seen ' + S.postBudget +
      ' approved posts this session. The rest of the timeline is hidden until you reload deliberately.';
    const more = document.createElement('div');
    more.className = 'qx-row';
    more.style.marginTop = '10px';
    const btn = document.createElement('button');
    btn.className = 'qx-btn qx-ghost';
    btn.textContent = 'Give me 20 more';
    btn.addEventListener('click', () => {
      shownThisSession = 0; stopped = false;
      el.remove(); applyFlags();
      document.querySelectorAll('[data-qx-state]').forEach(n => {
        if (n.getAttribute('data-qx-state') === 'hide' && n.dataset.qxHandle) {
          n.removeAttribute('data-qx-state');
          delete n.dataset.qxHandle; delete n.dataset.qxKey;
        }
      });
      processAll();
    });
    more.appendChild(btn);
    el.appendChild(more);
    col.insertBefore(el, col.firstChild);
  }

  function overlay(build) {
    const host = document.createElement('div');
    host.className = 'qx-overlay';
    const card = document.createElement('div');
    card.className = 'qx-card';
    host.appendChild(card);
    build(card, () => host.remove());
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  function showGate() {
    let secs = Math.max(0, Number(S.gateSeconds) || 0);
    overlay((card, close) => {
      const h = document.createElement('h1');
      h.textContent = 'Before you open X';
      const p = document.createElement('p');
      p.textContent = S.gateAskIntent
        ? 'What are you here to do? Naming it makes it much more likely you leave when you are done.'
        : 'A short pause, on purpose.';
      card.appendChild(h); card.appendChild(p);
      let input = null;
      if (S.gateAskIntent) {
        input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'e.g. check replies, then leave';
        card.appendChild(input);
      }
      const row = document.createElement('div');
      row.className = 'qx-row';
      const go = document.createElement('button');
      go.className = 'qx-btn';
      go.disabled = secs > 0;
      go.textContent = secs > 0 ? 'Wait ' + secs + 's' : 'Continue';
      const leave = document.createElement('button');
      leave.className = 'qx-btn qx-ghost';
      leave.textContent = 'Not now — close tab';
      row.appendChild(go); row.appendChild(leave);
      card.appendChild(row);

      const note = document.createElement('div');
      note.className = 'qx-note';
      note.textContent = 'Quiet X is filtering this timeline to your approved accounts.';
      card.appendChild(note);

      const t = setInterval(() => {
        secs--;
        if (secs <= 0) { clearInterval(t); go.disabled = false; go.textContent = 'Continue'; }
        else go.textContent = 'Wait ' + secs + 's';
      }, 1000);

      go.addEventListener('click', () => {
        clearInterval(t);
        gatePassed = true;
        try { sessionStorage.setItem('qx-gate-passed', '1'); } catch (e) {}
        if (input && input.value.trim()) {
          try { sessionStorage.setItem('qx-intent', input.value.trim()); } catch (e) {}
        }
        close();
        processAll();
      });
      leave.addEventListener('click', () => {
        clearInterval(t);
        location.href = 'about:blank';
      });
    });
  }

  function showLockout(minutesUsed) {
    if (document.getElementById('qx-lockout')) return;
    const host = overlay((card, close) => {
      const h = document.createElement('h1');
      h.textContent = "That's your time for today";
      const p = document.createElement('p');
      p.textContent = 'You have spent ' + minutesUsed + ' minutes on X today, out of the ' +
        S.timeBudget + ' you set for yourself.';
      card.appendChild(h); card.appendChild(p);
      const row = document.createElement('div');
      row.className = 'qx-row';
      const leave = document.createElement('button');
      leave.className = 'qx-btn';
      leave.textContent = 'Close X';
      leave.addEventListener('click', () => { location.href = 'about:blank'; });
      const over = document.createElement('button');
      over.className = 'qx-btn qx-ghost';
      over.textContent = 'Override for ' + S.bypassMinutes + ' min';
      over.addEventListener('click', async () => {
        const word = prompt('Type OVERRIDE to unlock for ' + S.bypassMinutes + ' minutes.');
        if ((word || '').trim().toUpperCase() !== 'OVERRIDE') return;
        bypassUntil = Date.now() + S.bypassMinutes * 60000;
        await chrome.storage.local.set({ bypassUntil });
        lockedOut = false;
        close();
        applyFlags(); processAll();
      });
      row.appendChild(leave); row.appendChild(over);
      card.appendChild(row);
    });
    host.id = 'qx-lockout';
    lockedOut = true;
  }

  /* ---------------- time tracking ---------------- */
  function startClock() {
    setInterval(async () => {
      if (!S || !S.enabled) return;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'qx-tick', seconds: 5, shown: shownCount, hidden: hiddenCount
        });
        shownCount = 0; hiddenCount = 0;
        if (!res) return;
        if (S.timeBudgetEnabled && !bypassActive() && !importing && res.seconds >= S.timeBudget * 60) {
          showLockout(Math.round(res.seconds / 60));
        }
      } catch (e) { /* service worker asleep */ }
    }, 5000);
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    S = await Q.getSettings();
    const st = await chrome.storage.local.get(['bypassUntil', 'qxImporting']);
    bypassUntil = st.bypassUntil || 0;
    importing = !!st.qxImporting;
    try { gatePassed = sessionStorage.getItem('qx-gate-passed') === '1'; } catch (e) { gatePassed = true; }
    applyFlags();

    await whenBody();
    captureOwnHandle();
    chrome.runtime.sendMessage({ type: 'qx-open' }).catch(() => {});

    if (S.enabled && S.gateEnabled && !gatePassed && !bypassActive() && !importing
        && !/\/(following|followers)$/.test(location.pathname)) showGate();

    watchFollowButtons();
    processAll();
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(processAll, 1200);
    startClock();

    /* SPA navigation */
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        stopped = false;
        const b = document.getElementById('qx-stop-banner');
        if (b) b.remove();
        applyFlags();
        processAll();
      }
    }, 300);

    chrome.storage.onChanged.addListener(async (changes) => {
      if (changes.settings) {
        S = Object.assign({}, Q.DEFAULTS, changes.settings.newValue || {});
        document.querySelectorAll('[data-qx-state]').forEach(n => {
          n.removeAttribute('data-qx-state');
          delete n.dataset.qxHandle; delete n.dataset.qxKey; delete n.dataset.qxPending;
        });
        document.querySelectorAll('.qx-stub').forEach(n => n.remove());
        shownThisSession = 0; stopped = false;
        applyFlags(); processAll();
      }
      if (changes.qxImporting) importing = !!changes.qxImporting.newValue;
      if (changes.bypassUntil) {
        bypassUntil = changes.bypassUntil.newValue || 0;
        applyFlags(); processAll();
      }
    });
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; processAll(); });
  }

  function whenBody() {
    if (document.body) return Promise.resolve();
    return new Promise(res => {
      const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); res(); } });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  function captureOwnHandle() {
    const tick = setInterval(() => {
      const el = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')
        || document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
      if (!el) return;
      const href = el.getAttribute('href');
      let h = null;
      if (href) { const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/); if (m) h = m[1].toLowerCase(); }
      if (!h) { const m = (el.textContent || '').match(/@([A-Za-z0-9_]{1,15})/); if (m) h = m[1].toLowerCase(); }
      if (h) {
        ownHandle = h;
        chrome.storage.local.set({ ownHandle: h });
        clearInterval(tick);
        processAll();
      }
    }, 1000);
    setTimeout(() => clearInterval(tick), 30000);
  }

  if (globalThis.__QX_TEST__) {
    globalThis.__qx = {
      decide, authorHandle, isReply, isRepost, isQuote, isPromoted, replyTargets, route, statusId, filterActive, markAds, markTopicModules, handleTabs, hasAdLabel, trimSidebar, protectSearch, reposterHandle, allowReplyContext, entryFor,
      setS: (s, own) => { S = s; ownHandle = own || null; }
    };
  } else {
    boot();
  }
})();
