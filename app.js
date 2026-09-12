/* ============================================================
   LIVE CT DASHBOARD
   Reads directly from the Google Sheet using Google's built-in
   "gviz" query endpoint (the same one Google Charts uses).
   No Apps Script, no backend — this is a pure static page.

   Requirement: the spreadsheet must be shared as
   "Anyone with the link -> Viewer".
   ============================================================ */

const SHEET_ID = "1chF3F2OijqJ2gsW2V6KZFV3V00yNBrVWm0GSWpGIN5E";
const ORDERS_GID = "1700412129";   // order-level CT tab
const RIDER_GID = "1570875705";    // rider login / attendance tab

const REFRESH_MS = 5 * 60 * 1000;  // dashboard refresh cadence (sheet itself updates ~every 15 min)

/* Column letters — order-level tab (33 cols, in the order given) */
const O = {
  awb: "A", clientOrderId: "B", hub: "C", status: "D", riderId: "E", name: "F",
  creationDate: "G", creationTime: "H", acceptTime: "I", pickedTime: "J",
  doorstepTime: "K", deliveryTime: "L", rtsStart: "M", rtsClosed: "N",
  city: "O", promisedTime: "P", pickupReadyEta: "Q", breach: "R",
  bagsReady: "S", lm: "T", nextAllot: "U", reachedGeofence: "V",
  riderMarkedIntent: "W", creationToAccept: "X", hour: "Y", bts: "Z",
  reachToIntent: "AA", rain: "AB", delay: "AC", liveNonLive: "AD",
  delaySource: "AE", returnDelay: "AF", lodEo: "AG"
};

/* Column letters — rider login / attendance tab */
const R = {
  eventDate: "A", city: "B", hub: "C", riderId: "D",
  firstSeen: "E", lastSeen: "F", loginHours: "G", fod: "H",
  liveNonLive: "J", storeDivision: "K"
};

let currentCity = "";
let currentHub = "";
let currentLive = "";
let currentDate = "today"; // "today" | "yesterday" | ""
let riderLoginCache = null; // reset each refresh so login hours stay current

/* ---------- gviz fetch helper (JSONP, works from a static page) ---------- */
function gvizQuery(gid, query) {
  return new Promise((resolve, reject) => {
    const cb = "gviz_cb_" + Math.random().toString(36).slice(2);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Sheet query timed out — check that link sharing is on."));
    }, 45000);

    function cleanup() {
      clearTimeout(timeout);
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[cb] = (resp) => {
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
    script.onerror = () => { cleanup(); reject(new Error("Failed to reach the sheet. Is link sharing on?")); };
    document.body.appendChild(script);
  });
}

/* Turn a gviz table into an array of plain row arrays (raw cell values) */
function tableRows(table) {
  return table.rows.map(r => r.c.map(c => (c ? c.v : null)));
}

function isoDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function buildWhere() {
  const clauses = [];
  if (currentCity) clauses.push(`${O.city} = '${currentCity.replace(/'/g, "\\'")}'`);
  if (currentHub) clauses.push(`${O.hub} = '${currentHub.replace(/'/g, "\\'")}'`);
  if (currentLive) clauses.push(`${O.liveNonLive} = '${currentLive}'`);
  if (currentDate === "today" || currentDate === "yesterday") {
    const base = new Date();
    if (currentDate === "yesterday") base.setDate(base.getDate() - 1);
    const start = isoDate(base);
    const next = new Date(base);
    next.setDate(next.getDate() + 1);
    const end = isoDate(next);
    // Assumes creation_Date is a real Date-type column in the sheet.
    // If it's stored as text this range comparison won't match — let us know.
    clauses.push(`${O.creationDate} >= date '${start}' AND ${O.creationDate} < date '${end}'`);
  }
  return clauses.length ? "WHERE " + clauses.join(" AND ") : "";
}

