/* Shared defaults + storage helpers. Loaded as a classic script in content
   scripts, popup, options and the service worker. Exposes globalThis.QX. */
(function () {
  const DEFAULTS = {
    /* master */
    enabled: true,

    /* where filtering applies */
    scope: 'home',            // 'home' | 'everywhere'
    filterStatusPages: false, // filter replies under a post you opened (off: show the whole thread)
    allowOwnPosts: true,

    /* allowlist: { handle(lowercase): {name, replies, reposts, added} } */
    allowlist: {},
    defaultReplies: true,     // used for newly added / imported accounts
    defaultReposts: true,
    mirrorFollowing: true,    // allowlist tracks who you follow, live
    showReplyContext: true,   // show the post an allowed reply is answering

    /* feed surgery */
    hideForYou: true,
    forceFollowing: true,
    hidePromoted: true,       // ads & promoted content, everywhere not just the feed
    hideTopicTabs: true,      // followed topics / pinned lists in the timeline header
    hideTimelineTabs: false,  // the whole header tab bar
    hideTopicModules: true,   // "Topics to follow" carousels inside the feed
    showPlaceholders: true,   // show a thin "@x hidden" stub instead of nothing

    /* visual noise */
    mediaMode: 'off',         // 'off' | 'blur' | 'hide'
    hideAvatars: false,
    hideMetrics: true,        // like / repost / reply / view counts
    hideVerifiedBadges: false,
    grayscale: false,
    hideSidebar: true,        // right column: trends, who to follow, premium
    hideWhoToFollow: true,
    hidePremiumUpsell: true,
    hideNotificationBadges: true,
    hideExploreNav: false,
    hideGrokNav: false,
    hideMessagesDrawer: false,
    hideLiveSpaces: true,

    /* content filters */
    muteKeywords: [],         // array of lowercase strings
    hideQuotePosts: false,
    minimalMode: false,       // text-only, tight spacing

    /* attention budgets */
    postBudgetEnabled: true,
    postBudget: 60,           // approved posts per browsing session
    timeBudgetEnabled: true,
    timeBudget: 20,           // minutes per day
    gateEnabled: true,
    gateSeconds: 7,           // pause before the site opens
    gateAskIntent: true,
    bypassMinutes: 5          // length of a deliberate override
  };

  const DAY = () => new Date().toISOString().slice(0, 10);

  async function getSettings() {
    const got = await chrome.storage.local.get('settings');
    return Object.assign({}, DEFAULTS, got.settings || {});
  }
  async function setSettings(patch) {
    const cur = await getSettings();
    const next = Object.assign({}, cur, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }
  async function getStats() {
    const got = await chrome.storage.local.get('stats');
    return got.stats || {};
  }
  async function bumpStats(patch) {
    const stats = await getStats();
    const d = DAY();
    const row = stats[d] || { seconds: 0, shown: 0, hidden: 0, opens: 0 };
    for (const k of Object.keys(patch)) row[k] = (row[k] || 0) + patch[k];
    stats[d] = row;
    /* keep 90 days */
    const keys = Object.keys(stats).sort();
    while (keys.length > 90) delete stats[keys.shift()];
    await chrome.storage.local.set({ stats });
    return row;
  }
  function normHandle(h) {
    return String(h || '').trim().replace(/^@+/, '').replace(/^.*\//, '').toLowerCase();
  }

  globalThis.QX = { DEFAULTS, DAY, getSettings, setSettings, getStats, bumpStats, normHandle };
})();
