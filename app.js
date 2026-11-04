/* ============================================================
   LIVE CT DASHBOARD
   Reads straight from the Google Sheet through Google's built-in
   "gviz" query endpoint. No Apps Script, no backend: a static page.
   The spreadsheet must be shared as "Anyone with the link -> Viewer".
   ============================================================ */

const SHEET_ID = "1chF3F2OijqJ2gsW2V6KZFV3V00yNBrVWm0GSWpGIN5E";
const ORDERS_GID = "1700412129";      // Base Dump: one row per order
const RIDER_GID = "1570875705";       // DAU: rider login / attendance
const PROJECTION_GID = "1665232183";  // Projection: Hub name | city | date | hour | orders

const REFRESH_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 60000;

/* Colour cut-offs for the hour-by-hour table. Edit to match your SLA targets. */
const TARGETS = {
  o2aGood: 0.35, o2aWarn: 0.5,   // click to accept, minutes
  s2pGood: 0.75, s2pWarn: 1.0,   // store to pickup, minutes (45s target = 0.75)
  delayWarn: 3,  delayBad: 5,    // rider / store delay, % of orders
  attainGood: 90, attainWarn: 70 // orders as % of projection
};

/* Base Dump columns */
const O = {
  awb: "A", hub: "C", status: "D", riderId: "E", name: "F", creationDate: "G",
  pickedTime: "J", city: "O", breach: "R", bagsPacked: "S", lm: "T",
  creationToAccept: "X", hour: "Y", reachToIntent: "AA", rain: "AB",
  delay: "AC", liveNonLive: "AD", delaySource: "AE"
};

/* DAU (rider login) columns */
const R = { eventDate: "A", city: "B", hub: "C", riderId: "D", loginHours: "G" };

/* ---------- state ---------- */
const ALL_HOURS = Array.from({ length: 24 }, (_, i) => i);
let currentCity = "";
let currentHub = "";
let currentLive = "";
let currentDate = isoDate(new Date());
let activeView = "overview";
const loadedViews = {};       // view name -> true once loaded for the current filters
let knownHubs = new Set();
let hourlyData = null;        // cached for the two overview charts
let ridersByHour = null;      // lazy: distinct riders per hour
let hourBarMetric = "orders";
let volMetric = "orders";
let hourChart, volumeChart, projChart;

/* ---------- gviz helper (JSONP, works from a static page) ---------- */
function gvizQuery(gid, query) {
  return new Promise((resolve, reject) => {
    const cb = "gviz_cb_" + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The sheet took too long to answer. Check that link sharing is still on."));
    }, QUERY_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[cb] = resp => {
      cleanup();
      if (resp.status === "error") {
        const msg = resp.errors?.[0]?.detailed_message || resp.errors?.[0]?.message || "Query error";
        reject(new Error(msg + " | query: " + query));
        return;
      }
      resolve(resp.table);
    };

    const url =
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
      `?gid=${gid}&headers=1&tqx=out:json;responseHandler:${cb}` +
      `&tq=${encodeURIComponent(query)}`;

    const script = document.createElement("script");
    script.src = url;
    script.onerror = () => { cleanup(); reject(new Error("Could not reach the sheet. Is link sharing on?")); };
    document.body.appendChild(script);
  });
}

const tableRows = table => table.rows.map(r => r.c.map(c => (c ? c.v : null)));

/* ---------- small helpers ---------- */
function isoDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const sq = s => String(s).replace(/'/g, "\\'");
const $ = id => document.getElementById(id);

const fmtInt = n => (n == null ? "–" : Math.round(n).toLocaleString());
const fmtPct = n => (n == null ? "–" : (n * 100).toFixed(1) + "%");
const fmtNum = (n, d = 2) => (n == null || isNaN(n) ? "–" : Number(n).toFixed(d));

function dateClause(col, dateStr) {
  const next = new Date(dateStr + "T00:00:00");
  next.setDate(next.getDate() + 1);
  return `${col} >= date '${dateStr}' AND ${col} < date '${isoDate(next)}'`;
}

const withClause = (where, extra) => (where ? `${where} AND ${extra}` : `WHERE ${extra}`);

function buildWhere() {
  const c = [];
  if (currentCity) c.push(`${O.city} = '${sq(currentCity)}'`);
  if (currentHub) c.push(`${O.hub} = '${sq(currentHub)}'`);
  if (currentLive) c.push(`${O.liveNonLive} = '${sq(currentLive)}'`);
  if (currentDate) c.push(dateClause(O.creationDate, currentDate));
  return c.length ? "WHERE " + c.join(" AND ") : "";
}

/* The store-by-hour view ignores the city filter: a store belongs to one city anyway. */
function buildStoreWhere() {
  const c = [`${O.hub} = '${sq(currentHub)}'`];
  if (currentLive) c.push(`${O.liveNonLive} = '${sq(currentLive)}'`);
  c.push(dateClause(O.creationDate, currentDate || isoDate(new Date())));
  return "WHERE " + c.join(" AND ");
}

function datePhrase(d = currentDate) {
  if (!d) return "across all days";
  const today = isoDate(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d === today) return "today";
  if (d === isoDate(y)) return "yesterday";
  return "on " + new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/* login_hours may arrive as a number, "8:30", a time-of-day array, or "Date(1899,11,30,8,30,0)". */
function parseHours(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return (v[0] || 0) + (v[1] || 0) / 60 + (v[2] || 0) / 3600;
  const str = String(v).trim();
  const d = /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/.exec(str);
  if (d) {
    if (+d[1] !== 1899) return null;
    return (+d[4] || 0) + (+d[5] || 0) / 60 + (+d[6] || 0) / 3600;
  }
  if (str.includes(":")) {
    const [h, m = 0, s = 0] = str.split(":").map(Number);
    return h + m / 60 + s / 3600;
  }
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

/* Timestamp cell -> { ms, hasTime }. gviz sends dates as "Date(y,m,d,h,mi,s)". */
function parseTs(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return { ms: v.getTime(), hasTime: true };
  if (typeof v !== "string") return null;
  const m = /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+)(?:,(\d+))?)?\)$/.exec(v);
  if (m) {
    return {
      ms: Date.UTC(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +(m[7] || 0)),
      hasTime: m[4] != null
    };
  }
  const t = Date.parse(v);
  return isNaN(t) ? null : { ms: t, hasTime: /\d:\d/.test(v) };
}