/* ---------- Number formatting ---------- */
const fmtInt = n => (n == null ? "–" : Math.round(n).toLocaleString());
const fmtPct = n => (n == null ? "–" : (n * 100).toFixed(1) + "%");
const fmtNum = (n, d = 2) => (n == null ? "–" : Number(n).toFixed(d));

/* ============================================================
   LOAD + RENDER
   ============================================================ */
async function loadDashboard() {
  setStatus("Refreshing…");
  riderLoginCache = null;
  try {
    await loadCityFilter();
    setStatus("Loading KPIs…");
    await loadKpis();
    setStatus("Loading hourly trend…");
    await loadHourly();
    setStatus("Loading delay split…");
    await loadDelaySplit();
    setStatus("Loading hub table…");
    await loadHubTable();
    setStatus("Loading worst-performing stores…");
    await loadWorstStores();
    setStatus("Loading rider table…");
    await loadRiderTable();
    setStatus("Updated " + new Date().toLocaleTimeString());
  } catch (err) {
    console.error(err);
    setStatus("Error: " + err.message, true);
  }
}

function setStatus(text, isError) {
  const el = document.getElementById("statusText");
  el.textContent = text;
  document.getElementById("liveDot").style.background = isError ? "#dc2626" : "#4ade80";
}

/* Populate the city and hub dropdowns once */
let filtersLoaded = false;
async function loadCityFilter() {
  if (filtersLoaded) return;
  const cityTable = await gvizQuery(ORDERS_GID, `SELECT ${O.city}, COUNT(${O.awb}) GROUP BY ${O.city} ORDER BY ${O.city}`);
  const citySel = document.getElementById("filterCity");
  tableRows(cityTable).forEach(([city]) => {
    if (!city) return;
    const opt = document.createElement("option");
    opt.value = city;
    opt.textContent = city;
    citySel.appendChild(opt);
  });

  const hubTable = await gvizQuery(ORDERS_GID, `SELECT ${O.hub}, COUNT(${O.awb}) GROUP BY ${O.hub} ORDER BY ${O.hub}`);
  const hubSel = document.getElementById("filterHub");
  tableRows(hubTable).forEach(([hub]) => {
    if (!hub) return;
    const opt = document.createElement("option");
    opt.value = hub;
    opt.textContent = hub;
    hubSel.appendChild(opt);
  });

  filtersLoaded = true;
}

/* Top KPI row */
async function loadKpis() {
  const where = buildWhere();
  const q = `SELECT COUNT(${O.awb}), COUNT(${O.breach}), AVG(${O.creationToAccept}), AVG(${O.reachToIntent}) ${where}`;
  const table = await gvizQuery(ORDERS_GID, q);
  const [row] = tableRows(table);
  const [total, breachCount, avgAccept, avgIntent] = row || [];

  document.getElementById("kpiTotal").textContent = fmtInt(total);
  document.getElementById("kpiBreach").textContent = total ? fmtPct(breachCount / total) : "–";
  document.getElementById("kpiAccept").textContent = avgAccept != null ? fmtNum(avgAccept) : "–";
  document.getElementById("kpiIntent").textContent = avgIntent != null ? fmtNum(avgIntent) : "–";

  // Rider-caused vs store-caused breach split.
  // ASSUMPTION (please confirm): a breached order is "rider delay" when the
  // Delay column = 'Rider_delay'; all other breached orders are counted as
  // "store delay". Adjust this logic if your actual attribution differs.
  const riderDelayQ = `SELECT COUNT(${O.awb}) WHERE ${O.breach} = 'Breach' AND ${O.delay} = 'Rider_delay' ${where ? "AND " + where.replace("WHERE ", "") : ""}`;
  const riderDelayTable = await gvizQuery(ORDERS_GID, riderDelayQ);
  const [[riderBreachCount = 0] = []] = tableRows(riderDelayTable);
  const storeBreachCount = (breachCount || 0) - (riderBreachCount || 0);
  document.getElementById("kpiRiderDelay") && (document.getElementById("kpiRiderDelay").textContent = total ? fmtPct(riderBreachCount / total) : "–");
  document.getElementById("kpiStoreDelay") && (document.getElementById("kpiStoreDelay").textContent = total ? fmtPct(storeBreachCount / total) : "–");

  // Hero band (top green strip). OTP+3 is APPROXIMATED as (1 - breach %) until
  // you confirm the exact +3min grace-window formula your BI tool uses.
  document.getElementById("heroOtp").textContent = total ? fmtPct(1 - breachCount / total) : "–";
  document.getElementById("heroRiderDelay").textContent = total ? fmtPct(riderBreachCount / total) : "–";
  document.getElementById("heroStoreDelay").textContent = total ? fmtPct(storeBreachCount / total) : "–";

  // Rider tab KPIs — active riders today + avg login hours
  const riderWhere = currentCity ? `WHERE ${R.city} = '${currentCity.replace(/'/g, "\\'")}'` : "";
  const riderQ = `SELECT COUNT(${R.riderId}), AVG(${R.loginHours}) ${riderWhere}`;
  const riderTable = await gvizQuery(RIDER_GID, riderQ);
  const [riderRow] = tableRows(riderTable);
  const [activeRiders, avgLoginHrs] = riderRow || [];
  document.getElementById("kpiRiders").textContent = fmtInt(activeRiders);
  document.getElementById("kpiLoginHrs").textContent = fmtNum(avgLoginHrs);
}

