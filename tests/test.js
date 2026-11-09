const fs = require('fs');
const { JSDOM } = require('/home/claude/node_modules/jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://x.com/home' });
global.window = dom.window;
global.document = dom.window.document;
global.location = dom.window.location;
global.sessionStorage = dom.window.sessionStorage;
global.requestAnimationFrame = cb => setTimeout(cb, 0);
global.__QX_TEST__ = true;
global.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
  runtime: { sendMessage: async () => ({}), getURL: p => p }
};
global.globalThis.__QX_TEST__ = true;

const base = '/home/claude/quietx/src';
eval(fs.readFileSync(base + '/defaults.js', 'utf8'));
eval(fs.readFileSync(base + '/content/content.js', 'utf8'));
const qx = globalThis.__qx;

const S = Object.assign({}, globalThis.QX.DEFAULTS, {
  allowlist: {
    good: { name: 'Good', replies: false, reposts: false },
    chatty: { name: 'Chatty', replies: true, reposts: true }
  },
  muteKeywords: ['giveaway']
});
qx.setS(S, 'me');

function post({ handle, text = 'hello world', replyTo = null, social = null, promoted = false, quote = false, reposter = null }) {
  const cell = document.createElement('div');
  cell.setAttribute('data-testid', 'cellInnerDiv');
  const article = document.createElement('article');
  article.setAttribute('data-testid', 'tweet');
  let html = '';
  if (promoted) html += '<div data-testid="placementTracking"></div>';
  if (social) {
    html += reposter
      ? `<a href="/${reposter}"><div data-testid="socialContext">${social}</div></a>`
      : `<div data-testid="socialContext">${social}</div>`;
  }
  html += `<div data-testid="User-Name"><a href="/${handle}"><span>${handle}</span></a>` +
          `<a href="/${handle}"><span>@${handle}</span></a></div>`;
  if (replyTo) html += `<div dir="ltr">Replying to <a href="/${replyTo}">@${replyTo}</a></div>`;
  html += `<div data-testid="tweetText">${text}</div>`;
  if (quote) html += '<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/other"><span>@other</span></a></div><div data-testid="tweetText">quoted</div></div>';
  article.innerHTML = html;
  if (promoted) {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-testid', 'placementTracking');
    wrap.appendChild(article);
    cell.appendChild(wrap);
  } else {
    cell.appendChild(article);
  }
  document.body.appendChild(cell);
  return article;
}

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' → got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
const st = a => { const d = qx.decide(a); return d ? d.state : null; };
const reason = a => { const d = qx.decide(a); return d ? d.reason : null; };

console.log('author detection');
check('handle parsed', qx.authorHandle(post({ handle: 'good' })), 'good');

console.log('allowlist');
check('allowed account shows', st(post({ handle: 'good' })), 'allow');
check('stranger hidden', st(post({ handle: 'randomguy' })), 'hide');
check('own posts show', st(post({ handle: 'me' })), 'allow');

console.log('replies');
check('reply hidden when replies off', st(post({ handle: 'good', replyTo: 'someone' })), 'hide');
check('reply reason', reason(post({ handle: 'good', replyTo: 'someone' })), 'reply');
check('self-thread still shows', st(post({ handle: 'good', replyTo: 'good' })), 'allow');
check('reply shows when replies on', st(post({ handle: 'chatty', replyTo: 'someone' })), 'allow');

console.log('reposts');
// a post WRITTEN by an allowed account that someone else reposted: they wrote it, so it shows
// regardless of their own reposts setting (that setting governs what THEY repost)
check('allowed author, reposted by someone else, shows', st(post({ handle: 'good', social: 'Someone reposted' })), 'allow');
check('reposts-on account likewise shows', st(post({ handle: 'chatty', social: 'Someone reposted' })), 'allow');
// a stranger's post with a repost label and no identifiable reposter stays hidden
check('stranger repost with no reposter stays hidden', st(post({ handle: 'randomguy', social: 'Someone reposted' })), 'hide');
check('pinned is not a repost', st(post({ handle: 'good', social: 'Pinned' })), 'allow');

