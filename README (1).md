# Live CT Dashboard

A static dashboard that reads live data straight from your Google Sheet.
**No Apps Script involved** — it uses Google's built-in "gviz" query
endpoint (the same mechanism Google Charts uses internally), which lets a
plain webpage ask the sheet questions like "orders per hub, grouped and
averaged" and get an instant answer back.

Your existing Apps Script (Base Dump sync, etc.) is completely untouched.

## 1. One-time setup on the sheet

The spreadsheet must stay shared as **"Anyone with the link → Viewer"**.
(You've already confirmed this is on.) This lets the dashboard read the
data with no login. It does mean anyone with the exact sheet link could
also view the raw data — same as any other "view" link.

## 2. Deploy to GitHub Pages

1. Create a new repo (or use an existing one) and add these three files
   to the root: `index.html`, `style.css`, `app.js`.
2. Go to repo **Settings → Pages**, set source to your default branch
   (`main`), folder `/root`.
3. GitHub will give you a URL like
   `https://<your-username>.github.io/<repo-name>/` — that's your live
   dashboard.

No build step, no dependencies to install — it's plain HTML/CSS/JS.

## 3. How it works

- `app.js` sends small SQL-like queries (`SELECT ... GROUP BY ...`)
  directly to the sheet via a script tag (JSONP), so there's no CORS
  issue and nothing runs on a server you have to maintain.
- The sheet itself does the grouping/averaging — the browser never
  downloads all 25k+/230k+ rows, only the small aggregated result.
- The dashboard auto-refreshes every 5 minutes (`REFRESH_MS` in
  `app.js`). Your sheet's own import cycle is every 15 minutes, so
  there's no point refreshing faster than that.

## 4. Things worth checking before you rely on this

- **Units on `creation_to_accept` / `Reach to intent` / `BTS`**: the
  dashboard displays these exactly as stored in the sheet. I couldn't
  confirm from the sample data whether they're in minutes or hours —
  check a few known-good rows and, if needed, multiply in `app.js`
  (search for `fmtNum(avgAccept)` etc.) to convert to the unit you want
  displayed.
- **Breach % thresholds**: the hub/rider tables color a row red above
  8% breach and amber above 4% — arbitrary starting points, adjust the
  numbers in `app.js` (`pct > 8`, `pct > 4`) to match your actual SLA
  targets.
- **Sheet ID / tab IDs**: hardcoded at the top of `app.js`
  (`SHEET_ID`, `ORDERS_GID`, `RIDER_GID`). If you ever move the data to
  a new sheet or the Base Dump sync recreates the tab with a new gid,
  update these three constants.
- **Scale**: gviz queries are aggregated sheet-side so this stays fast
  even as your Base Dump grows toward 230k rows — but very large
  `GROUP BY` results (e.g. if you have hundreds of distinct hubs) are
  capped with `LIMIT 20`/`LIMIT 25` in the queries; raise those in
  `app.js` if you want the full list.

## 5. What's included

- **KPI row**: total orders, breach %, avg accept gap, avg reach→intent,
  active riders today, avg login hours
- **Hourly chart**: order volume + breach % trend across the day
- **Delay source chart**: breakdown of what's causing breaches
- **Hub-level table**: orders, avg CT, breach % per hub
- **Rider-level table**: orders, avg CT, breach %, and login hours
  (joined from the attendance tab) per rider
- **Filters**: city and Live/Non-Live, applied across every panel
