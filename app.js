/* global LP, LightweightCharts, CHAINS, store */  // CHAINS and store come from chain.js
"use strict";

const FULL_EVERY = 5 * 60_000;   // positions, fees, deposits
const PRICE_EVERY = 30_000;      // pool prices only
const CANDLES_EVERY = 60_000;

const state = {
  wallets: store.get("lpdash.wallets", []),
  selected: store.get("lpdash.selected", "all"),
  data: {},            // address -> { positions, groups, failures, krystal, loadedAt, loading, error }
  groupId: store.get("lpdash.group", null),
  tf: store.get("lpdash.tf", "15m"),
  fitRanges: store.get("lpdash.fit", false),
  pools: {},           // group id -> { list, at, error }
};

// ---------- formatting (same rules as the app) ----------

const nf = (min, max) => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: min, maximumFractionDigits: max });
const f0 = nf(0, 0), f01 = nf(0, 1), f02 = nf(0, 2), f2 = nf(2, 2);
function usd(v) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e6) return s + "$" + f02.format(a / 1e6) + "M";
  if (a >= 1e4) return s + "$" + f01.format(a / 1e3) + "K";
  if (a >= 1000) return s + "$" + f0.format(a);
  return s + "$" + f2.format(a);
}
const signedUsd = (v) => (v == null ? "—" : (v > 0.005 ? "+" : "") + usd(v));
const pct = (v) => (v == null || !isFinite(v) ? "—" : (v > 0.0005 ? "+" : "") + nf(1, 1).format(v * 100) + "%");
const SUB = "₀₁₂₃₄₅₆₇₈₉";
function price(v) {
  if (!v || !isFinite(v) || v <= 0) return "$0";
  if (v >= 1000) return "$" + f02.format(v);
  if (v >= 1) return "$" + new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 5 }).format(v);
  let zeros = Math.max(0, Math.ceil(-Math.log10(v)) - 1);
  let digits = Math.round(v * 10 ** (zeros + 4));
  if (digits >= 10000) { if (zeros === 0) return "$1"; zeros -= 1; digits = Math.round(digits / 10); }
  const sig = String(digits).replace(/0+$/, "") || "0";
  if (zeros >= 4) return "$0,0" + String(zeros).split("").map((d) => SUB[d]).join("") + sig;
  return "$0," + "0".repeat(zeros) + sig;
}
const amount = (v) => (v === 0 ? "0" : v >= 1000 ? f0.format(v) : new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 4 }).format(v));
const fee = (v) => (v == null ? "—" : nf(0, 3).format(v) + "%");
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pnlClass = (v) => (v == null ? "faint" : v >= 0.005 ? "up" : v <= -0.005 ? "down" : "muted");
const stClass = (s) => "st-" + s;
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + " с назад" : Math.round(s / 60) + " мин назад"; };

// ---------- wallets ----------

