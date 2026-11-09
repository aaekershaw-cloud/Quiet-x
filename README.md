# Quiet X — allowlist timeline

A Chrome extension that inverts X's defaults: nothing appears in your timeline unless
the account is on your allowlist, and the surfaces built to keep you scrolling are gone.

## Install (unpacked)

1. Unzip this folder somewhere permanent (if you move it later, Chrome drops the extension).
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. **Load unpacked** → pick the `quietx` folder.
4. The settings page opens. Click **Import everyone I follow**.

The import opens a tab on your own following list, scrolls it to the bottom collecting
handles, then closes itself. Leave that tab alone while it runs — a few hundred accounts
takes under a minute. Re-run it any time; it only adds accounts that are new.

## How filtering works

Posts are hidden by CSS *before* they can render, then unhidden only once the author
is matched against your allowlist, so you never catch a glimpse of something you blocked.

- **Not on the list → never shown.**
- **Per account**, you choose whether to see their **replies** and their **reposts**.
  Both default to on: an allowed account's posts, replies and reposts all come through.
- **A repost belongs to whoever reposted it.** If you allow someone's reposts, you see what
  they repost without having to allow each original author — and those authors gain nothing
  from it: their own posts stay hidden until you add them yourself.
- **Mirror mode** keeps the allowlist in step with who you follow: follow someone on X and
  they are allowed through, unfollow and they drop off. Accounts you add by hand are marked
  as yours and are never pruned by a sync.
- **Muted words** apply on top, including to approved accounts.
- **Profile pages are never filtered**, so you can always go and read someone directly.
  Each profile gets an **Allow on timeline** button next to Follow.
- Hidden posts leave a one-line stub with **Allow** / **+ replies** buttons, so an account
  you forgot is one click away. Turn stubs off for a completely blank slate.

## Features

Feed: hide the For You tab, force the Following tab, hide quote posts, hide ads and promoted
content site-wide, hide followed-topic and pinned-list tabs at the top of the timeline, hide
topic carousels, optionally hide the header tab bar outright.

Noise: images and video (show / blur-until-hover / hide), avatars, like-repost-view counts,
verified badges, right sidebar, who-to-follow, premium upsells, Spaces pills, unread badges,
Explore and Grok nav items, message drawer, grayscale, minimal mode.

Attention budgets — the part aimed at regretted minutes:

- **Post budget**: after N approved posts in a session the timeline stops dead with a
  "that's the end" card. Infinite scroll becomes finite.
- **Daily time budget**: counts only seconds with an X tab actually focused. Past the
  budget you get a lockout screen; unlocking requires typing OVERRIDE and lasts a few minutes.
- **Door pause**: a configurable countdown before X opens, with an optional "what are you
  here to do?" prompt. This is the single highest-leverage setting for killing reflex visits.
- **Stats**: minutes per day for two weeks, posts shown, posts hidden.

Backup: export/import everything as JSON, including your allowlist.

## Notes

- All data lives in `chrome.storage.local` on your machine. No network requests, no analytics.
- X ships UI changes constantly. The selectors used (`article[data-testid="tweet"]`,
  `[data-testid="User-Name"]`, `[data-testid="socialContext"]`) are X's own test hooks and
  are the most stable handles available, but if something stops being hidden one day, that's
  the layer to check.
- Reply detection reads the "Replying to" line, with patterns for several languages. If your
  X interface is in a language not covered, replies may slip through; the patterns are in
  `REPLY_RE` near the top of `src/content/content.js`.
- Works in any Chromium browser (Edge, Brave, Arc). For Firefox the manifest needs a
  `browser_specific_settings` block.

## Changelog

### 1.1.0 — leak fixes

- **Blocked posts were still rendering.** The rule that hides a post under its
  placeholder line required the post to sit exactly two levels inside the timeline
  cell; X nests it deeper, so the post stayed visible with a stub above it. Now
  matched by descent. This was the big one.
- **Author is now read only from the post header.** Previously, if the header could
  not be read, the whole post was scanned for a profile link — so a stranger's post
  that merely @mentioned an allowed account was treated as that account's post.
- **Recycled timeline nodes are re-checked.** X reuses cell DOM nodes as you scroll;
  a cell already marked "allow" could be refilled with a different post and keep its
  pass. Decisions are now keyed to the post's status id and re-run when it changes.
