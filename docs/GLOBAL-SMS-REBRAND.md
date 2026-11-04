# GLOBAL SMS — panel rebranding

**Scope:** rename + re-skin the existing panel as **GLOBAL SMS**. This was a branding
exercise only — no backend logic, database structure, API, route, rate, balance,
role, permission, workflow or feature was added, removed or re-written.

- Repository: `dawoodtariq762-max/AMS-SMS` (branch `main`, commit `77674a1`)
- Stack found: Node 20 / Express backend (`backend/server.js`, 17 modules, better-sqlite3)
  + 16 static HTML panels (`login`, `admin`, `manager`, `agent`, `client`, `management`,
  `payment`, `panel-sharing`, `test`, `chat`, `branding`) + 24 shared CSS/JS assets.
- Branding engine already present and reused: `backend/branding.js` + `backend/branding-tokens.js`
  (TEXT_DEFAULTS, `/api/branding/public`, generated `/branding/runtime.*`) — its defaults were
  rebranded instead of bypassing it.

---

## 1. Brand identity

**Mark:** a globe (meridians + equator) whose lower-right arc becomes an SMS bubble with
three dots — "global messaging" in one shape. Rounded-square badge, blue gradient
(`#0D3C8C → #155EEF → #0B43BE`) with a soft top-left sheen; the bubble is teal `#00D3BE`.

**Wordmark:** Inter ExtraBold, `GLOBAL` in navy `#0A2540`, `SMS` in a blue→teal gradient.

**Files replaced (same filenames, so every existing `<img>` keeps working):**

| File | Purpose | Format |
|---|---|---|
| `assets/ams-logo-trim.png` | horizontal lockup — all login screens, portal logins | 1440×359, transparent |
| `assets/ams-logo-square.png` | app mark — sidebars, chat header, top bars | 512×512, transparent |
| `assets/ams-favicon.png` | favicon (every page already links it) | 128×128 |

The inline SVG fallback mark in `assets/ams-login-anim.js` and the stub
`branding/runtime.js` were redrawn/updated too, so no old artwork can resurface.

**Palette (used across panel + logins):**

| Token | Hex | Use |
|---|---|---|
| Navy 900 | `#0A2540` | wordmark, headings, dark chrome |
| Blue 700 | `#0B43BE` | hover/pressed states, deep gradients |
| Blue 600 | `#155EEF` | primary buttons, active nav, links, focus rings |
| Teal 500 / 400 | `#00C2B0` / `#00D3BE` | secondary accent, bubble, KPI #3, chart series 2 |
| Page / Line | `#EEF2F9` / `#E2E8F0` | app background, borders |
| Ink | `#0F172A` | body text |

Login scenes are now a navy → blue → teal glow (was indigo/violet/pink). KPI cards are
blue / indigo / teal / amber — the old pink+orange pair is gone, so charts, badges and
tables read as one family.

---

## 2. What changed, file by file

### 2.1 Text branding (47 files, 271 edited lines)

`AMS SMS → GLOBAL SMS`, `AMS-SMS → GLOBAL-SMS`, `AMS-HOST → GLOBAL-SMS-HOST`, and every
remaining bare `AMS` in prose → `GLOBAL`. Zero occurrences of the old name remain
(`grep -r "AMS SMS\|AMS-SMS"` → no hits).

- **Titles / metadata:** every `<title>` (`GLOBAL SMS — Admin Panel`, `Chat — GLOBAL SMS`, …),
  `aria-label`s, `alt` texts, `branding.html` / `branding-login.html` titles.
- **Panels:** sidebar + header brand blocks (`admin`, `manager`, `agent`, `client`,
  `management`, `payment`, `panel-sharing`, `test`), footers, welcome modals, Terms &
  Conditions copy, chat header + `BASE_TITLE`, theme-switch label (`Appearance: Light · GLOBAL SMS`).