function importFromHash() {
  // #w=Имя:0x…,Имя2:0x… — a link that sets up the wallets in a new browser (the hash never leaves the browser).
  const m = location.hash.match(/^#w=(.+)$/);
  if (!m) return;
  const added = decodeURIComponent(m[1]).split(",").map((part) => {
    const [name, address] = part.includes(":") ? part.split(":") : ["", part];
    return { name: name.trim(), address: (address || "").trim().toLowerCase() };
  }).filter((w) => /^0x[0-9a-f]{40}$/.test(w.address));
  for (const w of added) if (!state.wallets.some((x) => x.address === w.address)) state.wallets.push({ name: w.name || short(w.address), address: w.address });
  store.set("lpdash.wallets", state.wallets);
  history.replaceState(null, "", location.pathname);
}

function visibleWallets() {
  return state.selected === "all" ? state.wallets : state.wallets.filter((w) => w.address === state.selected);
}

// ---------- loading ----------

async function loadWallet(w, quiet) {
  const d = state.data[w.address] ||= { positions: [], groups: [], failures: [], loadedAt: 0 };
  d.loading = true;
  if (!quiet) render();
  try {
    const r = await LP.loadWallet(w.address);
    // Contracts that couldn't be read this time keep their positions from the last read.
    const failed = new Set(r.failed);
    d.positions = [...r.positions, ...d.positions.filter((p) => failed.has(`${p.chainId}|${p.manager}`))];
    d.groups = LP.groupPositions(d.positions).map((g) => ({ ...g, wallet: w }));
    d.failures = r.failures;
    d.krystal = r.krystal;
    d.loadedAt = Date.now();
    d.error = null;
  } catch (e) {
    d.error = e.message || String(e);
  } finally {
    d.loading = false;
    render();
  }
}

let fullTimer = null;
async function loadAll() {
  setBusy(true);
  // One wallet after another: public nodes cut off bigger bursts.
  for (const w of [...state.wallets]) await loadWallet(w);
  setBusy(false);
}

async function priceTick() {
  const all = Object.values(state.data).flatMap((d) => d.groups);
  if (!all.length) return;
  const prices = await LP.poolPrices(all);
  for (const d of Object.values(state.data)) {
    if (!d.groups.length || d.loading) continue;
    const byGroup = Object.fromEntries(d.groups.map((g) => [g.id, g]));
    d.positions = d.positions.map((p) => { const id = `${p.chainId}-${p.poolId}`; return prices[id] && byGroup[id] ? LP.reprice(p, prices[id]) : p; });
    const wallet = d.groups[0].wallet;
    d.groups = LP.groupPositions(d.positions).map((g) => ({ ...g, wallet }));
    d.pricedAt = Date.now();
  }
  render();
  updateChartPrice();
}

function setBusy(on) {
  document.getElementById("refresh").classList.toggle("spin", on);
}

// ---------- rendering ----------

function groupsShown() {
  return visibleWallets().flatMap((w) => state.data[w.address]?.groups || []).sort((a, b) => b.value - a.value);
}

function render() {
  renderTabs();
  renderSummary();
  renderGroups();
  renderDetail();
  renderStatus();
}

function renderTabs() {
  const el = document.getElementById("wallet-tabs");
  const total = (ws) => ws.reduce((s, w) => s + (state.data[w.address]?.groups || []).reduce((x, g) => x + g.value, 0), 0);
  const tabs = [{ id: "all", name: "Все", value: total(state.wallets) }, ...state.wallets.map((w) => ({ id: w.address, name: w.name, value: total([w]) }))];
  el.innerHTML = tabs.map((t) => `<button class="tab" type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === state.selected}">${esc(t.name)}<span class="tab-value">${t.value ? usd(t.value) : ""}</span></button>`).join("");
}

function renderSummary() {
  const el = document.getElementById("summary");
  const groups = groupsShown();
  const positions = groups.flatMap((g) => g.positions);
  const value = groups.reduce((s, g) => s + g.value, 0);
  const fees = groups.reduce((s, g) => s + g.fees, 0);
  const known = groups.filter((g) => g.pnl != null);
  const pnl = known.length ? known.reduce((s, g) => s + g.pnl, 0) : null;
  const deposited = known.reduce((s, g) => s + g.deposited, 0);
  const inRange = positions.filter((p) => p.inRange).length;
  const outGroups = groups.filter((g) => g.status === "out").length;
  el.innerHTML = `
    <div class="metric"><span class="label">Стоимость</span><span class="value">${usd(value)}</span><span class="sub">${groups.length} пул. · ${positions.length} поз.</span></div>
    <div class="metric"><span class="label">PnL</span><span class="value ${pnlClass(pnl)}">${signedUsd(pnl)}</span><span class="sub">${deposited ? "вложено " + usd(deposited) + " · " + pct(pnl / deposited) : "нет истории вложений"}</span></div>
    <div class="metric"><span class="label">Комиссии</span><span class="value fees">${usd(fees)}</span><span class="sub">не собранные</span></div>
    <div class="metric"><span class="label">В диапазоне</span><span class="value ${positions.length && !inRange ? "st-out" : ""}">${inRange} из ${positions.length}</span><span class="sub">${outGroups ? outGroups + " пул. вне диапазонов" : "все пулы в работе"}</span></div>`;
}

function ladderSVG(g) {
  const values = [...g.positions.flatMap((p) => [p.lowUSD, p.highUSD]), g.price].filter((v) => v > 0);
  let lo = Math.min(...values) / 1.08, hi = Math.max(...values) * 1.08;
  if (!(hi > lo)) { lo = g.price * 0.9; hi = g.price * 1.1; }
  const span = Math.log(hi) - Math.log(lo);
  const x = (v) => (1 - (Math.log(v) - Math.log(lo)) / span) * 1000; // mirrored: expensive ranges on the left
  const color = (p) => p.inRange ? "var(--green)" : g.status === "inside" ? "var(--faint)" : g.status === "out" ? "var(--red)" : "var(--orange)";
  const bars = g.positions.map((p) => { const x0 = x(p.highUSD), x1 = x(p.lowUSD); return `<rect x="${x0.toFixed(1)}" y="9" width="${Math.max(3, x1 - x0 - 2).toFixed(1)}" height="12" rx="2" fill="${color(p)}" opacity="${p.inRange ? 1 : 0.6}"/>`; }).join("");
  return `<svg class="ladder" viewBox="0 0 1000 30" preserveAspectRatio="none" aria-hidden="true">
    <rect x="0" y="13.5" width="1000" height="3" rx="1.5" fill="var(--panel-2)"/>${bars}
    <rect x="${(x(g.price) - 2.5).toFixed(1)}" y="2" width="5" height="26" rx="1.5" fill="var(--price)"/></svg>`;
}

function coinIcon(g) {
  const logo = g.coin.logo;
  const tag = { 1: "ETH", 56: "BNB", 8453: "BASE", 4663: "RH" }[g.chainId] || "";
  return `<span class="coin-icon">${logo ? `<img src="${esc(logo)}" alt="" loading="lazy">` : esc(g.coin.symbol.slice(0, 1))}<span class="chain-dot">${tag}</span></span>`;
}

function renderGroups() {
  const el = document.getElementById("groups");
  if (!state.wallets.length) {
    el.innerHTML = `<div class="empty"><b>Добавьте кошелёк</b><span>Вставьте адрес — позиции Uniswap и PancakeSwap загрузятся прямо из блокчейна.</span><button class="btn" type="button" data-open-wallets>Добавить кошелёк</button></div>`;
    return;
  }
  const groups = groupsShown();
  const loading = visibleWallets().some((w) => !state.data[w.address] || (state.data[w.address].loading && !state.data[w.address].loadedAt));
  if (!groups.length) {
    el.innerHTML = loading ? `<div class="skeleton"></div><div class="skeleton"></div>` : `<div class="empty"><b>Открытых позиций нет</b><span>В этих кошельках нет открытых позиций Uniswap V3/V4 и PancakeSwap V3.</span></div>`;
    return;
  }
  if (!groups.some((g) => g.id + g.wallet.address === state.groupId)) state.groupId = groups[0].id + groups[0].wallet.address;
  el.innerHTML = groups.map((g) => {
    const key = g.id + g.wallet.address;
    const pnlPct = g.pnl != null && g.deposited ? pct(g.pnl / g.deposited) : "";
    return `<button class="card" type="button" data-group="${esc(key)}" aria-current="${key === state.groupId}">
      <div class="card-head">${coinIcon(g)}
        <div class="card-title"><b>${esc(g.pair)}</b><span>${esc(g.chainName)} · ${esc(g.project)} · ${fee(g.feeTier)}${state.selected === "all" && state.wallets.length > 1 ? " · " + esc(g.wallet.name) : ""}</span></div>
        <div class="card-right"><b>${usd(g.value)}</b><span>${price(g.price)}</span></div>
      </div>
      ${ladderSVG(g)}
      <div class="foot num"><span>${price(g.high)}</span><span>${price(g.low)}</span></div>
      <div class="row3">
        <div class="kv"><span class="k">Статус</span><span class="v text ${stClass(g.status)}">${esc(g.label)}</span></div>
        <div class="kv"><span class="k">Комиссии</span><span class="v fees">${usd(g.fees)}</span></div>
        <div class="kv right"><span class="k">PnL</span><span class="v ${pnlClass(g.pnl)}">${signedUsd(g.pnl)} <small>${pnlPct}</small></span></div>
      </div>
      <div class="foot"><span>${g.deposited ? "Вложено " + usd(g.deposited) + " → сейчас " + usd(g.value) : "Вложения неизвестны"}</span><span>${g.positions.length} поз. · ${g.inRange} в диапазоне</span></div>
    </button>`;
  }).join("");
}

function currentGroup() {
  return groupsShown().find((g) => g.id + g.wallet.address === state.groupId) || null;
}

let detailKey = null;
function renderDetail() {
  const g = currentGroup();
  const chartPanel = document.getElementById("chart-panel");
  if (!g) {
    for (const id of ["d-head", "d-positions", "d-pools"]) document.getElementById(id).innerHTML = "";
    chartPanel.hidden = true; detailKey = null;
    return;
  }
  const key = g.id + g.wallet.address;
  const c = CHAINS[g.chainId];
  const poolKey = g.kind === "v4" ? g.poolId : g.pool;
  const krystal = (p) => `https://defi.krystal.app/account/${p.owner}/positions/${p.manager}-${p.tokenId}?chainId=${p.chainId}`;
  document.getElementById("d-head").innerHTML = `
    <div class="panel">
      <div class="detail-head">${coinIcon(g)}<div><h2>${esc(g.pair)}</h2><span class="muted">${esc(g.chainName)} · ${esc(g.project)} · ${fee(g.feeTier)} · ${esc(g.wallet.name)}</span></div><span class="big">${price(g.price)}</span></div>
      <div class="stats">
        <div class="kv"><span class="k">Стоимость</span><span class="v">${usd(g.value)}</span></div>
        <div class="kv"><span class="k">PnL</span><span class="v ${pnlClass(g.pnl)}">${signedUsd(g.pnl)} <small>${g.pnl != null && g.deposited ? pct(g.pnl / g.deposited) : ""}</small></span></div>
        <div class="kv"><span class="k">Комиссии</span><span class="v fees">${usd(g.fees)}</span></div>
        <div class="kv"><span class="k">В диапазоне</span><span class="v ${stClass(g.status)}">${g.inRange}/${g.positions.length}</span></div>
      </div>
      <div class="links">
        <button class="btn copy" type="button" data-copy="${g.coin.address}">${esc(g.coin.symbol)} ${short(g.coin.address)} ⧉</button>
        <button class="btn copy" type="button" data-copy="${poolKey}">Пул ${short(poolKey)} ⧉</button>
        <a class="btn" href="https://dexscreener.com/${c.dex}/${poolKey}" target="_blank" rel="noopener">DexScreener ↗</a>
        <a class="btn" href="${c.explorer}/token/${g.coin.address}" target="_blank" rel="noopener">Обозреватель ↗</a>
      </div>
    </div>`;
  chartPanel.hidden = false;
  document.getElementById("chart-bar").innerHTML = `
    <span class="chip ${stClass(g.status)}">${esc(g.label)}</span>
    <div class="tf" role="group" aria-label="Таймфрейм">${["1m", "5m", "15m", "1h", "4h", "1d"].map((t) => `<button type="button" data-tf="${t}" aria-pressed="${t === state.tf}">${{ "1m": "1м", "5m": "5м", "15m": "15м", "1h": "1ч", "4h": "4ч", "1d": "1д" }[t]}</button>`).join("")}
      <button type="button" data-fit aria-pressed="${state.fitRanges}" title="Показать все диапазоны целиком">↕</button></div>`;
  const rows = g.positions.map((p) => {
    const dist = p.inRange ? "в диапазоне" : (g.price > p.highUSD ? "до входа " + pct(p.highUSD / g.price - 1) : "до входа " + pct(p.lowUSD / g.price - 1));
    const coinAmt = p.coin === 0 ? [p.amount0, p.token0.symbol, p.amount1, p.token1.symbol] : [p.amount1, p.token1.symbol, p.amount0, p.token0.symbol];
    return `<tr><td><span class="badge-n ${p.inRange ? "in" : ""}">${p.number}</span></td>
      <td>${price(p.lowUSD)} – ${price(p.highUSD)}</td>
      <td class="text ${p.inRange ? "up" : "muted"}">${dist}</td>
      <td>${amount(coinAmt[0])} ${esc(coinAmt[1])} · ${amount(coinAmt[2])} ${esc(coinAmt[3])}</td>
      <td class="r">${usd(p.value)}</td><td class="r fees">${usd(p.fees)}</td>
      <td class="r ${pnlClass(p.pnl)}">${signedUsd(p.pnl)}</td>
      <td><a href="${krystal(p)}" target="_blank" rel="noopener" title="Позиция в Krystal">#${p.tokenId}</a></td></tr>`;
  }).join("");
  document.getElementById("d-positions").innerHTML = `
    <div class="panel"><h3>Позиции (${g.positions.length})<small>диапазоны в $ за 1 ${esc(g.coin.symbol)}</small></h3>
      <div class="table-wrap"><table><thead><tr><th>№</th><th>Диапазон</th><th>Где цена</th><th>Монеты</th><th class="r">Стоимость</th><th class="r">Комиссии</th><th class="r">PnL</th><th>NFT</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  document.getElementById("d-pools").innerHTML = `<div class="panel" id="pools-panel">${poolsHTML(g)}</div>`;
  ensureChart();
  drawLines(g);
  if (detailKey !== key) {
    detailKey = key;
    candleKey = null;
    series.setData([]);
    showChartMsg("Загружаю свечи…");
    loadCandles(g);
  }
  if (!state.pools[g.id] || Date.now() - state.pools[g.id].at > 60_000) loadPools(g);
}

function poolsHTML(g) {
  const entry = state.pools[g.id];
  if (!entry || (!entry.list && !entry.error)) return `<h3>Пулы ${esc(g.coin.symbol)} · ${esc(g.chainName)}</h3><span class="muted">Загружаю…</span>`;
  if (entry.error && !entry.list) return `<h3>Пулы ${esc(g.coin.symbol)}</h3><span class="muted">Не удалось загрузить пулы: ${esc(entry.error)}</span>`;
  const mineKey = (g.kind === "v4" ? g.poolId : g.pool).toLowerCase();
  const list = [...entry.list].sort((a, b) => (b.key === mineKey) - (a.key === mineKey) || b.v1h - a.v1h);
  const total1h = list.reduce((s, p) => s + p.v1h, 0), total5m = list.reduce((s, p) => s + p.v5m, 0);
  const rows = list.map((p) => {
    const share1h = total1h ? p.v1h / total1h : 0, share5m = total5m ? p.v5m / total5m : 0;
    const trend = total5m && share5m - share1h >= 0.1 ? " ↑" : total5m && share5m - share1h <= -0.1 ? " ↓" : "";
    const perK = p.liquidity > 0 ? p.v1h * 24 * p.fee / 100 / p.liquidity * 1000 : null;
    const dex = p.dexId === "pancakeswap" ? "PancakeSwap" : p.dexId === "uniswap" ? "Uniswap" : p.dexId;
    return `<tr class="${p.key === mineKey ? "mine" : ""}"><td class="text"><a href="${esc(p.url || "#")}" target="_blank" rel="noopener">${esc(dex)} ${p.version.toUpperCase()} · ${fee(p.fee)} · ${esc(p.quoteSymbol)}</a>${p.key === mineKey ? ' <span class="chip mine">ваш</span>' : ""}</td>
      <td class="r">${usd(p.liquidity)}</td><td class="r">${usd(p.v5m)}</td><td class="r">${usd(p.v1h)}</td><td class="r">${usd(p.v24h)}</td>
      <td class="r">${Math.round(share1h * 100)}%${trend}</td><td class="r fees">${perK == null ? "—" : usd(perK)}</td></tr>`;
  }).join("");
  return `<h3>Пулы ${esc(g.coin.symbol)} · ${esc(g.chainName)}<small>обновлено ${ago(entry.at)}</small></h3>
    <div class="table-wrap"><table><thead><tr><th>Пул</th><th class="r">Ликвидность</th><th class="r">5 мин</th><th class="r">1 час</th><th class="r">24 ч</th><th class="r">Доля 1ч</th><th class="r">В день на $1000</th></tr></thead><tbody>${rows || `<tr><td class="text muted" colspan="7">Нет пулов с комиссией и сделками за час</td></tr>`}</tbody></table></div>
    <span class="faint">Пулы к USDC, USDT, USDG или ETH с известной комиссией и сделками за час. Объёмы — DexScreener, комиссии — из блокчейна. Доля — часть торгов среди этих пулов за час, ↑↓ — куда сдвигается доля за 5 минут.</span>`;
}

async function loadPools(g) {
  state.pools[g.id] = { ...(state.pools[g.id] || {}), at: Date.now() };
  try {
    const list = await LP.coinPools(g.chainId, g.coin.address.toLowerCase());
    state.pools[g.id] = { list, at: Date.now() };
  } catch (e) {
    state.pools[g.id] = { ...(state.pools[g.id] || {}), error: e.message, at: Date.now() };
  }
  const panel = document.getElementById("pools-panel");
  const cur = currentGroup();
  if (panel && cur && cur.id === g.id) panel.innerHTML = poolsHTML(cur);
}

function renderStatus() {
  const el = document.getElementById("status");
  const ds = visibleWallets().map((w) => state.data[w.address]).filter(Boolean);
  const loading = ds.some((d) => d.loading);
  const last = Math.max(0, ...ds.map((d) => Math.max(d.loadedAt || 0, d.pricedAt || 0)));
  el.textContent = loading ? "Обновляю…" : last ? "Обновлено " + new Date(last).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const notes = [];
  for (const w of visibleWallets()) {
    const d = state.data[w.address];
    if (!d) continue;
    if (d.error) notes.push(`${w.name}: ${d.error}`);
    if (d.failures?.length) notes.push(`${w.name}: не прочитано (показаны прошлые данные) — ${d.failures.join("; ")}`);
    if (d.krystal === false) notes.push(`${w.name}: Krystal недоступен — PnL без истории вложений, новые позиции V4 старше часа могут не показаться`);
  }
  document.getElementById("note").textContent = notes.length ? notes.join(" · ") : "Данные позиций — из блокчейна; суммы вложений для PnL — из Krystal. Цены обновляются каждые 30 секунд, позиции — каждые 5 минут.";
}

// ---------- chart ----------

let chart = null, series = null, lines = [], candleKey = null;
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function showChartMsg(text) {
  const m = document.getElementById("chart-msg");
  m.textContent = text || "";
  m.hidden = !text;
}
function destroyChart() {
  if (chart) { chart.remove(); chart = null; series = null; lines = []; }
  candleKey = null; detailKey = null;
}

// One chart for the page, in a container that is never re-rendered; only its data and lines change.
function ensureChart() {
  if (chart) return;
  chart = LightweightCharts.createChart(document.getElementById("chart"), {
    autoSize: true,
    layout: { background: { color: cssVar("--panel") }, textColor: cssVar("--muted"), fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
    grid: { vertLines: { color: cssVar("--line") }, horzLines: { color: cssVar("--line") } },
    rightPriceScale: { borderColor: cssVar("--line") },
    timeScale: { borderColor: cssVar("--line"), timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    localization: { locale: "ru-RU", priceFormatter: (v) => price(v) },
  });
  series = chart.addCandlestickSeries({
    upColor: cssVar("--green"), downColor: cssVar("--red"), wickUpColor: cssVar("--green"), wickDownColor: cssVar("--red"), borderVisible: false,
    priceLineVisible: false, lastValueVisible: false,
    priceFormat: { type: "custom", formatter: (v) => price(v), minMove: 1e-12 },
    autoscaleInfoProvider: (original) => {
      const r = original();
      const cur = currentGroup();
      if (!r || !cur) return r;
      // Scaled to the candles (and the current price); ↕ fits every range too.
      const lo = Math.min(r.priceRange.minValue, cur.price), hi = Math.max(r.priceRange.maxValue, cur.price);
      if (!state.fitRanges) return { priceRange: { minValue: lo, maxValue: hi } };
      return { priceRange: { minValue: Math.min(lo, cur.low), maxValue: Math.max(hi, cur.high) } };
    },
  });
}

function drawLines(g) {
  if (!series) return;
  for (const l of lines) series.removePriceLine(l);
  lines = [];
  for (const p of g.positions) {
    for (const [v, edge] of [[p.lowUSD, "низ"], [p.highUSD, "верх"]]) {
      lines.push(series.createPriceLine({ price: v, color: p.inRange ? cssVar("--green") : cssVar("--faint"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: g.positions.length <= 6 ? `№${p.number} ${edge}` : "" }));
    }
  }
  lines.push(series.createPriceLine({ price: g.price, color: cssVar("--price"), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "" }));
}

function updateChartPrice() {
  const g = currentGroup();
  if (g && series) drawLines(g);
}

async function loadCandles(g) {
  const key = g.id + "|" + state.tf;
  try {
    const rows = await LP.candles(g, state.tf);
    const cur = currentGroup();
    if (!series || !cur || cur.id !== g.id) return;
    series.setData(rows);
    if (candleKey !== key) { chart.timeScale().fitContent(); candleKey = key; }
    showChartMsg(rows.length ? "" : "GeckoTerminal пока не знает свечей этого пула");
  } catch (e) {
    showChartMsg("График недоступен: " + e.message);
  }
}
setInterval(() => { const g = currentGroup(); if (g && series) loadCandles(g); }, CANDLES_EVERY);

// ---------- events ----------

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-tab],[data-group],[data-tf],[data-fit],[data-copy],[data-open-wallets],[data-remove]");
  if (!t) return;
  if (t.dataset.tab) {
    state.selected = t.dataset.tab; store.set("lpdash.selected", state.selected);
    state.groupId = null; render();
  } else if (t.dataset.group) {
    state.groupId = t.dataset.group; store.set("lpdash.group", state.groupId); render();
    if (window.innerWidth <= 980) document.getElementById("detail").scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (t.dataset.tf) {
    state.tf = t.dataset.tf; store.set("lpdash.tf", state.tf); candleKey = null; render();
    const g = currentGroup(); if (g) { showChartMsg("Загружаю свечи…"); loadCandles(g); }
  } else if (t.hasAttribute("data-fit")) {
    state.fitRanges = !state.fitRanges; store.set("lpdash.fit", state.fitRanges); render();
    if (chart) { chart.priceScale("right").applyOptions({ autoScale: true }); chart.timeScale().fitContent(); }
  } else if (t.dataset.copy) {
    try { await navigator.clipboard.writeText(t.dataset.copy); const old = t.textContent; t.textContent = "Скопировано"; setTimeout(() => { t.textContent = old; }, 1200); } catch { /* clipboard refused */ }
  } else if (t.hasAttribute("data-open-wallets")) {
    openWallets();
  } else if (t.dataset.remove) {
    state.wallets = state.wallets.filter((w) => w.address !== t.dataset.remove);
    delete state.data[t.dataset.remove];
    store.set("lpdash.wallets", state.wallets);
    if (state.selected === t.dataset.remove) state.selected = "all";
    renderWalletList(); render();
  }
});

document.getElementById("refresh").addEventListener("click", () => loadAll());
document.getElementById("wallets-btn").addEventListener("click", openWallets);
document.getElementById("w-close").addEventListener("click", () => document.getElementById("wallets-dialog").close());

function openWallets() {
  renderWalletList();
  document.getElementById("wallets-dialog").showModal();
}
function renderWalletList() {
  document.getElementById("wallet-list").innerHTML = state.wallets.map((w) =>
    `<li><b>${esc(w.name)}</b><span class="addr">${w.address}</span><button class="btn ghost" type="button" data-remove="${w.address}">Убрать</button></li>`).join("")
    || `<li class="muted">Пока нет кошельков</li>`;
}
document.getElementById("wallet-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("w-name").value.trim();
  const address = document.getElementById("w-address").value.trim().toLowerCase();
  const err = document.getElementById("w-error");
  if (!/^0x[0-9a-f]{40}$/.test(address)) { err.textContent = "Адрес должен начинаться с 0x и содержать 42 символа"; err.hidden = false; return; }
  if (state.wallets.some((w) => w.address === address)) { err.textContent = "Этот кошелёк уже добавлен"; err.hidden = false; return; }
  err.hidden = true;
  const w = { name: name || short(address), address };
  state.wallets.push(w);
  store.set("lpdash.wallets", state.wallets);
  document.getElementById("w-name").value = ""; document.getElementById("w-address").value = "";
  renderWalletList(); render();
  loadWallet(w);
});

// ---------- start ----------

importFromHash();
if (state.selected !== "all" && !state.wallets.some((w) => w.address === state.selected)) state.selected = "all";
render();
loadAll();
fullTimer = setInterval(loadAll, FULL_EVERY);
setInterval(priceTick, PRICE_EVERY);
setInterval(renderStatus, 15_000);
document.addEventListener("visibilitychange", () => {
  // Back to the tab after a while: refresh right away.
  if (document.visibilityState === "visible") {
    const last = Math.min(...state.wallets.map((w) => state.data[w.address]?.loadedAt || 0));
    if (Date.now() - last > FULL_EVERY) loadAll();
  }
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { destroyChart(); render(); });
