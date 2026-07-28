# Live Stores Performance Dashboard

A single-page HTML dashboard for last-mile delivery operations — summarizing
order volume, delivery-time SLAs, and delay causes across 31 hubs.

## What it shows

- **Summary cards:** Total OPD, Total DAU, OR2A (order-ready-to-accept time),
  S2P (store-to-pickup time), OTP+3min on-time rate, and a Rider Delay /
  Store Delay breakdown that adds up to 100% with the on-time rate.
- **Hub-level table:** the same set of metrics broken out per hub, sorted by
  Rider Delay % in decreasing order, with a Grand Total row.

## Tech

Plain HTML/CSS — no build step, no dependencies. Open `index.html` directly
in a browser, or enable GitHub Pages on this repo to host it live.

## Data

Built from raw order-level delivery data (timestamps, delay tags, OTP
segments) aggregated per hub with Python (pandas/openpyxl).