- **Backend:** `/health` and `/healthz` `service` field, startup log line, SMPP `bind_resp`
  `system_id` (10 chars, still ≤15), webhook test bodies/User-Agents, T&C modal copy,
  incoming-SMS endpoint description, backup/branding branding-slug fallbacks.
- **Branding engine:** `TEXT_DEFAULTS` = `panelName: 'GLOBAL SMS'`, `shortName: 'GLOBAL'`,
  `loginTitle: 'GLOBAL SMS'`; `/api/branding/public` now answers
  `{"panelName":"GLOBAL SMS","shortName":"GLOBAL","tabTitle":"GLOBAL SMS", …}`.
- **Docs/config:** `docs/PROVIDER-INTEGRATION-GUIDE.md`, `.env.example`, `package.json`
  (`name: global-sms-panel`), `package-lock.json`, `ecosystem.config.js` comments.

### 2.2 Colour pass (24 files, ~560 colour literals)

A scripted, value-only remap of the old brand colours (old blue `#2563eb`/`#0066ff`/`#0088cc`,
indigo `#4f46e5`/`#6366f1`, violet `#8b5cf6`, pink `#ec4899`/`#ff2f62`, cyan `#22d3ee`)
to the new palette, plus the matching `rgba()` triples. Applied to `ams.css`,
`ams-light.css`, `ams-layout.css`, `ams-panel.css`, `ams-ds.css`, `ams-chrome.css`,
`ams-unify.css`, `ams-motion.css`, `ams-login.css`, `ams-login-anim.css`,
`qtech-login-anim.css`, `ams-chat-theme.css`, the panel HTML inline styles, and the
colour *hints* in `backend/branding-tokens.js` (so the Branding panel suggests the new
palette). Semantic colours (success/error/warning/red buttons) were deliberately untouched.

### 2.3 Interface polish (CSS only)

- Appended one clearly-marked block to `assets/ams-unify.css`: the sidebar/top-bar mark is
  now a standalone badge, so the panel name is displayed next to it again
  (`GLOBAL SMS` + role label), with `color:inherit` so it is legible on a white sidebar,
  the navy Payment rail and the dark theme alike. No markup, class or script was changed.
- `login.html`: removed two `<link>`/`<script>` references to `assets/qtech.css` and
  `assets/qtech.js`, which **do not exist in the repository** (404s + console errors on
  every login page load). Nothing else in the file changed.
- `chat.html`: brand `<img>` now points at `ams-logo-square.png` — the chat slot is a
  34×34 box, so the horizontal lockup was being squeezed into an unreadable thumbnail.
- All asset cache-busters bumped (`?v=gsms-20261104`) in 16 HTML files + 1 JS so browsers
  pick up the new artwork and theme instead of serving cached AMS CSS.

### 2.4 Two small, intentional value changes

1. `backend/backup.js` — new backups are named `global-sms-backup-<ts>.sqlite`;
   `ams-`, `qtech-`, `nova-`, `almada-` prefixed files remain listed / restorable / pruned
   (both the prefix list and the filename regex accept them). Verified: a manual backup
   produced `global-sms-backup-2026-11-04T06-44-38-976Z.sqlite`.
2. Range-import sample download renamed `global-sms-range-import-sample.*`, and the
   export/report slug fallback is `global-sms`.

---

## 3. Deliberately **not** changed (functional identifiers / data)

These still contain "ams" on purpose — renaming them would break running installs,
sessions, bookmarks, PM2 or stored data:

