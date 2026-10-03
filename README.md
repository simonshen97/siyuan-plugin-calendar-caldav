# SiYuan Calendar (CalDAV) plugin

> ## 🤖 Development and copyright notice
>
> **This plugin was developed with the assistance of DeepSeek HARNESS (DSH).**
>
> - **How it was built** — requirements, architecture, implementation, testing and debugging were all
>   driven by DeepSeek HARNESS, with a human defining the requirements and accepting the result.
>   The code was **not reviewed line by line by a human**; please assess for yourself whether it meets
>   your data-safety and compliance requirements before use.
> - **License** — the plugin source is released under the **MIT License**; you may use, modify and
>   redistribute it freely (see “License” at the end of this document).
> - **Copyright** — the plugin code is copyright its contributors. DeepSeek HARNESS is a development
>   tool and **is not itself open-source software** (the bundled licenses cover third-party components
>   such as Electron and Chromium only); this notice states how the plugin was built and implies no
>   open-source commitment or endorsement by DSH.
> - **Third-party dependencies** — the open-source libraries used here (`ical.js`,
>   `fast-xml-parser`, …) remain under their own licenses.
>
> *This notice sits at the top of the README so users can see it before installing.*

A **native calendar view** for SiYuan, wired into the calendar services you already use:

- **Read** — show events and tasks from any CalDAV service (Nextcloud, Radicale, Baikal, iCloud, Fastmail, Synology, QQ Mail, WeCom, Vikunja, …) inside SiYuan;
- **Write** — create / drag / edit events on the calendar and push the changes back to the server;
- **Aggregate** — write events from every source as rows of a SiYuan **database block** (attribute view);
- **Local** — use a SiYuan database (attribute view) or a SQL query as a calendar source.

> Current version **0.6.9**. Requires SiYuan **3.1.0** or newer.

---

## Table of contents