console.log('other filters');
check('muted word hides allowed account', st(post({ handle: 'good', text: 'free GIVEAWAY inside' })), 'hide');
check('promoted hidden', st(post({ handle: 'good', promoted: true })), 'hide');
const S2 = Object.assign({}, S, { hideQuotePosts: true });
qx.setS(S2, 'me');
check('quote hidden when enabled', st(post({ handle: 'good', quote: true })), 'hide');
qx.setS(S, 'me');
check('quote shows when disabled', st(post({ handle: 'good', quote: true })), 'allow');

console.log('reposts belong to the reposter');
const MS = Object.assign({}, globalThis.QX.DEFAULTS, {
  allowlist: {
    good: { name: 'Good', replies: true, reposts: true },
    norepost: { name: 'No Reposts', replies: true, reposts: false }
  }
});
qx.setS(MS, 'me');

// an allowed account reposts a total stranger -> shown, credited to the reposter
const r1 = post({ handle: 'stranger', social: 'Good reposted', reposter: 'good' });
check('allowed account reposting a stranger shows', st(r1), 'allow');
check('credited to the reposter', qx.decide(r1).handle, 'good');
// ...and that stranger gains nothing: their own posts stay hidden
check('reposted stranger is still blocked on their own', st(post({ handle: 'stranger' })), 'hide');
check('reposted stranger not added to the allowlist', MS.allowlist.stranger, undefined);
// reposts off for that account
const r2 = post({ handle: 'stranger', social: 'No Reposts reposted', reposter: 'norepost' });
check('reposts-off account: repost hidden', st(r2), 'hide');
// a stranger reposting an allowed account still shows (author stands on their own)
const r3 = post({ handle: 'good', social: 'Nobody reposted', reposter: 'nobody' });
check('allowed author reposted by a stranger shows', st(r3), 'allow');
// unidentifiable reposter, unknown author -> hidden, with a reason that says why
const r4 = post({ handle: 'stranger', social: 'Someone reposted' });
check('unidentifiable reposter hidden', st(r4), 'hide');
check('reason names the problem', /not identifiable/.test(reason(r4)), true);

console.log('reply context');
// allowed account replies to a stranger: the stranger's post is shown for context
const ctxPrimary = document.createElement('div');
ctxPrimary.setAttribute('data-testid', 'primaryColumn');
document.body.appendChild(ctxPrimary);
function cellWith(article) {
  const c = document.createElement('div');
  c.setAttribute('data-testid', 'cellInnerDiv');
  c.appendChild(article);
  ctxPrimary.appendChild(c);
  return c;
}
function art({ handle, replyTo }) {
  const a = document.createElement('article');
  a.setAttribute('data-testid', 'tweet');
  let h = `<div data-testid="User-Name"><a href="/${handle}"><span>@${handle}</span></a></div>`;
  if (replyTo) h += `<div dir="ltr">Replying to <a href="/${replyTo}">@${replyTo}</a></div>`;
  a.innerHTML = h + '<div data-testid="tweetText">x</div>';
  return a;
}
const parentCell = cellWith(art({ handle: 'stranger' }));
const replyCell = cellWith(art({ handle: 'good', replyTo: 'stranger' }));
parentCell.setAttribute('data-qx-state', 'stub');
replyCell.setAttribute('data-qx-state', 'allow');
qx.allowReplyContext();
check('parent post revealed for context', parentCell.getAttribute('data-qx-state'), 'allow');
check('marked as context, not an allowlist entry', parentCell.dataset.qxContext, '1');
check('context does not touch the allowlist', MS.allowlist.stranger, undefined);

// but an unrelated hidden post above an allowed reply stays hidden
const unrelated = cellWith(art({ handle: 'randomguy' }));
const reply2 = cellWith(art({ handle: 'good', replyTo: 'someoneelse' }));
unrelated.setAttribute('data-qx-state', 'stub');
reply2.setAttribute('data-qx-state', 'allow');
qx.allowReplyContext();
check('unrelated post above a reply stays hidden', unrelated.getAttribute('data-qx-state'), 'stub');

console.log('defaults');
check('new accounts show replies by default', globalThis.QX.DEFAULTS.defaultReplies, true);
check('new accounts show reposts by default', globalThis.QX.DEFAULTS.defaultReposts, true);
check('mirror mode on by default', globalThis.QX.DEFAULTS.mirrorFollowing, true);
qx.setS(S, 'me');