let hourChart, delayChart;

/* Hourly orders + breach % */
async function loadHourly() {
  const where = buildWhere();
  const q = `SELECT ${O.hour}, COUNT(${O.awb}), COUNT(${O.breach}) ${where} GROUP BY ${O.hour} ORDER BY ${O.hour}`;
  const table = await gvizQuery(ORDERS_GID, q);
  const rows = tableRows(table).filter(r => r[0] != null);

  const labels = rows.map(r => `${r[0]}:00`);
  const orders = rows.map(r => r[1] || 0);
  const breachPct = rows.map(r => (r[1] ? (100 * (r[2] || 0)) / r[1] : 0));

  const ctx = document.getElementById("hourChart");
  if (hourChart) hourChart.destroy();
  hourChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "Orders", data: orders, backgroundColor: "#c7ddd0", yAxisID: "y1", order: 2 },
        { type: "line", label: "Breach %", data: breachPct, borderColor: "#dc2626", backgroundColor: "#dc2626", tension: 0.3, pointRadius: 3, yAxisID: "y2", order: 1 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y1: { position: "left", ticks: { color: "#6b6b64" }, grid: { color: "#eee" } },
        y2: { position: "right", ticks: { color: "#dc2626" }, grid: { display: false }, min: 0 },
        x: { grid: { display: false } }
      },
      plugins: { legend: { position: "top", labels: { boxWidth: 10 } } }
    }
  });
}

/* Delay source split */
async function loadDelaySplit() {
  const where = buildWhere();
  const extra = where ? `${where} AND ${O.delaySource} IS NOT NULL` : `WHERE ${O.delaySource} IS NOT NULL`;
  const q = `SELECT ${O.delaySource}, COUNT(${O.awb}) ${extra} GROUP BY ${O.delaySource} ORDER BY COUNT(${O.awb}) DESC`;
  const table = await gvizQuery(ORDERS_GID, q);
  const rows = tableRows(table);

  const labels = rows.map(r => r[0] || "Unspecified");
  const values = rows.map(r => r[1] || 0);

  const ctx = document.getElementById("delayChart");
  if (delayChart) delayChart.destroy();
  delayChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: "#d97706", borderRadius: 4 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { ticks: { color: "#6b6b64" }, grid: { color: "#eee" } }, x: { grid: { display: false } } }
    }
  });
}