- **Unreadable authors are hidden, not shown.** The 4-second fallback used to let the
  post through; it now hides it (with a stub saying why) after 8 seconds of retrying.
- Added **Diagnostics** in settings: with your timeline open, it reports the state of
  every post on screen and lists any visible author that is not on your allowlist.

### 1.2.0 — ads and topics

- **Ads are now swept site-wide**, not just in the timeline: promoted posts, promoted trends
  in the sidebar and Explore, and promoted accounts in follow suggestions. This runs even
  where allowlist filtering does not (profile pages, search), so ads go whatever you are doing.
- **Followed topics and pinned lists** in the timeline header are hidden, leaving only
  Following. If you were sitting on a topic tab, you get moved to Following; a tab you chose
  that is *not* being hidden is left alone.
- **Topic carousels** inside the feed ("Topics to follow", "What's happening") are hidden.
  Only cells with no post in them are swept, so a real post is never caught by this.
- Optional: hide the header tab bar entirely. Off by default.
- Ad labels are matched per element rather than on concatenated text — X renders adjacent
  spans with no whitespace, so a whole-trend text match read "SomethingPromoted by BrandCo"
  and silently missed every promoted trend.

### 1.3.0 — open a post, read the thread

- **Clicking a post now shows the whole conversation**, whoever replied. Per-account
  "replies" controls what reaches your *timeline*; opening a post is a deliberate act, so
  the thread under it is no longer filtered. This is the new default.
- That setting also no longer depends on the scope option. Previously "filter replies under
  a post I open" only did anything when scope was set to everywhere, so its effect depended
  on an unrelated setting. It now stands on its own, either way.
- If you do want threads filtered to your allowlist, the toggle is still there — the post
  you clicked is always kept.
- Added one-time migrations, so changes to defaults reach existing installs instead of only
  new ones. Each runs once and won't overwrite a choice you have made since.

### 1.4.0 — mirror who you follow, reposts belong to the reposter

- **Mirror mode** (on by default): following someone on X allows them through, unfollowing
  drops them. Captured live from the follow buttons, and only once the button actually
  flips, so a cancelled unfollow confirmation does not drop the account. "Sync with my
  following list" does a full pass and prunes accounts you no longer follow — but only if
  the scrape found at least half of your current list, so a rate-limited partial scrape
  can never wipe it. Hand-added accounts are flagged and survive pruning.
- **Reposts are now attributed to the reposter, not the original author.** Previously an
  allowed account reposting a stranger was hidden, because the post's author was the
  stranger. Allowing someone's reposts is now enough to see what they repost. Crucially,
  the reposted account is *not* added to your allowlist and its own posts stay hidden.
- A post written by an allowed account shows even when the repost label belongs to someone
  else — they wrote it; the reposts switch governs what *they* repost.
- **Replies now show what they are answering.** An allowed account's reply reveals the post
  above it that it replied to, so replies are not stranded. That post's author is not
  allowlisted by this, and an unrelated hidden post above a reply stays hidden.
- Defaults for every allowed account are now posts + replies + reposts. A one-time
  migration applies this to accounts already on your list.

### 1.4.1 — sync works on a laptop window

- **Handle detection no longer depends on the left nav.** It read the profile link and the
  account switcher, both of which X removes when the browser window is narrow — so a sync
  worked on a wide window and, on a laptop one, sat on the timeline retrying for 15 seconds
  and gave up. It now also reads the handle from the avatar element's own testid, the
  composer's profile link, and an aria-labelled profile link.
- **A failed sync now says why.** Signed out in this Chrome profile, wrong handle, empty
  list, list never rendered, rate-limited — each gets its own message, with the raw
  diagnostics shown in the Diagnostics box. Previously every failure looked identical.
- **"Your X handle"** in settings: a fallback you can type in if detection still fails.
- **The scraper waits for the list to render** before scrolling, and scrolls whichever
  element is actually scrollable rather than assuming the window.
- The sync tab no longer gets the door pause or the daily lockout on top of it.
- Added `tests/import-test.js` covering handle detection across layouts (wide nav, narrow
  window, nested avatar, signed out, unrecognised) and the scraper's three outcomes.