console.log('search');
const go = p => dom.window.history.pushState({}, '', p);
go('/search?q=from%3Agood%20markets');
check('search page detected', qx.route().isSearch, true);
qx.setS(Object.assign({}, globalThis.QX.DEFAULTS, { allowlist: S.allowlist }), 'me');
check('default: search results not filtered', qx.filterActive(), false);
qx.setS(Object.assign({}, globalThis.QX.DEFAULTS, { allowlist: S.allowlist, scope: 'everywhere' }), 'me');
check('not filtered even in everywhere scope', qx.filterActive(), false);
qx.setS(Object.assign({}, globalThis.QX.DEFAULTS, { allowlist: S.allowlist, filterSearch: true }), 'me');
check('filtered when you opt in', qx.filterActive(), true);

console.log('sidebar keeps the search box');
const sideWrap = document.createElement('div');
sideWrap.setAttribute('data-testid', 'sidebarColumn');
sideWrap.innerHTML =
  '<div id="sbinner">' +
  '  <div id="searchwrap"><form role="search"><input data-testid="SearchBox_Search_Input"></form></div>' +
  '  <section id="trends">Trends</section>' +
  '  <aside id="wtf" aria-label="Who to follow">Who to follow</aside>' +
  '  <nav id="footer">Terms</nav>' +
  '</div>';
document.body.appendChild(sideWrap);
qx.setS(Object.assign({}, globalThis.QX.DEFAULTS, { allowlist: S.allowlist, hideSidebar: true }), 'me');
qx.trimSidebar();
check('column itself not blanket-hidden', sideWrap.getAttribute('data-qx-sidebar-mode'), 'keep-search');
check('search wrapper kept', document.getElementById('searchwrap').getAttribute('data-qx-hide'), null);
check('search input still reachable', !!sideWrap.querySelector('[data-testid="SearchBox_Search_Input"]'), true);
check('trends hidden', document.getElementById('trends').getAttribute('data-qx-hide'), '1');
check('who-to-follow hidden', document.getElementById('wtf').getAttribute('data-qx-hide'), '1');
check('footer hidden', document.getElementById('footer').getAttribute('data-qx-hide'), '1');

// a sidebar with no search box can still go entirely
const bare = document.createElement('div');
bare.setAttribute('data-testid', 'sidebarColumn');
bare.innerHTML = '<section>Trends only</section>';
document.body.appendChild(bare);
sideWrap.remove();
qx.trimSidebar();
check('sidebar without search hidden wholesale', bare.getAttribute('data-qx-sidebar-mode'), 'all');
// and with the option off, nothing is marked
qx.setS(Object.assign({}, globalThis.QX.DEFAULTS, { allowlist: S.allowlist, hideSidebar: false }), 'me');
qx.trimSidebar();
check('option off: no mode set', bare.getAttribute('data-qx-sidebar-mode'), null);
bare.remove();
go('/home');
qx.setS(S, 'me');

console.log('leak regressions');
// a stranger's post that merely mentions an allowed account must stay hidden
const mention = post({ handle: 'randomguy', text: 'hey <a href="/good">@good</a> look at this' });
check('mention of allowed account does not allow the post', st(mention), 'hide');
// author unreadable -> undecidable, which processAll turns into "hide"
const headless = document.createElement('article');
headless.setAttribute('data-testid', 'tweet');
headless.innerHTML = '<div data-testid="tweetText">no header at all</div>';
document.body.appendChild(headless);
check('unreadable author is not decided as allow', qx.decide(headless), null);
// status id is used to spot recycled cells
const withId = post({ handle: 'good' });
withId.innerHTML += '<a href="/good/status/1879000000000000001"><time></time></a>';
check('status id parsed', qx.statusId(withId), '1879000000000000001');

console.log('ads and topics');
qx.setS(S, 'me');
// promoted post, labelled form
const adCell = document.createElement('div');
adCell.setAttribute('data-testid', 'cellInnerDiv');
adCell.innerHTML = '<div><article data-testid="tweet"><div data-testid="socialContext">Ad</div>' +
  '<div data-testid="User-Name"><a href="/brandco"><span>@brandco</span></a></div></article></div>';