/* Hub-level table */
async function loadHubTable() {
  const where = buildWhere();
  const q = `SELECT ${O.hub}, ${O.city}, COUNT(${O.awb}), AVG(${O.creationToAccept}), AVG(${O.lm}), COUNT(${O.breach}) ${where} GROUP BY ${O.hub}, ${O.city} ORDER BY COUNT(${O.awb}) DESC LIMIT 20`;
  const table = await gvizQuery(ORDERS_GID, q);
  const rows = tableRows(table);

  const tbody = document.querySelector("#hubTable tbody");
  tbody.innerHTML = "";
  rows.forEach(([hub, city, orders, avgAccept, avgLm, breachCount]) => {
    const pct = orders ? (100 * (breachCount || 0)) / orders : 0;
    const cls = pct > 8 ? "breach-high" : pct > 4 ? "breach-mid" : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${hub ?? ""}</td><td>${city ?? ""}</td><td>${fmtInt(orders)}</td><td>${fmtNum(avgAccept)}</td><td>${fmtNum(avgLm)}</td><td class="${cls}">${pct.toFixed(1)}%</td>`;
    tbody.appendChild(tr);
  });
}

/* Rider-level table — joins order-level CT with login-tab hours by rider_id */
async function loadRiderTable() {
  const where = buildWhere();
  const orderQ = `SELECT ${O.riderId}, ${O.name}, ${O.hub}, COUNT(${O.awb}), AVG(${O.creationToAccept}), AVG(${O.reachToIntent}), COUNT(${O.breach}) ${where} GROUP BY ${O.riderId}, ${O.name}, ${O.hub} ORDER BY COUNT(${O.awb}) DESC LIMIT 25`;
  const orderTable = await gvizQuery(ORDERS_GID, orderQ);
  const orderRows = tableRows(orderTable);

  // Pull login hours for ALL riders in one grouped query (fast) rather than
  // building a long OR-list per rider (was timing out on large sheets).
  let loginMap = riderLoginCache;
  if (!loginMap) {
    const loginQ = `SELECT ${R.riderId}, SUM(${R.loginHours}) GROUP BY ${R.riderId}`;
    const loginTable = await gvizQuery(RIDER_GID, loginQ);
    loginMap = new Map();
    tableRows(loginTable).forEach(([id, hrs]) => loginMap.set(String(id), hrs));
    riderLoginCache = loginMap;
  }

  const tbody = document.querySelector("#riderTable tbody");
  tbody.innerHTML = "";
  orderRows.forEach(([riderId, name, hub, orders, avgAccept, avgIntent, breachCount]) => {
    const pct = orders ? (100 * (breachCount || 0)) / orders : 0;
    const cls = pct > 8 ? "breach-high" : pct > 4 ? "breach-mid" : "";
    const loginHrs = loginMap.get(String(riderId));
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${name ?? riderId ?? ""}</td><td>${hub ?? ""}</td><td>${fmtInt(orders)}</td><td>${fmtNum(avgAccept)}</td><td>${fmtNum(avgIntent)}</td><td class="${cls}">${pct.toFixed(1)}%</td><td>${loginHrs != null ? fmtNum(loginHrs, 1) : "–"}</td>`;
    tbody.appendChild(tr);
  });
}

/* Worst-performing stores: overall top 15, and top 5 per city, by breach % (min 15 orders to filter noise) */
const MIN_ORDERS_FOR_RANKING = 15;

async function loadWorstStores() {
  const where = buildWhere();
  const q = `SELECT ${O.hub}, ${O.city}, COUNT(${O.awb}), COUNT(${O.breach}) ${where} GROUP BY ${O.hub}, ${O.city}`;
  const table = await gvizQuery(ORDERS_GID, q);
  const rows = tableRows(table)
    .map(([hub, city, orders, breachCount]) => ({
      hub, city, orders: orders || 0,
      pct: orders ? (100 * (breachCount || 0)) / orders : 0
    }))
    .filter(r => r.orders >= MIN_ORDERS_FOR_RANKING);

  // Overall worst 15
  const worstOverall = [...rows].sort((a, b) => b.pct - a.pct).slice(0, 15);
  renderStoreRankTable("worstStoresTable", worstOverall);

  // Worst 5 per city
  const byCity = new Map();
  rows.forEach(r => {
    if (!byCity.has(r.city)) byCity.set(r.city, []);
    byCity.get(r.city).push(r);
  });
  const worstPerCity = [];
  [...byCity.keys()].sort().forEach(city => {
    const top5 = byCity.get(city).sort((a, b) => b.pct - a.pct).slice(0, 5);
    worstPerCity.push(...top5);
  });
  renderStoreRankTable("worstStoresByCityTable", worstPerCity, true);
}