const isTrue = v => v === true || String(v).toLowerCase() === "true";

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { console.warn(e); return fallback; }
}

function setStatus(text, isError) {
  $("statusText").textContent = text;
  $("liveDot").style.background = isError ? "#e0645a" : "";
}

function emptyRow(tbodyId, cols, text) {
  document.querySelector(`#${tbodyId} tbody`).innerHTML =
    `<tr><td class="empty-row" colspan="${cols}">${text}</td></tr>`;
}

/* ============================================================
   VIEWS
   ============================================================ */
const VIEW_LOADERS = {
  overview: async () => { await loadKpis(); await loadHourly(); },
  storehourly: loadStoreHourly,
  stores: async () => { await loadHubTable(); await loadWorstStores(); },
  riders: loadRiderTable
};

async function loadActiveView(force) {
  if (!force && loadedViews[activeView]) return;
  setStatus("Loading…");
  try {
    await safe(loadFilters, null);
    await VIEW_LOADERS[activeView]();
    loadedViews[activeView] = true;
    setStatus("Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  } catch (err) {
    console.error(err);
    setStatus("Error: " + err.message, true);
  }
}

function invalidate() {
  Object.keys(loadedViews).forEach(k => delete loadedViews[k]);
  ridersByHour = null;
  loadActiveView(true);
}

function showView(name) {
  activeView = name;
  document.querySelectorAll(".view").forEach(v => { v.hidden = v.id !== "view-" + name; });
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  loadActiveView(false);
}

/* City list and store list, loaded once */
let filtersLoaded = false;
async function loadFilters() {
  if (filtersLoaded) return;
  const cities = await gvizQuery(ORDERS_GID, `SELECT ${O.city}, COUNT(${O.awb}) GROUP BY ${O.city} ORDER BY ${O.city}`);
  const citySel = $("filterCity");
  tableRows(cities).forEach(([city]) => {
    if (!city) return;
    const o = document.createElement("option");
    o.value = o.textContent = city;
    citySel.appendChild(o);
  });

  const hubs = await gvizQuery(ORDERS_GID, `SELECT ${O.hub}, COUNT(${O.awb}) GROUP BY ${O.hub} ORDER BY ${O.hub}`);
  const list = $("hubList");
  tableRows(hubs).forEach(([hub]) => {
    if (!hub) return;
    knownHubs.add(hub);
    const o = document.createElement("option");
    o.value = hub;
    list.appendChild(o);
  });
  filtersLoaded = true;
}

/* ============================================================
   TODAY AT A GLANCE
   ============================================================ */
async function loadKpis() {
  const where = buildWhere();
  const main = await gvizQuery(ORDERS_GID,
    `SELECT COUNT(${O.awb}), COUNT(${O.breach}), AVG(${O.creationToAccept}), AVG(${O.reachToIntent}) ${where}`);
  const [[total = 0, breachCount = 0, avgAccept, avgIntent] = []] = tableRows(main);

  /* Rider delay = breached orders whose Delay column says Rider_delay.
     Every other breached order is counted as store delay. */
  const riderQ = await gvizQuery(ORDERS_GID,
    `SELECT COUNT(${O.awb}) ${withClause(where, `${O.breach} = 'Breach' AND ${O.delay} = 'Rider_delay'`)}`);
  const [[riderBreach = 0] = []] = tableRows(riderQ);
  const storeBreach = breachCount - riderBreach;

  $("kpiTotal").textContent = fmtInt(total);
  $("kpiBreach").textContent = total ? fmtPct(breachCount / total) : "–";
  $("kpiAccept").textContent = fmtNum(avgAccept);
  $("kpiIntent").textContent = fmtNum(avgIntent);

  if (total) {
    $("headline").innerHTML = `${fmtInt(total)} orders ${datePhrase()}, <span class="bad-text">${fmtPct(breachCount / total)}</span> breached.`;
    $("subhead").textContent =
      `Riders account for ${fmtPct(riderBreach / total)} of orders and stores for ${fmtPct(storeBreach / total)}. ` +
      `On-time is about ${fmtPct(1 - breachCount / total)} (100% minus breaches; the exact OTP+3 rule isn't in the sheet).`;
  } else {
    $("headline").textContent = `No orders found ${datePhrase()}.`;
    $("subhead").textContent = "Try another date, or clear the city and store filters.";
  }

  /* Rider-side numbers come from the DAU tab; keep going if it is empty or being refreshed. */
  const riderWhere = currentCity ? `WHERE ${R.city} = '${sq(currentCity)}'` : "";
  const active = await safe(async () => {
    const t = await gvizQuery(RIDER_GID, `SELECT COUNT(${R.riderId}) ${riderWhere}`);
    return tableRows(t)[0]?.[0];
  }, null);
  $("kpiRiders").textContent = fmtInt(active);

  const avgLogin = await safe(async () => {
    try {
      const t = await gvizQuery(RIDER_GID, `SELECT AVG(${R.loginHours}) ${riderWhere}`);
      return tableRows(t)[0]?.[0];
    } catch (e) {
      // login_hours is stored as a time, not a plain number: average it here instead
      const t = await gvizQuery(RIDER_GID, `SELECT ${R.loginHours} ${riderWhere}`);
      const vals = tableRows(t).map(r => parseHours(r[0])).filter(v => v != null && v > 0);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
  }, null);
  $("kpiLoginHrs").textContent = fmtNum(avgLogin);

  $("kpiNewRiders").textContent = fmtInt(await safe(freshRiderCount, null));
}

/* A rider is "first-day" when the selected date is the only date they appear on in the DAU tab. */
async function freshRiderCount() {
  const ref = currentDate || isoDate(new Date());
  const scope = [];
  if (currentCity) scope.push(`${R.city} = '${sq(currentCity)}'`);
  if (currentHub) scope.push(`${R.hub} = '${sq(currentHub)}'`);
  const extra = scope.length ? " AND " + scope.join(" AND ") : "";

  const todayT = await gvizQuery(RIDER_GID,
    `SELECT ${R.riderId}, COUNT(${R.eventDate}) WHERE ${R.eventDate} = date '${ref}'${extra} GROUP BY ${R.riderId}`);
  const otherT = await gvizQuery(RIDER_GID,
    `SELECT ${R.riderId}, COUNT(${R.eventDate}) WHERE ${R.eventDate} != date '${ref}' GROUP BY ${R.riderId}`);
  const others = new Set(tableRows(otherT).map(r => String(r[0])));
  return tableRows(todayT).map(r => String(r[0])).filter(id => !others.has(id)).length;
}

/* Orders, breaches, and the rider / store split for every hour of the day */
async function loadHourly() {
  const where = buildWhere();
  const totals = await gvizQuery(ORDERS_GID,
    `SELECT ${O.hour}, COUNT(${O.awb}), COUNT(${O.breach}) ${where} GROUP BY ${O.hour} ORDER BY ${O.hour}`);
  const totalMap = new Map(tableRows(totals).filter(r => r[0] != null).map(r => [r[0], { orders: r[1] || 0, breach: r[2] || 0 }]));

  const rider = await gvizQuery(ORDERS_GID,
    `SELECT ${O.hour}, COUNT(${O.awb}) ${withClause(where, `${O.breach} = 'Breach' AND ${O.delay} = 'Rider_delay'`)} GROUP BY ${O.hour}`);
  const riderMap = new Map(tableRows(rider).map(r => [r[0], r[1] || 0]));

  const orders = ALL_HOURS.map(h => totalMap.get(h)?.orders || 0);
  const breaches = ALL_HOURS.map(h => totalMap.get(h)?.breach || 0);
  hourlyData = {
    labels: ALL_HOURS.map(h => `${h}:00`),
    orders, breaches,
    riderPct: ALL_HOURS.map((h, i) => (orders[i] ? (100 * (riderMap.get(h) || 0)) / orders[i] : null)),
    storePct: ALL_HOURS.map((h, i) => (orders[i] ? (100 * (breaches[i] - (riderMap.get(h) || 0))) / orders[i] : null))
  };
  renderHourChart();
  renderVolumeChart();
}

const CHART_FONT = { family: "Manrope, sans-serif", size: 12 };

function renderHourChart() {
  if (!hourlyData) return;
  const bars = hourBarMetric === "orders" ? hourlyData.orders : hourlyData.breaches;
  if (hourChart) hourChart.destroy();
  hourChart = new Chart($("hourChart"), {
    data: {
      labels: hourlyData.labels,
      datasets: [
        { type: "bar", label: hourBarMetric === "orders" ? "Orders" : "Breaches", data: bars, backgroundColor: "#cfe3d6", yAxisID: "y1", order: 3, borderRadius: 3 },
        { type: "line", label: "Rider delay %", data: hourlyData.riderPct, borderColor: "#c0392b", backgroundColor: "#c0392b", tension: 0.3, pointRadius: 2.5, yAxisID: "y2", order: 1 },
        { type: "line", label: "Store delay %", data: hourlyData.storePct, borderColor: "#b9770e", backgroundColor: "#b9770e", tension: 0.3, pointRadius: 2.5, yAxisID: "y2", order: 2 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y1: { position: "left", ticks: { color: "#66786d", font: CHART_FONT }, grid: { color: "#edf1ea" } },
        y2: { position: "right", min: 0, ticks: { color: "#66786d", font: CHART_FONT, callback: v => v + "%" }, grid: { display: false } },
        x: { ticks: { color: "#66786d", font: CHART_FONT, maxRotation: 0, autoSkip: true }, grid: { display: false } }
      },
      plugins: { legend: { position: "top", align: "start", labels: { boxWidth: 10, font: CHART_FONT } } }
    }
  });
}

const VOL_SUB = {
  orders: "Orders by creation hour.",
  riders: "Distinct riders who took an order in each hour.",
  breaches: "Breached orders by creation hour."
};

async function renderVolumeChart() {
  if (!hourlyData) return;
  $("volSub").textContent = VOL_SUB[volMetric];
  let data;
  if (volMetric === "riders") {
    if (!ridersByHour) {
      $("volSub").textContent = "Counting riders for each hour…";
      ridersByHour = await safe(loadRidersByHour, ALL_HOURS.map(() => 0));
      $("volSub").textContent = VOL_SUB.riders;
    }
    data = ridersByHour;
  } else {
    data = volMetric === "orders" ? hourlyData.orders : hourlyData.breaches;
  }
  if (volumeChart) volumeChart.destroy();
  volumeChart = new Chart($("volumeChart"), {
    type: "bar",
    data: { labels: hourlyData.labels, datasets: [{ data, backgroundColor: "#1f6b45", borderRadius: 3 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { color: "#66786d", font: CHART_FONT }, grid: { color: "#edf1ea" } },
        x: { ticks: { color: "#66786d", font: CHART_FONT, maxRotation: 0, autoSkip: true }, grid: { display: false } }
      }
    }
  });
}

/* gviz has no COUNT(DISTINCT): fetch one row per (hour, rider) and count rows per hour. */
async function loadRidersByHour() {
  const where = withClause(buildWhere(), `${O.riderId} IS NOT NULL`);
  const t = await gvizQuery(ORDERS_GID,
    `SELECT ${O.hour}, ${O.riderId}, COUNT(${O.awb}) ${where} GROUP BY ${O.hour}, ${O.riderId}`);
  const counts = new Map();
  tableRows(t).forEach(([h]) => counts.set(h, (counts.get(h) || 0) + 1));
  return ALL_HOURS.map(h => counts.get(h) || 0);
}

/* ============================================================
   STORE BY HOUR
   ============================================================ */
const heatO2a = v => (v == null ? "" : v <= TARGETS.o2aGood ? "good" : v <= TARGETS.o2aWarn ? "warn" : "bad");
const heatS2p = v => (v == null ? "" : v <= TARGETS.s2pGood ? "good" : v <= TARGETS.s2pWarn ? "warn" : "bad");
const heatDelay = p => (p < TARGETS.delayWarn ? "good" : p < TARGETS.delayBad ? "warn" : "bad");
const heatAttain = p => (p >= TARGETS.attainGood ? "good" : p >= TARGETS.attainWarn ? "warn" : "bad");

function showStoreEmpty(title, sub, showPick) {
  $("shTitle").textContent = title;
  $("shSub").textContent = sub;
  $("shPick").hidden = !showPick;
  $("shMetrics").hidden = true;
  $("shChartPanel").hidden = true;
  $("shNote").textContent = "";
  emptyRow("hourlyReportTable", 12, "No store chosen yet.");
}

async function loadStoreHourly() {
  if (!currentHub) {
    showStoreEmpty("Choose a store", "Pick a store in the filter bar to see its orders against projection, hour by hour.", true);
    return;
  }
  const date = currentDate || isoDate(new Date());
  const where = buildStoreWhere();

  const projT = await gvizQuery(PROJECTION_GID,
    `SELECT D, SUM(E) WHERE A = '${sq(currentHub)}' AND ${dateClause("C", date)} GROUP BY D ORDER BY D`);
  const projMap = new Map(tableRows(projT).map(r => [r[0], r[1] || 0]));

  const totT = await gvizQuery(ORDERS_GID,
    `SELECT ${O.hour}, COUNT(${O.awb}), COUNT(${O.breach}), AVG(${O.lm}), AVG(${O.creationToAccept}) ${where} GROUP BY ${O.hour} ORDER BY ${O.hour}`);
  const totMap = new Map(tableRows(totT).filter(r => r[0] != null)
    .map(r => [r[0], { orders: r[1] || 0, breach: r[2] || 0, lm: r[3], o2a: r[4] }]));

  const riderT = await gvizQuery(ORDERS_GID,
    `SELECT ${O.hour}, ${O.rain}, COUNT(${O.awb}) ${withClause(where, `${O.breach} = 'Breach' AND ${O.delay} = 'Rider_delay'`)} GROUP BY ${O.hour}, ${O.rain}`);
  const riderMap = new Map(), rainMap = new Map();
  tableRows(riderT).forEach(([h, rain, n]) => {
    riderMap.set(h, (riderMap.get(h) || 0) + (n || 0));
    if (isTrue(rain)) rainMap.set(h, (rainMap.get(h) || 0) + (n || 0));
  });

  /* One row per order for this store and day: gives riders per hour and S2P (packed -> picked). */
  const rawT = await gvizQuery(ORDERS_GID, `SELECT ${O.hour}, ${O.riderId}, ${O.bagsPacked}, ${O.pickedTime} ${where}`);
  const ridersSet = new Map(), s2pSum = new Map(), s2pCnt = new Map();
  let sawTime = false, pairs = 0;
  tableRows(rawT).forEach(([h, rider, packed, picked]) => {
    if (h == null) return;
    if (rider != null) {
      if (!ridersSet.has(h)) ridersSet.set(h, new Set());
      ridersSet.get(h).add(rider);
    }
    const a = parseTs(packed), b = parseTs(picked);
    if (!a || !b) return;
    pairs++;
    if (a.hasTime && b.hasTime) sawTime = true;
    const mins = (b.ms - a.ms) / 60000;
    if (mins < 0 || mins > 60) return;
    s2pSum.set(h, (s2pSum.get(h) || 0) + mins);
    s2pCnt.set(h, (s2pCnt.get(h) || 0) + 1);
  });

  const today = isoDate(new Date());
  const nowHour = new Date().getHours();
  const elapsed = h => date !== today || h <= nowHour;

  const tbody = document.querySelector("#hourlyReportTable tbody");
  tbody.innerHTML = "";
  const chartProj = [], chartOrders = [];
  let sumOrders = 0, sumProjElapsed = 0, sumBreach = 0, sumRider = 0;
  let o2aW = 0, o2aN = 0, s2pW = 0, s2pN = 0;

  ALL_HOURS.forEach(h => {
    const t = totMap.get(h);
    const orders = t?.orders || 0;
    const projected = projMap.get(h) || 0;
    const past = elapsed(h) || orders > 0;
    chartProj.push(projected);
    chartOrders.push(orders);

    const riders = ridersSet.get(h)?.size || 0;
    const riderDelay = riderMap.get(h) || 0;
    const rainDelay = rainMap.get(h) || 0;
    const storeDelay = (t?.breach || 0) - riderDelay;
    const s2p = s2pCnt.get(h) ? s2pSum.get(h) / s2pCnt.get(h) : null;
    const o2a = t?.o2a ?? null;

    sumOrders += orders;
    if (past) sumProjElapsed += projected;
    sumBreach += t?.breach || 0;
    sumRider += riderDelay;
    if (o2a != null) { o2aW += o2a * orders; o2aN += orders; }
    if (s2p != null) { s2pW += s2pSum.get(h); s2pN += s2pCnt.get(h); }

    const tr = document.createElement("tr");
    if (!orders && !past) tr.className = "future";
    const hasOrders = orders > 0;
    let attain = "–";
    if (projected && past) {
      const pct = (100 * orders) / projected;
      attain = `<td class="att ${heatAttain(pct)}"><span class="att-fill" style="width:${Math.min(pct, 100)}%"></span><span class="att-val">${pct.toFixed(0)}%</span></td>`;
    } else {
      attain = `<td class="att"><span class="att-val">–</span></td>`;
    }
    const delayCell = n => (hasOrders ? `<td class="${heatDelay((100 * n) / orders)}">${((100 * n) / orders).toFixed(1)}%</td>` : "<td>–</td>");

    tr.innerHTML =
      `<td class="left">${String(h).padStart(2, "0")}:00</td>` +
      `<td>${projected ? fmtInt(projected) : "–"}</td>` +
      `<td>${past || hasOrders ? fmtInt(orders) : "–"}</td>` +
      attain +
      `<td>${riders ? fmtInt(riders) : "–"}</td>` +
      `<td>${riders ? (orders / riders).toFixed(2) : "–"}</td>` +
      `<td class="${heatO2a(o2a)}">${o2a != null ? fmtNum(o2a) : "–"}</td>` +
      `<td class="${heatS2p(s2p)}">${s2p != null ? fmtNum(s2p) : "–"}</td>` +
      `<td>${t?.lm != null ? fmtNum(t.lm) : "–"}</td>` +
      delayCell(riderDelay) + delayCell(rainDelay) + delayCell(storeDelay);
    tbody.appendChild(tr);
  });

  $("shTitle").textContent = currentHub;
  $("shSub").textContent = `Orders, projection, click to accept, S2P and delays for each hour ${datePhrase(date)}.`;
  $("shPick").hidden = true;
  $("shMetrics").hidden = false;
  $("shChartPanel").hidden = false;

  $("shAttain").textContent = sumProjElapsed ? `${((100 * sumOrders) / sumProjElapsed).toFixed(0)}%` : "–";
  $("shAttainSub").textContent = sumProjElapsed ? `${fmtInt(sumOrders)} orders of ${fmtInt(sumProjElapsed)} projected so far` : `${fmtInt(sumOrders)} orders, no projection found`;
  $("shO2a").textContent = o2aN ? fmtNum(o2aW / o2aN) : "–";
  $("shS2p").textContent = s2pN ? fmtNum(s2pW / s2pN) : "–";
  $("shRider").textContent = sumOrders ? ((100 * sumRider) / sumOrders).toFixed(1) + "%" : "–";
  $("shStore").textContent = sumOrders ? ((100 * (sumBreach - sumRider)) / sumOrders).toFixed(1) + "%" : "–";

  const notes = [];
  if (!projMap.size) notes.push("No projection was found for this store on this date.");
  if (pairs && !sawTime) notes.push("S2P is blank: BAGS_PACKED_READY_FOR_PICKUP and Picked_Time arrive from the sheet as dates without a time of day. Format both columns as Date time in the Base Dump tab and S2P will fill in.");
  else if (!pairs && tableRows(rawT).length) notes.push("S2P is blank: none of this store's orders have both a packed time and a picked time.");
  $("shNote").textContent = notes.join(" ");

  if (projChart) projChart.destroy();
  projChart = new Chart($("projChart"), {
    data: {
      labels: ALL_HOURS.map(h => `${String(h).padStart(2, "0")}:00`),
      datasets: [
        { type: "bar", label: "Orders", data: chartOrders, backgroundColor: "#1f6b45", borderRadius: 3, order: 2 },
        { type: "line", label: "Projected", data: chartProj, borderColor: "#3d6f94", backgroundColor: "#3d6f94", borderWidth: 2, pointRadius: 2.5, tension: 0.25, order: 1 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: { ticks: { color: "#66786d", font: CHART_FONT }, grid: { color: "#edf1ea" } },
        x: { ticks: { color: "#66786d", font: CHART_FONT, maxRotation: 0, autoSkip: true }, grid: { display: false } }
      },
      plugins: { legend: { position: "top", align: "start", labels: { boxWidth: 10, font: CHART_FONT } } }
    }
  });
}

/* ============================================================
   STORES
   ============================================================ */
const MIN_ORDERS_FOR_RANKING = 15;
let worstByCity = null;
let worstCity = "";
let worstCityListLoaded = false;

const breachClass = p => (p > 8 ? "breach-high" : p > 4 ? "breach-mid" : "");

async function loadHubTable() {
  const where = buildWhere();
  const [main, split] = await Promise.all([
    gvizQuery(ORDERS_GID,
      `SELECT ${O.hub}, ${O.city}, COUNT(${O.awb}), AVG(${O.creationToAccept}), AVG(${O.lm}), COUNT(${O.breach}) ${where} GROUP BY ${O.hub}, ${O.city} ORDER BY COUNT(${O.awb}) DESC LIMIT 20`),
    gvizQuery(ORDERS_GID,
      `SELECT ${O.hub}, COUNT(${O.awb}) ${withClause(where, `${O.breach} = 'Breach' AND ${O.delay} = 'Rider_delay'`)} GROUP BY ${O.hub}`)
  ]);
  const riderMap = new Map(tableRows(split).map(r => [r[0], r[1] || 0]));

  const newRiders = await safe(async () => {
    const ref = currentDate || isoDate(new Date());
    const todayT = await gvizQuery(RIDER_GID,
      `SELECT ${R.hub}, ${R.riderId}, COUNT(${R.eventDate}) WHERE ${R.eventDate} = date '${ref}' GROUP BY ${R.hub}, ${R.riderId}`);
    const otherT = await gvizQuery(RIDER_GID,
      `SELECT ${R.riderId}, COUNT(${R.eventDate}) WHERE ${R.eventDate} != date '${ref}' GROUP BY ${R.riderId}`);
    const others = new Set(tableRows(otherT).map(r => String(r[0])));
    const map = new Map();
    tableRows(todayT).forEach(([hub, id]) => { if (!others.has(String(id))) map.set(hub, (map.get(hub) || 0) + 1); });
    return map;
  }, new Map());

  const tbody = document.querySelector("#hubTable tbody");
  tbody.innerHTML = "";
  const rows = tableRows(main);
  if (!rows.length) { emptyRow("hubTable", 9, "No orders for these filters."); return; }
  rows.forEach(([hub, city, orders, o2a, lm, breach]) => {
    const rider = riderMap.get(hub) || 0;
    const pct = orders ? (100 * (breach || 0)) / orders : 0;
    const riderPct = orders ? (100 * rider) / orders : 0;
    const storePct = orders ? (100 * ((breach || 0) - rider)) / orders : 0;
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left">${hub ?? ""}</td><td class="left">${city ?? ""}</td><td>${fmtInt(orders)}</td>` +
      `<td class="${breachClass(pct)}">${pct.toFixed(1)}%</td>` +
      `<td class="${heatDelay(riderPct)}">${riderPct.toFixed(1)}%</td>` +
      `<td class="${heatDelay(storePct)}">${storePct.toFixed(1)}%</td>` +
      `<td>${fmtNum(o2a)}</td><td>${fmtNum(lm)}</td><td>${fmtInt(newRiders.get(hub) || 0)}</td>`;
    tbody.appendChild(tr);
  });
}

async function loadWorstStores() {
  const where = buildWhere();
  const t = await gvizQuery(ORDERS_GID,
    `SELECT ${O.hub}, ${O.city}, COUNT(${O.awb}), COUNT(${O.breach}) ${where} GROUP BY ${O.hub}, ${O.city}`);
  const rows = tableRows(t)
    .map(([hub, city, orders, breach]) => ({ hub, city, orders: orders || 0, pct: orders ? (100 * (breach || 0)) / orders : 0 }))
    .filter(r => r.orders >= MIN_ORDERS_FOR_RANKING);

  renderRank("worstStoresTable", [...rows].sort((a, b) => b.pct - a.pct).slice(0, 15));

  const byCity = new Map();
  rows.forEach(r => { if (!byCity.has(r.city)) byCity.set(r.city, []); byCity.get(r.city).push(r); });
  byCity.forEach((list, city) => byCity.set(city, list.sort((a, b) => b.pct - a.pct).slice(0, 5)));
  worstByCity = byCity;

  if (!worstCityListLoaded) {
    const sel = $("worstCitySelect");
    [...byCity.keys()].filter(Boolean).sort().forEach(c => {
      const o = document.createElement("option");
      o.value = o.textContent = c;
      sel.appendChild(o);
    });
    worstCityListLoaded = true;
  }
  renderWorstByCity();
}

function renderWorstByCity() {
  if (!worstCity || !worstByCity) { emptyRow("worstStoresByCityTable", 4, "Choose a city to see its weakest stores."); return; }
  renderRank("worstStoresByCityTable", worstByCity.get(worstCity) || []);
}

function renderRank(tableId, rows) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = "";
  if (!rows.length) { emptyRow(tableId, 4, "Nothing to rank for these filters."); return; }
  rows.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="left">${r.hub ?? ""}</td><td class="left">${r.city ?? ""}</td><td>${fmtInt(r.orders)}</td><td class="${breachClass(r.pct)}">${r.pct.toFixed(1)}%</td>`;
    tbody.appendChild(tr);
  });
}

/* ============================================================
   RIDERS
   ============================================================ */
async function loadRiderTable() {
  const where = buildWhere();
  const t = await gvizQuery(ORDERS_GID,
    `SELECT ${O.riderId}, ${O.name}, ${O.hub}, COUNT(${O.awb}), AVG(${O.creationToAccept}), AVG(${O.reachToIntent}), COUNT(${O.breach}) ${withClause(where, `${O.riderId} IS NOT NULL`)} GROUP BY ${O.riderId}, ${O.name}, ${O.hub} ORDER BY COUNT(${O.awb}) DESC LIMIT 25`);

  /* Login hours per rider from the DAU tab. Try SUM; if the column is a time, add it up here. */
  const loginMap = await safe(async () => {
    const map = new Map();
    try {
      const l = await gvizQuery(RIDER_GID, `SELECT ${R.riderId}, SUM(${R.loginHours}) GROUP BY ${R.riderId}`);
      tableRows(l).forEach(([id, h]) => map.set(String(id), h));
    } catch (e) {
      const l = await gvizQuery(RIDER_GID, `SELECT ${R.riderId}, ${R.loginHours}`);
      tableRows(l).forEach(([id, h]) => {
        const v = parseHours(h);
        if (v != null) map.set(String(id), (map.get(String(id)) || 0) + v);
      });
    }
    return map;
  }, new Map());

  const tbody = document.querySelector("#riderTable tbody");
  tbody.innerHTML = "";
  const rows = tableRows(t);
  if (!rows.length) { emptyRow("riderTable", 7, "No rider orders for these filters."); return; }
  rows.forEach(([id, name, hub, orders, o2a, intent, breach]) => {
    const pct = orders ? (100 * (breach || 0)) / orders : 0;
    const login = loginMap.get(String(id));
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="left">${name || id || ""}</td><td class="left">${hub ?? ""}</td><td>${fmtInt(orders)}</td>` +
      `<td>${fmtNum(o2a)}</td><td>${fmtNum(intent)}</td>` +
      `<td class="${breachClass(pct)}">${pct.toFixed(1)}%</td><td>${login != null && login > 0 ? fmtNum(login, 1) : "–"}</td>`;
    tbody.appendChild(tr);
  });
  $("riderNote").textContent = loginMap.size ? "" : "Login hours are blank because the DAU tab has no rows right now. They return once the rider import finishes.";
}

/* ============================================================
   CSV EXPORT
   ============================================================ */
function tableCsv(id) {
  return [...document.querySelectorAll(`#${id} tr`)]
    .filter(tr => !tr.querySelector(".empty-row"))
    .map(tr => [...tr.children].map(c => `"${(c.textContent || "").trim().replace(/"/g, '""')}"`).join(","));
}

function downloadCsv() {
  const out = [`Live CT dashboard export,${new Date().toLocaleString()}`,
    `Filters,City=${currentCity || "All"},Store=${currentHub || "All"},Orders=${currentLive || "All"},Date=${currentDate || "All"}`, ""];
  const kpis = [["Orders", "kpiTotal"], ["Breach rate", "kpiBreach"], ["Click to accept (min)", "kpiAccept"],
    ["Reach to intent (min)", "kpiIntent"], ["Riders logged in", "kpiRiders"], ["First-day riders", "kpiNewRiders"], ["Avg login hours", "kpiLoginHrs"]];
  if ($("kpiTotal").textContent !== "–") {
    out.push("Summary");
    kpis.forEach(([label, id]) => out.push(`"${label}","${$(id).textContent}"`));
    out.push("");
  }
  [["Store by hour: " + (currentHub || ""), "hourlyReportTable"], ["Busiest stores", "hubTable"],
   ["15 weakest stores", "worstStoresTable"], ["Weakest stores in " + (worstCity || "city"), "worstStoresByCityTable"],
   ["Riders", "riderTable"]].forEach(([title, id]) => {
    const rows = tableCsv(id);
    if (rows.length > 1) out.push(title, ...rows, "");
  });
  const blob = new Blob([out.join("\n")], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ct-dashboard-${isoDate(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/* ============================================================
   WIRING
   ============================================================ */
$("nav").addEventListener("click", e => {
  const b = e.target.closest(".nav-item");
  if (b) showView(b.dataset.view);
});

$("filterCity").addEventListener("change", e => { currentCity = e.target.value; invalidate(); });

$("filterHub").addEventListener("change", e => {
  const v = e.target.value.trim();
  if (!v) { currentHub = ""; e.target.setCustomValidity(""); invalidate(); return; }
  if (knownHubs.size && !knownHubs.has(v)) {
    e.target.setCustomValidity("Pick a store from the list");
    e.target.reportValidity();
    return;
  }
  e.target.setCustomValidity("");
  currentHub = v;
  invalidate();
});

$("filterLive").addEventListener("change", e => { currentLive = e.target.value; invalidate(); });
$("filterDate").addEventListener("change", e => { currentDate = e.target.value; invalidate(); });

$("todayBtn").addEventListener("click", () => { currentDate = isoDate(new Date()); $("filterDate").value = currentDate; invalidate(); });
$("yestBtn").addEventListener("click", () => {
  const d = new Date(); d.setDate(d.getDate() - 1);
  currentDate = isoDate(d); $("filterDate").value = currentDate; invalidate();
});

$("refreshBtn").addEventListener("click", invalidate);
$("csvBtn").addEventListener("click", downloadCsv);
$("shPick").addEventListener("click", () => $("filterHub").focus());

document.querySelectorAll(".toggle-btn:not(.vol-toggle)").forEach(btn => btn.addEventListener("click", () => {
  document.querySelectorAll(".toggle-btn:not(.vol-toggle)").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  hourBarMetric = btn.dataset.metric;
  renderHourChart();
}));

document.querySelectorAll(".vol-toggle").forEach(btn => btn.addEventListener("click", () => {
  document.querySelectorAll(".vol-toggle").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  volMetric = btn.dataset.volMetric;
  renderVolumeChart();
}));

$("worstCitySelect").addEventListener("change", e => { worstCity = e.target.value; renderWorstByCity(); });

$("filterDate").value = currentDate;
loadActiveView(true);
setInterval(() => { if (!document.hidden) invalidate(); }, REFRESH_MS);
