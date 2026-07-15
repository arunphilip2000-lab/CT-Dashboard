# Store Ops Live — Base Dump Dashboard

A live, auto-refreshing operations dashboard for all stores, powered directly by the
**Base Dump** tab of the Google Sheet (`Amazon Data - v2`). No backend, no database —
a single HTML file that reads the sheet as CSV and re-syncs itself on a timer.

## Features

- **KPI strip** — orders, delivered, on-time %, breach %, avg delay on breached orders, RTS count, active stores
- **Filters** — city, date, Live/Non-Live, store search (everything updates instantly)
- **Alerts** — open orders already past their promised delivery time, and stores crossing the red-zone breach threshold
- **Journey stage times** — median & p90 minutes for Create→Accept, Accept→Packed, Packed→Picked, Picked→Doorstep, Doorstep→Delivered
- **Charts** — orders & breach % by hour; delay-source mix (LM / Pickup / Creation-to-Accept / On Time) by city
- **Store leaderboard** — sortable, RAG color-coded table with drill-down per store (delay split, rider watchlist, latest orders)
- **Auto-refresh** — every 2 minutes by default (1/2/5/10 min selectable in ⚙ settings); new rows in the basedump appear automatically

## How it works

The page fetches the sheet's CSV export endpoint:

```
https://docs.google.com/spreadsheets/d/<SHEET_ID>/gviz/tq?tqx=out:csv&sheet=Base%20Dump
```

parses it in the browser (PapaParse), computes all metrics client-side, and renders
with Chart.js. A countdown timer re-fetches on the chosen interval.

## Setup

1. **Share the sheet (read-only):** in Google Sheets, `Share → General access →
   Anyone with the link → Viewer`. The dashboard only reads data; nobody can edit.
2. **Open `index.html`** in Chrome/Edge — or host it (see below) so the whole team
   can use one URL.
3. If your data tab isn't named `Base Dump`, open the **⚙ settings** panel in the
   top bar and set the tab name or its `gid` (visible in the sheet URL). You can
   also point it at a different spreadsheet ID there.

Default configuration lives at the top of the `<script>` block in `index.html`
(`cfg` object): sheet ID, tab name, gid, refresh interval, and RAG thresholds
(amber ≥ 10% breach, red ≥ 20%).

## Host it free with GitHub Pages

1. Push this repo to GitHub (steps below).
2. In the repo: `Settings → Pages → Source: Deploy from a branch → main / (root) → Save`.
3. After a minute the dashboard is live at
   `https://<your-username>.github.io/<repo-name>/` — share that URL with city
   leads; it always shows current data.

## Metric definitions

| Metric | Definition |
|---|---|
| On-time % (OTD) | Delivered orders where `delivery_time ≤ customer_promised_delivery_time` |
| Breach % | Delivered orders past promised time ÷ delivered orders with a promise |
| Avg delay | Mean minutes past promise, breached orders only |
| C→A | creation_time → Accept_time (median) |
| Pack→Pick | BAGS_PACKED_READY_FOR_PICKUP → Picked_Time (median) |
| LM | Picked_Time → CX_doorstep_time (median) |
| RTS % | Orders with RTS/RTSD status or an rts_start_time |
| RAG | Green < 10% breach · Amber 10–20% · Red ≥ 20% (configurable) |

## Tech

Single-file static app: HTML + CSS + vanilla JS, PapaParse 5.4 and Chart.js 4.4
from cdnjs. No build step, no dependencies to install.