function renderStoreRankTable(tableId, rows, showCityGroups) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = "";
  let lastCity = null;
  rows.forEach(r => {
    const cls = r.pct > 8 ? "breach-high" : r.pct > 4 ? "breach-mid" : "";
    const tr = document.createElement("tr");
    const cityCell = showCityGroups && r.city !== lastCity ? r.city : (showCityGroups ? "" : r.city);
    tr.innerHTML = `<td>${r.hub ?? ""}</td><td>${cityCell ?? ""}</td><td>${fmtInt(r.orders)}</td><td class="${cls}">${r.pct.toFixed(1)}%</td>`;
    tbody.appendChild(tr);
    lastCity = r.city;
  });
}

/* ---------- CSV export ---------- */
function tableToCsvRows(tableId) {
  const table = document.getElementById(tableId);
  const rows = [];
  table.querySelectorAll("tr").forEach(tr => {
    const cells = [...tr.children].map(td => `"${(td.textContent || "").replace(/"/g, '""')}"`);
    rows.push(cells.join(","));
  });
  return rows;
}

function downloadCsv() {
  const lines = [];
  lines.push(`Live CT Dashboard export,${new Date().toLocaleString()}`);
  lines.push(`Filters,City=${currentCity || "All"},Live=${currentLive || "All"},Date=${currentDate || "All"}`);
  lines.push("");
  lines.push("KPI,Value");
  lines.push(`Total orders,${document.getElementById("kpiTotal").textContent}`);
  lines.push(`SLA breach %,${document.getElementById("kpiBreach").textContent}`);
  lines.push(`Avg accept gap,${document.getElementById("kpiAccept").textContent}`);
  lines.push(`Avg reach→intent,${document.getElementById("kpiIntent").textContent}`);
  lines.push(`Active riders today,${document.getElementById("kpiRiders").textContent}`);
  lines.push(`Avg login hours,${document.getElementById("kpiLoginHrs").textContent}`);
  lines.push(`OTP+3 (approx),${document.getElementById("heroOtp").textContent}`);
  lines.push(`Rider delay %,${document.getElementById("heroRiderDelay").textContent}`);
  lines.push(`Store delay %,${document.getElementById("heroStoreDelay").textContent}`);
  lines.push("");
  lines.push("Hub-level CT and breach");
  lines.push(...tableToCsvRows("hubTable"));
  lines.push("");
  lines.push("Top 15 worst-performing stores overall");
  lines.push(...tableToCsvRows("worstStoresTable"));
  lines.push("");
  lines.push("Top 5 worst-performing stores per city");
  lines.push(...tableToCsvRows("worstStoresByCityTable"));
  lines.push("");
  lines.push("Rider-level CT, breach and login hours");
  lines.push(...tableToCsvRows("riderTable"));

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ct-dashboard-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------- wiring ---------- */
document.getElementById("filterCity").addEventListener("change", e => { currentCity = e.target.value; loadDashboard(); });
document.getElementById("filterHub").addEventListener("change", e => { currentHub = e.target.value; loadDashboard(); });
document.getElementById("filterLive").addEventListener("change", e => { currentLive = e.target.value; loadDashboard(); });
document.getElementById("filterDate").addEventListener("change", e => { currentDate = e.target.value; loadDashboard(); });
document.getElementById("refreshBtn").addEventListener("click", loadDashboard);
document.getElementById("csvBtn").addEventListener("click", downloadCsv);

loadDashboard();
setInterval(loadDashboard, REFRESH_MS);