document.body.appendChild(adCell);
// promoted trend in the sidebar
const trend = document.createElement('div');
trend.setAttribute('data-testid', 'trend');
trend.innerHTML = '<span>Something</span><span>Promoted by BrandCo</span>';
document.body.appendChild(trend);
// an ordinary trend must survive
const trend2 = document.createElement('div');
trend2.setAttribute('data-testid', 'trend');
trend2.innerHTML = '<span>Real trend</span><span>12.4K posts</span>';
document.body.appendChild(trend2);
// topics carousel in the feed
const primary = document.createElement('div');
primary.setAttribute('data-testid', 'primaryColumn');
document.body.appendChild(primary);
const topicCell = document.createElement('div');
topicCell.setAttribute('data-testid', 'cellInnerDiv');
topicCell.innerHTML = '<div role="heading">Topics to follow</div><div><span>Markets</span></div>';
primary.appendChild(topicCell);
// a real post with a heading-ish child must not be swept
const realCell = document.createElement('div');
realCell.setAttribute('data-testid', 'cellInnerDiv');
realCell.innerHTML = '<div role="heading">Topics to follow</div><article data-testid="tweet">' +
  '<div data-testid="User-Name"><a href="/good"><span>@good</span></a></div></article>';
primary.appendChild(realCell);
qx.markAds();
qx.markTopicModules();
check('labelled ad marked', adCell.getAttribute('data-qx-ad'), '1');
check('promoted trend marked', trend.getAttribute('data-qx-ad'), '1');
check('real trend untouched', trend2.getAttribute('data-qx-ad'), null);
check('topics carousel marked', topicCell.getAttribute('data-qx-topic'), '1');
check('cell containing a real post not swept', realCell.getAttribute('data-qx-topic'), null);

// timeline header tabs: For you, Following, then two followed topics
const col = document.createElement('div');
col.setAttribute('data-testid', 'primaryColumn');
col.innerHTML = '<div role="tablist">' +
  '<div role="tab" aria-selected="true">For you</div>' +
  '<div role="tab" aria-selected="false">Following</div>' +
  '<div role="tab" aria-selected="false">Markets</div>' +
  '<div role="tab" aria-selected="false">Formula 1</div></div>';
document.body.appendChild(col);
const tabs = col.querySelectorAll('[role="tab"]');
let followingClicked = false;
tabs[1].click = () => { followingClicked = true; };
qx.handleTabs();
check('For you tab hidden', tabs[0].style.display, 'none');
check('Following tab kept', tabs[1].hasAttribute('data-qx-topic'), false);
check('topic tab 1 marked', tabs[2].getAttribute('data-qx-topic'), '1');
check('topic tab 2 marked', tabs[3].getAttribute('data-qx-topic'), '1');
check('redirected off For you', followingClicked, true);

console.log('routing');
check('home is home', qx.route().isHome, true);

console.log('conversation pages');
const nav = p => dom.window.history.pushState({}, '', p);
const fresh = extra => Object.assign({}, globalThis.QX.DEFAULTS, { allowlist: S.allowlist }, extra || {});

nav('/someone/status/1879000000000000001');
check('status page is detected', qx.route().isStatus, true);
qx.setS(fresh(), 'me');
check('default: thread not filtered', qx.filterActive(), false);
qx.setS(fresh({ scope: 'everywhere' }), 'me');
check('still not filtered in everywhere scope', qx.filterActive(), false);
qx.setS(fresh({ filterStatusPages: true }), 'me');
check('filtered when you opt in, home scope', qx.filterActive(), true);
qx.setS(fresh({ filterStatusPages: true, scope: 'everywhere' }), 'me');
check('filtered when you opt in, everywhere scope', qx.filterActive(), true);

nav('/home');
qx.setS(fresh(), 'me');
check('home still filtered by default', qx.filterActive(), true);
nav('/someprofile');
check('profile never filtered', qx.filterActive(), false);
qx.setS(fresh({ enabled: false }), 'me');
nav('/home');
check('master switch off disables filtering', qx.filterActive(), false);
qx.setS(S, 'me');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
