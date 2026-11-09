/* Tests the pieces that run inside the page during a following-list sync:
   handle detection across X's layouts, and the scraper. */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('/home/claude/node_modules/jsdom');
/* jsdom has no scrolling; its "not implemented" notices are noise here */
const quiet = new VirtualConsole();
quiet.on('jsdomError', () => {});

const src = fs.readFileSync('/home/claude/quietx/src/background.js', 'utf8');
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
const probeHandle = eval('(' + extract('probeHandle') + ')');
const scrapeFollowing = eval('(' + extract('scrapeFollowing') + ')');

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' → got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
function page(html, url = 'https://x.com/home') {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url, virtualConsole: quiet });
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.getComputedStyle = dom.window.getComputedStyle;
  return dom;
}

console.log('handle detection across layouts');

// wide window: the left nav is present
page('<a data-testid="AppTabBar_Profile_Link" href="/andrewk"><span>Profile</span></a>');
check('wide layout: nav profile link', probeHandle().handle, 'andrewk');

// narrow window: X drops the profile link and the account switcher entirely.
// This is the case that failed — the avatar testid carries the handle.
page('<div data-testid="primaryColumn">' +
     '<div data-testid="UserAvatar-Container-andrewk"></div>' +
     '<div data-testid="tweetTextarea_0"></div></div>');
check('narrow layout: avatar testid', probeHandle().handle, 'andrewk');

// account switcher present but unlabelled, avatar nested inside it
page('<button data-testid="SideNav_AccountSwitcher_Button">' +
     '<div data-testid="UserAvatar-Container-andrewk"></div></button>');
check('switcher with nested avatar', probeHandle().handle, 'andrewk');

// switcher showing the handle as text
page('<button data-testid="SideNav_AccountSwitcher_Button"><span>Andrew</span><span>@andrewk</span></button>');
check('switcher text', probeHandle().handle, 'andrewk');

// signed out: no handle, and it must SAY it is signed out
page('<a href="/i/flow/login" data-testid="loginButton">Sign in</a>', 'https://x.com/');
const out = probeHandle();
check('signed out: no handle', out.handle, null);
check('signed out: reported', out.loggedOut, true);

// signed in but nothing recognisable: no handle, and NOT reported as signed out
page('<div data-testid="primaryColumn"><article data-testid="tweet"></article></div>');
const amb = probeHandle();
check('unknown layout: no handle', amb.handle, null);
check('unknown layout: not called signed out', amb.loggedOut, false);

console.log('scraper');
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms) => realSetInterval(fn, Math.min(ms, 5));

(async () => {
  // a rendered following list
  let html = '<div data-testid="primaryColumn">';
  for (const h of ['alice', 'bob', 'carol']) {
    html += `<div data-testid="UserCell"><a href="/${h}"><span>${h} Name</span></a></div>`;
  }
  html += '</div>';
  page(html, 'https://x.com/andrewk/following');
  const r = await scrapeFollowing();
  check('found every account', r.handles.length, 3);
  check('handles parsed', r.handles.map(x => x.handle).join(','), 'alice,bob,carol');
  check('names captured', r.handles[0].name, 'alice Name');
  check('diagnostics report cells', r.diag.cellsSeen, 3);

  // list never renders: must give up and say so rather than hang
  page('<div data-testid="primaryColumn"></div>', 'https://x.com/andrewk/following');
  const empty = await scrapeFollowing();
  check('no list: empty result', empty.handles.length, 0);
  check('no list: waited then gave up', empty.diag.waitedMs > 0, true);

  // signed out mid-sync
  page('<a data-testid="loginButton" href="/login">Sign in</a>', 'https://x.com/andrewk/following');
  const lo = await scrapeFollowing();
  check('signed out: reported by scraper', lo.diag.loggedOut, true);

  global.setInterval = realSetInterval;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
