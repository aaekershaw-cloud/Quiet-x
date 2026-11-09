/* Service-worker logic: refreshing X tabs after a reload requested from the popup. */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../src/background.js', 'utf8');
function extract(name) {
  const start = src.indexOf('async function ' + name + '(');
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
}
let store = {}, reloaded = [];
global.chrome = {
  storage: { local: {
    get: async k => ({ [k]: store[k] }),
    remove: async k => { delete store[k]; }
  } },
  tabs: {
    query: async () => [{ id: 1, url: 'https://x.com/home' }, { id: 2, url: 'https://x.com/someone' }],
    reload: async id => { reloaded.push(id); }
  }
};
const reloadXTabsIfPending = eval('(' + extract('reloadXTabsIfPending') + ')');

let pass = 0, fail = 0;
const check = (n, g, w) => { if (JSON.stringify(g) === JSON.stringify(w)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + ' → got ' + JSON.stringify(g) + ', want ' + JSON.stringify(w)); } };

(async () => {
  console.log('reload from the popup');
  store = { pendingTabReload: Date.now() }; reloaded = [];
  check('fresh request refreshes every X tab', await reloadXTabsIfPending(), 2);
  check('tabs refreshed', reloaded, [1, 2]);
  check('note cleared so it only fires once', store.pendingTabReload, undefined);

  reloaded = [];
  check('ordinary startup does nothing', await reloadXTabsIfPending(), 0);
  check('no tabs touched', reloaded, []);

  store = { pendingTabReload: Date.now() - 5 * 60000 }; reloaded = [];
  check('stale note ignored', await reloadXTabsIfPending(), 0);
  check('stale note cleared anyway', store.pendingTabReload, undefined);
  check('no surprise refresh', reloaded, []);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
