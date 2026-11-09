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
  Both default to off, which is what makes the timeline quiet. A reply to *themselves*
  (a thread they are continuing) always shows, even with replies off.
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

## Tests

`tests/test.js` exercises the filtering decisions against synthetic X markup (jsdom):
allowlist behaviour, replies vs self-threads, reposts, muted words, ads, topic tabs and
which pages get filtered. Each leak fixed since 1.0 has a regression test here.

```
npm install jsdom
node tests/test.js
```