1. [Install](#1-install)
2. [Quick start](#2-quick-start)
3. [Interface and operations](#3-interface-and-operations)
4. [Settings reference](#4-settings-reference)
   - [4.1 Add CalDAV account](#41-add-caldav-account)
   - [4.2 SiYuan sources](#42-siyuan-sources)
   - [4.3 Database sync](#43-database-sync)
   - [4.4 Sync](#44-sync)
   - [4.5 View](#45-view)
   - [4.6 Advanced](#46-advanced)
5. [How it works](#5-how-it-works)
6. [Multi-application compatibility](#6-multi-application-compatibility)
7. [FAQ](#7-faq)
8. [Known limitations](#8-known-limitations)
9. [Project layout](#9-project-layout)
10. [Development and release](#10-development-and-release)
11. [References](#11-references)
12. [License](#12-license)

---

## 1. Install

### 1.1 From the marketplace (recommended)

SiYuan → “Settings → Bazaar → Downloaded → Install package”, then pick the plugin archive.

### 1.2 Manual install

1. Unpack the release so that you get a directory `siyuan-plugin-calendar-caldav/`
   (the archive already has exactly this single top-level directory — just extract it);
2. Put the whole directory under your workspace `data/plugins/`
   (**the directory name must match `name` in `plugin.json` exactly**):

   ```
   <workspace>/data/plugins/siyuan-plugin-calendar-caldav/
   ```

3. SiYuan → “Settings → Bazaar → Downloaded” → enable the plugin (or restart SiYuan).

### 1.3 Docker / browser builds

In the Docker image the workspace usually lives at `/siyuan/workspace`, so:

```bash
docker cp siyuan-plugin-calendar-caldav <container>:/siyuan/workspace/data/plugins/
```

Or drop it into the mounted workspace on the host:

```
<host-workspace>/data/plugins/siyuan-plugin-calendar-caldav/
```

Then **restart the container** (or refresh “Settings → Bazaar → Downloaded”).

> **What is “marketplace package manifest not found”?**
> It is SiYuan's own archive-layout check (`kernel/bazaar/local.go`): the manifest
> (`plugin.json`) must sit at the **archive root** or inside the archive's **only top-level
> directory**. A flat archive (`plugin.json` next to `i18n/`, `README.md`, …) or an extra
> nesting level (`xxx/siyuan-plugin-calendar-caldav/plugin.json`) makes local installs — Docker
> especially — fail with that message. Since **v0.6.7** this plugin is packaged the required way,
> and both `scripts/zip.mjs` and `scripts/check-consistency.mjs` validate the layout to prevent
> regressions.

> **What is “this plugin does not support the current terminal”?**
> The client compares the **current frontend** against the `frontends` whitelist in the manifest and
> refuses to enable the plugin on a mismatch (see `IsIncompatiblePlugin` in
> `kernel/bazaar/plugin.go`). The easy trap: **SiYuan has no `browser` frontend value** — the valid
> ones are `desktop`, `desktop-window`, `mobile` and `all`. Declaring `"browser"` therefore never
> matches, and Docker accessed through a browser fails with that message. Since **v0.6.8** this
> plugin declares `frontends: ["all"]`, which covers desktop, desktop-window, mobile and Docker
> browser access; both `src/plugin-manifest.test.ts` and `scripts/check-consistency.mjs` reject
> invalid values.

### 1.4 Build from source

```bash
npm install

node scripts/build.mjs     # compiles into .package/siyuan-plugin-calendar-caldav/
node scripts/zip.mjs       # produces .package/siyuan-plugin-calendar-caldav.zip
```

Other scripts:

| Command | Purpose |
| --- | --- |
| `node scripts/dev.mjs` | Watch sources and rebuild incrementally |
| `node scripts/check-consistency.mjs` | Consistency gate (zh_CN/en_US key parity, dead code, …) |
| `npx tsc --noEmit` | Type check |
| `npx vitest run` | Unit tests |

Node.js 18+ required (20 / 22 recommended).

---

## 2. Quick start

Three of the most common setups.

### 2.1 Nextcloud / Radicale / Baikal / iCloud (standard CalDAV)

1. Open the calendar panel → “**Settings**” at the bottom → the “**Add CalDAV account**” tab;
2. Fill in:

   | Field | Notes |
   | --- | --- |
   | Name | Anything; used to tell accounts apart |
   | Server URL | The CalDAV root, e.g. `https://cloud.example.com/remote.php/dav` |
   | Username | Usually your login name or e-mail |
   | Password / Secret name | See “Credentials” below |

3. Press “**Test connection**”, then “**Discover calendars**”;
4. Back in the calendar panel the sidebar lists every calendar — tick the ones you want.

**Credentials** (pick either):

- **Secret name (recommended)** — create a secret in “SiYuan Settings → Key and variables” and put the
  **secret name** here. The password never lands in the plugin configuration, so exporting your config is safe.
- **Password** — typed directly. Note this stores the password in plain text in the plugin configuration.

> iCloud / Fastmail / QQ Mail / WeCom require an **app-specific password** or an **authorisation code**.
> Using your normal login password will fail authentication.

### 2.2 QQ Mail

QQ Mail does not return a calendar collection list, so the collection URL must be given manually:

| Field | Value |
| --- | --- |
| Server URL | `https://dav.qq.com/calendar/` |
| Username | your QQ Mail address |
| Password | the **authorisation code** generated in QQ Mail settings |
| Manually specified calendar collections | `https://dav.qq.com/calendar/<your-mailbox>/<calendar-name>/` |

Collection names are opaque IDs (e.g. `F23EXAMPLEopaque~i~8zRqAQAS`); copy them from a working mobile app.
**Keep the tilde `~` as-is** — replacing it with `%7E` breaks the request.

### 2.3 WeCom (Enterprise WeChat)

| Field | Value |
| --- | --- |
| Server URL | `https://caldav.wecom.work/calendar/` |
| Username / Password | your WeCom account |

WeCom answers the root path with 403 + HTML; the plugin automatically follows `/.well-known/caldav`
to find the real CalDAV root.

### 2.4 Vikunja

Vikunja is a **tasks-only (VTODO), no-events (VEVENT)** service:

| Field | Value |
| --- | --- |
| Server URL | `http://<host>:<port>/dav/projects/<project-id>/` |
| Username / Password | your Vikunja account; an **API token is recommended** (mandatory for 2FA / OIDC accounts) |

Because such calendars only accept tasks, pushing an **event** into them is skipped automatically
(the log states the reason). That is expected behaviour.

---

## 3. Interface and operations

### 3.1 Opening the calendar

Three entry points:

- the calendar icon in the top bar;
- the calendar dock (right side);
- the command palette: `Open calendar view`, `Sync calendars now`, `New calendar event`
  (no default hotkeys — bind them in “Settings → Keymap”).

### 3.2 Sidebar (calendar list)

- **Ticked** = shown and synced; **unticked** = disabled (hidden and no requests at all);
- disabled calendars move into the collapsed “**Disabled (N)**” group and can be re-enabled anytime;
- the sidebar toggles are **per calendar**, and the state is **persisted** across restarts.

> Mind the difference: the “Enabled” switch inside an account card in Settings controls the
> **whole account**, while the sidebar ticks control **individual calendars**.

### 3.3 Bottom bar of the calendar

| Button | Purpose |
| --- | --- |
| **Sync** | Runs one sync according to “Sync → Default direction” |
| **Refresh** | Re-fetches only the current view range, ignoring caches |
| **Settings** | Opens the settings dialog |

With “Advanced → Debug mode” enabled, **Sync** splits into three buttons for step-by-step debugging:

| Button | Purpose |
| --- | --- |
| **Write in** | Only write CalDAV / local-source content into SiYuan (database rows or documents) |
| **Pull out** | Only push SiYuan changes back to the server |
| **Sync** | Full two-way sync (same as plain “Sync”) |

### 3.4 Working with events

- **Create** — click/drag on a day cell, or use “New calendar event”;
- **Edit** — click an event to open the editor (title, start/end, all-day, repeat, alarm, location, URL, description);
- **Drag** — move an event to change its time (the target calendar must be writable);
- **Jump** — open the corresponding SiYuan item from the event details.

---

## 4. Settings reference

Open with **calendar panel → “Settings”** at the bottom. There are six tabs.

> Every edit is applied to memory immediately and **saved when the dialog closes**.

### 4.1 Add CalDAV account

**Purpose** — manage CalDAV accounts and discover the calendar collections inside them.

Each account is a card with these fields:

| Field | Notes |
| --- | --- |
| **Name** | Display name. It is written into the database as the **Source column**, so pick something distinguishable (“QQ Mail”, “WeCom”, “Vikunja”) |
| **Server URL** | CalDAV root. The plugin tries it directly; on 403 it follows `/.well-known/caldav` instead |
| **Username** | CalDAV login (usually an e-mail address) |
| **Password** | Plain password / app-specific password / authorisation code. Stored in the plugin configuration |
| **Secret name (recommended)** | Use a secret from “SiYuan Settings → Key and variables”; the password is then not stored on disk |
| **Auth type** | `Basic` (default) or `Bearer` (API token, e.g. Vikunja) |
| **Enabled** | Master switch for the **whole account**. When off, none of its calendars are visible and no requests are made |
| **Manually specified calendar collections** | Comma/newline separated list of collection URLs, for servers without a working discovery flow (required for QQ Mail) |

Buttons on the card:

| Button | Purpose |
| --- | --- |
| **Test connection** | Validates URL and credentials only; saves no calendars |
| **Discover calendars** | Standard discovery (current-user-principal → calendar-home-set → enumerate collections) |
| **Delete account** | Removes the account and cleans up its sync mappings |

**Tip** — `Enabled` is account-level and does **not** overlap with the per-calendar sidebar ticks.

### 4.2 SiYuan sources

**Purpose** — use SiYuan's own data as calendar sources (**read-only**; your data is never modified).

| Button | Purpose |
| --- | --- |
| **Bind database (attribute view)** | Pick a database block and use its **date column** as the timeline; each row is an event |
| **Add SQL query source** | Write SQL and use the result set as the event list |

**Fields when binding a database:**

| Field | Notes |
| --- | --- |
| **Database ID** | The attribute-view ID, or the ID of the **block containing the database** (both accepted; the plugin resolves it) |
| **Date field** | Drives the calendar layout (required) |
| **Title field** | Column used as the event title |
| **Detect fields** | Reads every column and fills the dropdowns above |

**Fields when adding a SQL query source:**

| Field | Notes |
| --- | --- |
| **SQL statement** | e.g. `SELECT * FROM blocks WHERE type = 'd' AND ial LIKE '%custom-due%'` |
| **Start date attribute (custom-\*)** | Which column/attribute supplies the start time |
| **End date attribute (optional)** | Source for the end time |

**Important** — SiYuan sources are **read-only**. Editing such an event on the calendar does **not** write back.

### 4.3 Database sync

**Purpose** — write events from every source as **rows of a SiYuan database block** (attribute view), so one
database with a calendar view manages all your schedules.

This is the most powerful — and the most configurable — feature of the plugin.

#### 4.3.1 Basic configuration

| Field | Notes |
| --- | --- |
| **Database block ID** | ID of the block holding the target database. Right-click the database → “Copy block ID” (e.g. `20240118120204-kwyzf77`) |
| **Read fields** | Parses every column so the dropdowns below get options. **On success with a date column bound, this tab is enabled automatically** |
| **Enable database sync** | Master switch. When off, syncing is read-only and **writes nothing to the database** (the log shows `target=read-only`) |
| **Sync direction** | `Read-only aggregation: remote → database` (recommended) or `Two-way: database edits are pushed back` |

> ⚠ **Switch trap** — if a database is bound and a date column is chosen but “Enable database sync” is
> unticked, syncing runs perfectly yet **writes nothing**. The top of this tab and the detection result
> both show a prominent warning in that case.

#### 4.3.2 Column mapping

After “Read fields” succeeds, map column by column.
**Only bound columns are written; unbound columns are never touched.**

| Binding | Written value | Advice |
| --- | --- | --- |
| **Date column** | Event start time | **Required** — the calendar view lays out by this column |
| **Title column / event name** | Event title | Recommended (text column) |
| **End time column** | Event end time | Optional |
| **Description column** | Event description | Optional |
| **Location column** | Event location | Optional |
| **Source column** | Account name (or source name) | Recommended, to tell QQ / WeCom / Vikunja apart in one database |
| **Unique ID column** | Remote UID | Optional, handy for manual verification |
| **Plugin marker column** | `caldav:<remote UID>` | **Strongly recommended**, see below || **Status column** | Task status text (e.g. `NEEDS-ACTION`) | Optional; **do not bind a checkbox column** (a checkbox cannot express multiple states and is skipped) |

#### 4.3.3 The “plugin marker” column (important)

The plugin uses this column to decide **which rows are its own**:

- **non-empty** and starting with `caldav:` → the row is plugin-managed and may be updated/deleted;
- **empty** → a row you wrote by hand; it is **never overwritten or deleted**;
- as a bonus you can tell at a glance which remote event a row corresponds to.

**How to configure it:**

1. Add a **new column** to the database (any name; “plugin marker” is a good one), type **Text**;
2. “Read fields” → bind the “plugin marker column” to it.

> The plugin still works without it, falling back to block attributes on the row block. But a freshly
> created row may not be in SiYuan's block tree yet, so writing attributes fails with the kernel error
> `tree not found` and those rows become unrecognised orphans. **So please bind it.**

> Also note: database rows are detached blocks — deleting a row deletes a block. Keep your own backups.

### 4.4 Sync

**Purpose** — control direction, range, conflict policy and where local content is stored.

| Field | Default | Notes |
| --- | --- | --- |
| **Default direction** | `Two-way` | `Two-way` syncs both sides; `CalDAV → SiYuan` is read-only; `SiYuan → CalDAV` only uploads; `Off` disables sync |
| **Conflict policy** | `Keep both (save a copy)` | Used when both sides changed the same event: `Remote wins` / `Local wins` / `Keep both (save a copy)` / `Skip` |
| **Sync past days** | `90` | How far back to pull (0–3650) |
| **Sync future days** | `180` | How far ahead to pull (0–3650) |
| **Auto-sync interval (minutes, 0 disables)** | `15` | Periodic sync; `0` turns it off |
| **Document path template** | `/日历/${yyyy}/${MM}` | Path template used when events are written as documents (needs a target notebook). `${yyyy} ${MM} ${dd} ${title}` are available |
| **Target notebook** | *(empty)* | **Empty = read-only, no SiYuan documents are created**; pick one to write events as documents |
| **Push SiYuan items that have no remote counterpart** | off | When on, SiYuan items without a remote mapping are pushed as remote events. Off by default (avoids mis-pushes) |
| **Remove the SiYuan attribute when the remote event is deleted** | off | When on, a remote deletion also clears the sync attributes on the SiYuan item; otherwise only the mapping is dropped |
| **Custom attribute prefix** | `custom-` | Prefix for the custom attributes written onto SiYuan blocks |

**Where does local content go?** (mutually exclusive; the database wins)

| Goal | Configuration |
| --- | --- |
| Aggregate into one database (recommended) | Configure **4.3 Database sync** and enable it; leave “Target notebook” empty |
| One document per event | Pick a “Target notebook”; leave 4.3 disabled |
| Read-only | Configure neither → syncing never modifies SiYuan content |

### 4.5 View

**Purpose** — the calendar's appearance and interaction habits.

| Field | Default | Notes |
| --- | --- | --- |
| **Default view** | `Month` | View used when the panel opens: `Month` / `Week` / `Day` / `Agenda` |
| **Week starts on** | `Monday` | Sunday … Saturday |
| **Show lunar dates** | on | Show the lunar date in day cells |
| **Show week numbers** | on | Show ISO week numbers at the side |
| **Show time in month view** | on | Whether month cells show event times |
| **Highlight today** | on | Highlight the current day |
| **Time format** | `24-hour` | `24-hour` / `12-hour` |
| **Density** | `Comfortable` | `Comfortable` / `Compact` |
| **Default event duration (minutes)** | `60` | Default duration for new events (5–1440) |

> The settings `view.allDayLane` (all-day lane on the week view) and `view.defaultAlarm` (default alarm)
> are **not exposed in the UI yet**; they use built-in defaults and can be tweaked by editing an exported
> configuration file.

### 4.6 Advanced

**Purpose** — network parameters, logging/debugging, and configuration import/export.

| Field | Default | Notes |
| --- | --- | --- |
| **Request timeout (ms)** | `30000` | Timeout of a single CalDAV request (3000–300000) |
| **Sync concurrency** | `4` | Parallel requests during sync (1–16). Lower it if the server rate-limits |
| **Debug log** | off | Records more detailed entries into the plugin log buffer |
| **I understand the kernel may need to accept self-signed certificates** | off | Informational only; self-signed certificates require starting SiYuan with `--skip-tls-verify` or trusting the certificate locally |
| **Debug mode** | off | See below |

Buttons:

| Button | Purpose |
| --- | --- |
| **View plugin logs** | Opens the log window (copy all, clear, **export to file**) |
| **Open SiYuan system log** | Pushes one log entry to “Settings → About → System log” |
| **Export to file** | Writes the current log to a file, handy when reporting issues |

#### Debug mode

Turning it on:

1. **Records verbose logs** (same as “Debug log”, plus request/response bodies);
2. Splits the calendar's sync bar into **Write in / Pull out / Sync** for step-by-step debugging;
3. Unlocks two **cleanup actions**:

| Button | Purpose | Safety |
| --- | --- | --- |
| **Purge database rows (created by this plugin)** | Deletes rows whose “plugin marker” column is `caldav:…` | Rows you wrote by hand are **untouched** |
| **Clear sync mappings** | Drops the link between SiYuan items and remote events | **Deletes nothing on either side**; mappings are rebuilt on the next sync |

#### Configuration import/export

| Button | Purpose |
| --- | --- |
| **Export to workspace** | Writes the configuration as JSON into `data/storage/petal/siyuan-plugin-calendar-caldav/` (falls back to copying to the clipboard) |
| **Copy to clipboard** | Copies the configuration JSON directly |
| **Import and overwrite** | Replaces the whole configuration with the JSON in the text box, effective immediately |

The export covers accounts, sources, database bindings, view and advanced options.
**Passwords stored via secrets are not exported** (only the secret name is).

#### Getting the logs

To report a problem, use “**View plugin logs → Export to file**”; the file lands in:

```
data/storage/petal/siyuan-plugin-calendar-caldav/calendar-caldav-log-<timestamp>.log
```

It carries full date + millisecond timestamps and a header with the plugin version and system info,
so it can be sent to the maintainer as-is.

---

## 5. How it works

```
┌────────────┐   HTTP(S)    ┌──────────────┐
│ CalDAV     │◀────────────▶│ SiYuan kernel│
│ server     │              │ forwardProxy │
└────────────┘              └──────┬───────┘
                                   │ plugin API
                            ┌──────▼───────┐
                            │ this plugin  │
                            │  · CalDAV client
                            │  · iCalendar parsing
                            │  · sync engine
                            └──────┬───────┘
                                   │ kernel API
                     ┌─────────────┴─────────────┐
                     │                           │
              ┌──────▼──────┐            ┌───────▼───────┐
              │ database    │            │ SiYuan doc    │
              │ (AV rows)   │            │ (one per event)│
              └─────────────┘            └───────────────┘
```

### Why requests must go through the kernel

SiYuan plugins run in the Electron renderer. A direct `fetch` to a CalDAV host is blocked by CORS and
has no access to the system certificate store. All CalDAV traffic therefore goes through the kernel's
`/api/network/forwardProxy`.

### How changes are detected

- The “remote event ↔ SiYuan item” correspondence is kept in **sync mappings**;
- the remote side is tracked with `ETag` plus a content hash, the local side with a projection hash;
- conflicts (both sides changed) follow “Sync → Conflict policy”;
- **window guard** — only events inside “past N days … future M days” take part, so events outside the
  window are never mistaken for deletions;
- a remote **404/410** means “the resource is gone”: the plugin automatically switches to **create**
  (self-healing) instead of retrying the update forever.

---

## 6. Multi-application compatibility

CalDAV / iCalendar implementations differ wildly, so the plugin layers several fallbacks.

### ① Task (VTODO) support

Vikunja-class servers have **tasks but no events**. The plugin:

- reads `supported-calendar-component-set` to learn whether a calendar accepts `VEVENT` or `VTODO`;
- parses `VTODO` (including a `DUE` fallback, `STATUS`, `PERCENT-COMPLETE`);
- **never** pushes an event into a tasks-only calendar (the log says
  “this calendar only supports tasks, cannot write an event”), avoiding bogus writes.

### ② Event retrieval: layered request strategy

Each calendar is tried in order; the first working variant is cached:

1. `calendar-query` (`VEVENT` + time range);
2. `calendar-query` (`VEVENT` + `VTODO` + time range);
3. `calendar-query` without a time range;
4. `getetag` only, fetching bodies later;
5. if `REPORT` returns no resources at all → fall back to `PROPFIND` enumeration of `.ics`;
6. if `multiget` fails → fall back to per-resource `GET` (bounded concurrency).

### ③ Data normalisation

| Malformed input | Handling |
| --- | --- |
| CRLF inside `calendar-data` encoded as XML entities `&#x0D;&#x0A;` (QQ Mail) | Decode entities before parsing |
| Response without `resourcetype` (QQ Mail returns only `displayname`) | Accept the home collection as a calendar |
| Non-standard `TZID` (`TZ08`, `CST8`, `Xmail Custome Time`) | Read `TZOFFSETTO` from `VTIMEZONE` and convert wall-clock times |
| Relative `href` missing the mount prefix (Vikunja's `/dav/…` really lives at `/api/v1/dav/…`) | Re-root using the actual request URL |
| `multiget` requires `Depth: 0` (WeCom returns 403 for `Depth: 1`) | Always send `Depth: 0` |

### ④ Server differences at a glance

| Service | Key differences |
| --- | --- |
| **QQ Mail** | No calendar discovery (collections must be entered manually); CRLF as XML entities; opaque collection IDs; `~` must not be escaped |
| **WeCom** | Root returns 403 + HTML (needs `.well-known`); ignores time ranges; `multiget` needs `Depth: 0`; `calendar-data` may 404 inside `REPORT` (per-resource `GET` required) |
| **Vikunja** | `VTODO` only; ignores time ranges; no `sync-collection`; `href` lacks the mount prefix |
| **Nextcloud / Radicale / Baikal** | Standard implementations, work out of the box (Radicale may ignore `If-Match`) |

### ⑤ If an application still shows no events

1. Enable “Advanced → Debug mode”;
2. Sync once, then “View plugin logs → Export to file”;
3. The log shows the outcome of every `REPORT` variant (empty result / no `calendar-data` / resource count)
   together with response bodies — enough to pinpoint the cause.

---

## 7. FAQ

**Q: Sync fails with “push failed (…): update failed (HTTP 500)”**

Most likely an **event** was pushed into a **tasks-only** calendar; services like Vikunja answer `VEVENT`
with 500. The plugin now skips those automatically (the log says “this calendar only supports tasks…”).
If stale mappings remain, use “Advanced → Clear sync mappings” and sync again.

**Q: Nothing changes after a refresh, or requests repeat endlessly?**

Remote caches live 30 seconds and local sources 3 seconds, so frequent local edits do not re-hit the server.

**Q: The calendar is empty even though the sidebar lists calendars**

- make sure the calendar is **ticked** in the sidebar;
- make sure events fall inside “Sync past / future days”;
- enable debug mode and check the resource count for that calendar in the log.

**Q: Database sync runs fine but writes nothing**

Check “Database sync → Enable database sync”. When it is off the log shows `target=read-only` and the top
of the tab displays a prominent warning. Pressing “Read fields” enables it automatically.

**Q: I delete database rows, and the next sync re-creates them**

That is **expected**: deleting a row only removes the local item; the remote event still exists, so the
next sync pulls it back. To delete permanently, delete the remote event as well.

**Q: I switched to a new database and the fields cannot be read**

Enter the new block ID and press “Read fields”. The plugin automatically discards the **view ID belonging
to the old database**, retries, and lists the new columns; it also clears the old column bindings (so it
cannot write into stale columns). Re-select the columns and enable again.

**Q: Can the password leak?**

Not with the “Secret name” approach (only the secret name is stored). With a typed password, the password
is stored in plain text in the plugin configuration — **switch to secrets before sharing an exported config**.

**Q: What does `tree not found` mean?**

It is the kernel saying “this block is not in the block tree index yet”. Once the “plugin marker” column is
bound, the plugin no longer writes row block attributes, and the error disappears entirely.

**Q: Where is the sync entry point in the status bar?**

The bottom-right status-bar item was removed in v0.6.6 (its font/colour did not match the system).
The sync entry points are the **bottom of the calendar panel** and the top-bar icon.

---

## 8. Known limitations

| Limitation | Notes |
| --- | --- |
| No Digest auth | Only Basic / Bearer |
| Recurring event edits | Changes apply to the **whole series**; “this occurrence only” is not supported yet |
| Alarms (VALARM) | Parsed but **not delivered**; no SiYuan notifications |
| Time-zone database | No bundled IANA tz data; relies on `ical.js` and `VTIMEZONE`; non-standard `TZID`s are approximated by offset |
| Proxy payload cap | The kernel's `forwardProxy` allows roughly 32 MiB per request |
| SiYuan document index | At most 5000 documents scanned per pass |
| Radicale-class servers | May ignore `If-Match`, so concurrent writes can overwrite |
| OIDC / 2FA accounts | Vikunja and similar require an API token |
| Deleting database rows | Rows are detached blocks — deleting a row deletes a block; keep your own backups |

---

## 9. Project layout

```
siyuan-plugin-calendar-caldav/
├── plugin.json                 # Manifest (name/version/backend support)
├── icon.png / preview.png      # Bazaar icon and preview
├── README.md / README_zh_CN.md # Documentation
├── src/
│   ├── index.ts                # Entry point: dock / commands / top bar / icons
│   ├── types.ts                # All type definitions
│   ├── settings.ts             # Defaults and normalisation
│   ├── caldav/
│   │   ├── client.ts           # CalDAV client (discovery / query / write / sync token)
│   │   ├── adapter.ts          # Source adapter (capabilities, ownership, body backfill)
│   │   ├── ics.ts              # iCalendar parsing and generation (VTODO, time zones, recurrence)
│   │   └── manual.ts           # Manually specified calendar collections
│   ├── kernel/api.ts           # Kernel API wrappers (including forwardProxy)
│   ├── siyuan/
│   │   ├── avStore.ts          # Attribute-view reading
│   │   ├── avRowStore.ts       # Database row create/update/delete
│   │   └── avLocalStore.ts     # Database rows as a sync target
│   ├── sync/engine.ts          # Sync engine (pull / push / conflicts / deletion)
│   ├── state/                  # View state, sync mappings, source interfaces
│   ├── ui/                     # Calendar view, dock, settings, dialogs
│   ├── util/                   # Dates, logging, i18n, misc
│   └── i18n/                   # zh_CN.json / en_US.json
├── scripts/                    # build / zip / dev / consistency check
├── tests & *.test.ts           # vitest unit tests (259 of them)
└── .package/                   # Build output
```

---

## 10. Development and release

### Common commands

```bash
npx tsc --noEmit                    # type check
npx vitest run                      # unit tests
node scripts/check-consistency.mjs  # consistency gate
node scripts/build.mjs              # build
node scripts/zip.mjs                # package
```

### Pre-release checklist

1. `npx tsc --noEmit` passes;
2. `npx vitest run` passes completely;
3. `node scripts/check-consistency.mjs` passes (zh_CN and en_US must have the same key count);
4. `version` in `plugin.json` has been bumped;
5. every new UI string exists in **both** `src/i18n/zh_CN.json` and `en_US.json`;
6. `README.md` and `README_zh_CN.md` are updated in sync;
7. the `plugin.json` inside the archive produced by `node scripts/zip.mjs` shows the right version.

### Publishing to the marketplace: flow and prerequisites

> 📘 **The step-by-step manual lives in [PUBLISHING.md](PUBLISHING.md)** at the repository root
> (including a ready-to-copy listing request).
>
> The Bazaar is SiYuan's official marketplace; its index lives in
> [`siyuan-note/bazaar`](https://github.com/siyuan-note/bazaar). It **does not host your archive** —
> packages are distributed from object storage by `owner/repo@commit`, so your source must already
> live in a public repository.

#### Accounts and resources you need

| Item | Required? | Notes |
| --- | --- | --- |
| **GitHub account** | ✅ **Required** | ① the plugin source must live in a public repo; ② the listing is submitted as a PR (or issue) against `siyuan-note/bazaar` |
| **Public plugin repository** | ✅ **Required** | Packages are pulled by repo + commit hash; private repos cannot be distributed |
| Developer portal / official account | ❌ Not needed | The Bazaar runs on GitHub's community flow — there is no separate developer backend |
| Domain / server | ❌ Not needed | Unless you want to self-host an `updateUrl` feed (optional) |
| Sponsorship accounts | ⭕ Optional | Only if you want a funding link on the card |

#### Submission flow

1. **Fill in the manifest fields** (table below) — `url` in particular must point at your repository;
2. **Create a public repository** and push the source; keep `plugin.json` and `README*.md` at its root,
   and make sure `plugin.json`'s `name` matches the install directory name;
3. **Tag a release / note the commit hash** — the Bazaar is **hash-driven**: after pushing new commits
   the index must point at the new hash, otherwise users keep getting the old build;
4. **Submit against `siyuan-note/bazaar`** — follow the template and open a Pull Request (or issue)
   with the repository URL, package name and current commit;
5. **Wait for community review and merge** — once merged the index updates and users can find and
   install the plugin from the Bazaar;
6. **Future updates** — bump `version`, push the new commit, then submit the index update again.

#### Pre-submission self-checks (automated in this project)

| Check | Enforced by |
| --- | --- |
| Manifest fields complete and values valid | `scripts/check-consistency.mjs` |
| Archive is “single top-level directory containing the manifest” | `scripts/zip.mjs` + consistency check |
| No test configuration / credentials / personal data | consistency check (secret scan) |
| zh_CN and en_US key parity | consistency check |
| Types and unit tests green | `tsc --noEmit` + `vitest run` |

#### About “test configuration”

Neither `plugin.json` nor the build output contains any runtime configuration (a secret scan now
enforces this). The accounts and database bindings you set up while testing live in the **workspace**:

```
<workspace>/data/storage/petal/siyuan-plugin-calendar-caldav/settings.json
```

Reinstalling the plugin therefore does **not** wipe your own configuration — that is by design. To
start from scratch, disable the plugin, delete that file (or the whole
`petal/siyuan-plugin-calendar-caldav/` directory) and enable it again.

### Placeholder fields to fill in before publishing

These fields in `plugin.json` are **placeholders**; replace them before an official release:

| Field | Current value | Notes |
| --- | --- | --- |
| `url` | *(empty)* | Plugin repository URL; the Bazaar uses it for the “source” link |
| `updateUrl` | *(empty)* | Self-hosted update feed; leave empty to update via the Bazaar only |
| `author` | `SiYuan Calendar CalDAV Contributors` | Consider using your own name |
| `funding.custom` | `[]` | Array of sponsorship links, if you want one |

The archive contains a single top-level directory `siyuan-plugin-calendar-caldav/` (10 entries):

```
siyuan-plugin-calendar-caldav/
├── plugin.json          # manifest (must live inside the top-level directory)
├── index.js             # bundle with inlined CSS
├── index.css
├── icon.png
├── preview.png
├── README.md
├── README_zh_CN.md
└── i18n/
    ├── zh_CN.json
    └── en_US.json
```

> The layout is enforced by tooling: `scripts/zip.mjs` refuses to build unless there is exactly
> one top-level directory containing the manifest whose `name` matches the directory name, and
> `scripts/check-consistency.mjs` re-checks it before release.

### UI copy conventions

- highlighted states must **never use white text** (unreadable on both dark and light themes) — use
  `--cc-highlight` plus bold instead;
- Chinese copy uses 「」 quotes, English uses “ ”;
- every user-visible string must go through `t()` — no hard-coded text.

---

## 11. References

- [RFC 4791 — CalDAV](https://datatracker.ietf.org/doc/html/rfc4791)
- [RFC 4918 — WebDAV](https://datatracker.ietf.org/doc/html/rfc4918)
- [RFC 5545 — iCalendar](https://datatracker.ietf.org/doc/html/rfc5545)
- [RFC 6578 — WebDAV Sync](https://datatracker.ietf.org/doc/html/rfc6578)
- [RFC 6764 — CalDAV service discovery](https://datatracker.ietf.org/doc/html/rfc6764)
- [SiYuan kernel API docs (community-maintained)](https://leolee9086.github.io/siyuan-kernelApi-docs/)
- [SiYuan plugin development docs](https://github.com/siyuan-note/siyuan/blob/master/API.md)

---

## 12. License

MIT