| Kept | Why |
|---|---|
| `assets/ams*.css`, `assets/ams*.js` filenames | referenced by every page; renaming = 500+ reference edits with zero user-visible benefit |
| `ams_token`, `ams_role`, `ams_user`, `ams_name`, `ams_theme`, `ams_last_page_*` storage keys | renaming logs every existing session out |
| `window.AMS_BRAND`, `AMSCore`, `AMSDashboard`, `AMSNav`, `AMS_PANEL_MODE`, `ams-sms-logo-img` class | JS API surface used across panels/assets |
| `AMS_ROLE`, `AMS_FTS` env vars, `#ams-and-sms-theme`/`ams-sms-module-theme` DOM ids | runtime configuration / DOM contract |
| **PM2 app name `ams-sms`** | `pm2 restart ams-sms` on the server would otherwise fail or spawn a second process on the same port. Rename manually if you want it: `pm2 delete ams-sms && pm2 start ecosystem.config.js` |
| DB file `backend/data.sqlite`, all tables/columns/records | data integrity |
| default `~/ams-sms-backups` and `~/ams-sms-exports` folders | existing backups/exports stay where the app and cron expect them |
| routes, APIs, SMPP/HTTP provider code, rates, balances, roles | out of scope for a rebrand |

---

## 4. Testing performed

**Runtime:** the panel was started locally (`node backend/server.js`, fresh SQLite, admin +
manager + agent + client + test accounts) and driven with headless Chromium.

| Check | Result |
|---|---|
| 20 page loads: login, admin (light/dark/mobile/drawer), manager, agent, client (desktop/mobile), management (login + panel), payment (login + panel), panel-sharing (login + panel), test (login + panel), chat, branding (login + panel) | all render, titles all `GLOBAL SMS …` |
| Console errors / page errors | **0** |
| HTTP 4xx/5xx while browsing | **0** |
| Every `src`/`href` in all HTML (34 refs) | **200** (the two dead `qtech.*` links are gone) |
| Missing images / broken logos | none — trim lockup on logins, square mark in sidebars/chat, favicon on every page |
| Logo on mobile | sidebar drawer 390 px: 54 px badge + `GLOBAL SMS` + role label, no clipping; text row checked for overflow on all four panels (max right edge 207 px in a 210 px sidebar) |
| Dark mode | brand badge, name, KPI cards, tables and charts all legible |
| API smoke: `/health`, `/api/dashboard`, `/api/sms`, `/api/numbers`, `/api/ranges`, `/api/branding/public`, `/api/legal/status`, `/api/backups` (list + create) | 200, values unchanged |
| Backup naming/restore validation | new `global-sms-` file created and listed; old prefixes still accepted |
| Static analysis: every changed `.js` file compared with the original after stripping comments and string literals | **no logic differences** except the documented `backup.js` prefix constants |

Screenshots of the run are in the workspace at `qa/final/` (before shots in `qa/before/`);
the brand sheet is `docs/GLOBAL-SMS-brand-sheet.png` and the side-by-side comparison is
`brand/before-after.png`.

### Pre-existing issues (present before the rebrand, left as-is)

1. **Test Panel Legal overlay unstyled** — `test.html` doesn't load `ams-chrome.css` /
   `ams-motion.css`, where `.ams-ui-legal-*` is defined, so the Terms gate renders as raw
   text at the bottom of the page. Verified identical on the unmodified checkout.
2. **`Payment Panel` role label is low-contrast** on the navy Payment rail (`.muted`
   inherits a dark brand blue). Same values before the rebrand; fixing it means restyling
   that page's own palette, which was out of scope.
3. `/chat` never reaches a "network idle" state (long-poll); it loads and works normally.

---

## 5. Deployment / rollback

```bash
# deploy the rebrand
git add -A && git commit -m "Rebrand panel as GLOBAL SMS"   # done locally in this workspace
git push origin main

# on the server
git pull
pm2 restart ams-sms --update-env      # PM2 name unchanged on purpose
```

- No migration, no schema change, no new env var required.
- Existing `data.sqlite`, users, numbers, records, rates and balances are untouched.
- Rollback: `git revert` / `git checkout 77674a1 -- .` and restart — nothing outside the
  repository was modified. The three logo PNGs are the only binary changes.
- After pulling, users may need one hard refresh (cache-busters were bumped, so normally
  a normal reload is enough).
