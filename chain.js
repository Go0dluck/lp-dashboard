// LP positions straight from the chain — the same reads the iOS app makes (Uniswap V3/V4, PancakeSwap V3).
// Krystal only adds V4 token ids the chain can't list and deposit history for PnL.
/* global ethers */
"use strict";

const ZERO = "0x0000000000000000000000000000000000000000";
const Q96 = 2 ** 96;
const TWO128 = 1n << 128n;
const TWO256 = 1n << 256n;
const MAX128 = TWO128 - 1n;

const CHAINS = {
  1: {
    name: "Ethereum", native: "ETH", wrapped: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    rpc: ["https://ethereum-rpc.publicnode.com"], gecko: "eth", dex: "ethereum",
    explorer: "https://etherscan.io", poolManager: "0x000000000004444c5dc75cb358380d2e3de08a90",
    quotes: { [ZERO]: "ETH", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC", "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH" },
    stables: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7"],
  },
  56: {
    name: "BNB Chain", native: "BNB", wrapped: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    rpc: ["https://bsc-rpc.publicnode.com"], gecko: "bsc", dex: "bsc",
    explorer: "https://bscscan.com", poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    quotes: { "0x55d398326f99059ff775485246999027b3197955": "USDT", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC" },
    stables: ["0x55d398326f99059ff775485246999027b3197955", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"],
  },
  8453: {
    name: "Base", native: "ETH", wrapped: "0x4200000000000000000000000000000000000006",
    rpc: ["https://base-rpc.publicnode.com"], gecko: "base", dex: "base",
    explorer: "https://basescan.org", poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    quotes: { [ZERO]: "ETH", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC", "0x4200000000000000000000000000000000000006": "WETH" },
    stables: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  },
  4663: {
    name: "Robinhood", native: "ETH", wrapped: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    rpc: ["https://robinhood-rpc.publicnode.com", "https://rpc.mainnet.chain.robinhood.com"], gecko: "robinhood", dex: "robinhood",
    explorer: "https://robin.etherscan.io", poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    quotes: { [ZERO]: "ETH", "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG", "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "WETH" },
    stables: ["0x5fc5360d0400a0fd4f2af552add042d716f1d168"],
  },
};

const MANAGERS = [
  { chainId: 4663, address: "0x58daec3116aae6d93017baaea7749052e8a04fa7", kind: "v4", project: "Uniswap V4" },
  { chainId: 4663, address: "0x73991a25c818bf1f1128deaab1492d45638de0d3", kind: "v3", project: "Uniswap V3" },
  { chainId: 56, address: "0x7b8a01b39d58278b5de7e48c8449c9f4f5170613", kind: "v3", project: "Uniswap V3" },
  { chainId: 56, address: "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364", kind: "v3", project: "PancakeSwap V3" },
  { chainId: 56, address: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b", kind: "v4", project: "Uniswap V4" },
  { chainId: 8453, address: "0x03a520b32c04bf3beef7beb72e919cf822ed34f1", kind: "v3", project: "Uniswap V3" },
  { chainId: 8453, address: "0x7c5f5a4bbd8fd63184577525326123b519429bdc", kind: "v4", project: "Uniswap V4" },
  { chainId: 1, address: "0xc36442b4a4522e871399cd717abdd847ab11fe88", kind: "v3", project: "Uniswap V3" },
  { chainId: 1, address: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e", kind: "v4", project: "Uniswap V4" },
];

// Deepest USD pools for the native coins (same as the app's ReferencePrices).
const REFERENCE = {
  ETH: [{ chainId: 1, pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", coinIs0: false, d0: 6, d1: 18 },
        { chainId: 8453, pool: "0xd0b53d9277642d899df5c87a3966a349a798f224", coinIs0: true, d0: 18, d1: 6 }],
  BNB: [{ chainId: 56, pool: "0x172fcd41e0913e95784454622d1c3724f546f849", coinIs0: false, d0: 18, d1: 18 }],
};

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "USDG", "DAI", "USDC.E", "USDBC", "FDUSD", "USD1"]);
const MAJORS = new Set(["ETH", "WETH", "BNB", "WBNB", "BTC", "WBTC", "CBBTC"]);

// ---------- small helpers ----------

const sel = {};
function selector(signature) {
  if (!sel[signature]) sel[signature] = ethers.id(signature).slice(0, 10);
  return sel[signature];
}
const coder = ethers.AbiCoder.defaultAbiCoder();
function encode(signature, types, values) {
  return selector(signature) + (types.length ? coder.encode(types, values).slice(2) : "");
}
function words(hex) {
  if (!hex || hex.length < 66) return null;
  const out = [];
  for (let i = 2; i + 64 <= hex.length; i += 64) out.push(BigInt("0x" + hex.slice(i, i + 64)));
  return out;
}
const toAddress = (w) => "0x" + w.toString(16).padStart(64, "0").slice(-40);
const int24 = (v) => { const r = Number(v & 0xffffffn); return r >= 0x800000 ? r - 0x1000000 : r; };
const signed256 = (w) => (w >= (1n << 255n) ? -Number(TWO256 - w) : Number(w));
const sub256 = (a, b) => (a >= b ? a - b : TWO256 - b + a);
const word32 = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const keccak = (hex) => ethers.keccak256(hex);
function mappingSlot(keyHex, slot) {
  return BigInt(keccak("0x" + keyHex.replace(/^0x/, "").padStart(64, "0") + word32(slot)));
}
const int24Hex = (v) => (BigInt.asUintN(24, BigInt(v))).toString(16).padStart(6, "0");

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

// ---------- JSON-RPC ----------

// At most 4 requests at a time per node: free public nodes answer bursts with 429.
const slots = {};
async function withSlot(url, fn) {
  const s = (slots[url] ||= { busy: 0, queue: [] });
  if (s.busy >= 4) await new Promise((go) => s.queue.push(go));
  else s.busy++;
  try { return await fn(); } finally {
    const next = s.queue.shift();
    if (next) next(); else s.busy--;
  }
}
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function rpcBatch(chainId, calls, chunk = 50) {
  const urls = CHAINS[chainId].rpc;
  const results = new Array(calls.length).fill(null);
  const starts = [];
  for (let s = 0; s < calls.length; s += chunk) starts.push(s);

  async function runChunk(start) {
    const slice = calls.slice(start, start + chunk);
    const body = JSON.stringify(slice.map((c, i) => ({ jsonrpc: "2.0", id: start + i, method: c.method || "eth_call", params: c.params || [{ to: c.to, data: c.data, ...(c.from ? { from: c.from } : {}) }, "latest"] })));
    let lastError, partial = null;
    // Up to 4 rounds over the chain's nodes, waiting 1.5 / 3.5 / 7 s in between (rate limits clear in seconds).
    for (let round = 0; round < 4; round++) {
      if (round) await pause([0, 1500, 3500, 7000][round]);
      for (const url of urls) {
        try {
          const items = await withSlot(url, async () => {
            const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          });
          if (!Array.isArray(items)) throw new Error("неожиданный ответ узла");
          const isNodeError = (x) => x.error && x.error.code !== 3 && !/revert|invalid opcode|out of gas/i.test(x.error.message || "");
          if (items.length < slice.length || items.some(isNodeError)) {
            // Keep the most complete partial answer seen so far.
            const answered = items.filter((x) => !x.error).length;
            if (!partial || answered > partial.filter((x) => !x.error).length) partial = items;
            lastError = new Error("узел ответил не на все запросы");
            continue;
          }
          for (const it of items) if (typeof it.id === "number") results[it.id] = it.result ?? null;
          return;
        } catch (e) { lastError = e; }
      }
    }
    // Every node struggled: keep what the last partial answer had; callers treat gaps as "not read".
    if (partial) { for (const it of partial) if (typeof it.id === "number" && !it.error) results[it.id] = it.result ?? null; return; }
    throw lastError || new Error("RPC не ответил");
  }

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, starts.length) }, async () => {
    while (next < starts.length) await runChunk(starts[next++]);
  }));
  return results;
}
const call = (to, data, from) => ({ to, data, from });

// ---------- tokens and prices ----------

const tokenCache = store.get("lpdash.tokens", {});
async function tokenInfo(chainId, addresses) {
  const out = {};
  const missing = [];
  for (const a of addresses) {
    if (a === ZERO) out[a] = { address: a, symbol: CHAINS[chainId].native, decimals: 18 };
    else if (tokenCache[chainId + "|" + a]) out[a] = tokenCache[chainId + "|" + a];
    else missing.push(a);
  }
  if (missing.length) {
    const res = await rpcBatch(chainId, missing.flatMap((a) => [call(a, "0x95d89b41"), call(a, "0x313ce567")]));
    missing.forEach((a, i) => {
      const symHex = res[i * 2], decHex = res[i * 2 + 1];
      let symbol = "?";
      try { symbol = coder.decode(["string"], symHex)[0]; } catch {
        try { symbol = ethers.decodeBytes32String(symHex); } catch { /* unnamed */ }
      }
      const token = { address: a, symbol, decimals: decHex ? Number(BigInt(decHex)) : 18 };
      out[a] = token;
      if (symHex && decHex) tokenCache[chainId + "|" + a] = token;
    });
    store.set("lpdash.tokens", tokenCache);
  }
  return out;
}

const refCache = {};
async function nativeUSD(kind) {
  const hit = refCache[kind];
  if (hit && Date.now() - hit.at < 60_000) return hit.price;
  for (const s of REFERENCE[kind]) {
    try {
      const [res] = await rpcBatch(s.chainId, [call(s.pool, selector("slot0()"))]);
      const w = words(res);
      if (!w) continue;
      const sqrt = Number(w[0] & ((1n << 160n) - 1n)) / Q96;
      const p = sqrt * sqrt * 10 ** (s.d0 - s.d1);
      const usd = s.coinIs0 ? p : 1 / p;
      if (isFinite(usd) && usd > 0) { refCache[kind] = { price: usd, at: Date.now() }; return usd; }
    } catch { /* next source */ }
  }
  return hit ? hit.price : null;
}
async function quoteUSD(chainId, address) {
  const c = CHAINS[chainId];
  const a = address.toLowerCase();
  if (a === ZERO || a === c.wrapped) return nativeUSD(chainId === 56 ? "BNB" : "ETH");
  if (c.stables.includes(a)) return 1;
  return null;
}
async function dexPrices(chainId, addresses) {
  const out = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const slice = addresses.slice(i, i + 30);
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/${CHAINS[chainId].dex}/${slice.join(",")}`);
      const pairs = await r.json();
      pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      for (const p of pairs) {
        const base = p.baseToken?.address?.toLowerCase();
        if (base && out[base] == null && Number(p.priceUsd) > 0) out[base] = { price: Number(p.priceUsd), logo: p.info?.imageUrl };
      }
    } catch { /* no prices */ }
  }
  return out;
}

// Which side to chart: the coin, not the stable/major it trades against.
function chartIndex(t0, t1) {
  const q = (t) => STABLE_SYMBOLS.has(t.symbol.toUpperCase()) ? 2 : MAJORS.has(t.symbol.toUpperCase()) ? 1 : 0;
  return q(t0) > q(t1) ? 1 : 0;
}

// ---------- discovery cache (dead ids, known V4 ids, strikes) ----------

function cacheFor(owner, m) {
  const all = store.get("lpdash.discovery", {});
  return all[`${owner}|${m.chainId}|${m.address}`] || { dead: [], known: [], strikes: {}, info: {} };
}
function saveCache(owner, m, entry) {
  const all = store.get("lpdash.discovery", {});
  all[`${owner}|${m.chainId}|${m.address}`] = entry;
  store.set("lpdash.discovery", all);
}

// ---------- per manager ----------

const TRANSFER = () => ethers.id("Transfer(address,address,uint256)");
const topicOf = (owner) => "0x" + owner.slice(2).padStart(64, "0");

// NFTs that came to or left `owner` after block `after` (latest move wins); null if the logs can't be read.
async function transferUpdate(m, owner, after, head) {
  const range = { address: m.address, fromBlock: "0x" + (after + 1).toString(16), toBlock: "0x" + head.toString(16) };
  const [inLogs, outLogs] = await rpcBatch(m.chainId, [
    { method: "eth_getLogs", params: [{ ...range, topics: [TRANSFER(), null, topicOf(owner)] }] },
    { method: "eth_getLogs", params: [{ ...range, topics: [TRANSFER(), topicOf(owner)] }] },
  ]);
  if (!Array.isArray(inLogs) || !Array.isArray(outLogs)) return null;
  const latest = {};
  const order = (l) => Number(BigInt(l.blockNumber)) * 100000 + Number(BigInt(l.logIndex));
  for (const [logs, incoming] of [[inLogs, true], [outLogs, false]]) {
    for (const l of logs) {
      const id = BigInt(l.topics[3]).toString();
      if (!latest[id] || latest[id].order < order(l)) latest[id] = { order: order(l), incoming };
    }
  }
  return latest;
}

async function loadV3(m, owner, entry) {
  const [headHex, countHex] = await rpcBatch(m.chainId, [{ method: "eth_blockNumber", params: [] }, call(m.address, encode("balanceOf(address)", ["address"], [owner]))]);
  const head = Number(BigInt(headHex || "0x0"));
  const count = countHex ? Number(BigInt(countHex)) : 0;
  if (!count) { entry.v3 = { ids: [], block: head }; return []; }
  // Wallets that farm a lot hold hundreds of closed NFTs: after one full listing only what came in or left
  // is applied (Transfer logs), and the NFT count confirms the list.
  let owned = null;
  if (entry.v3 && head - entry.v3.block <= 4000) {
    const update = await transferUpdate(m, owner, entry.v3.block, head).catch(() => null);
    if (update) {
      const set = new Set(entry.v3.ids);
      for (const [id, u] of Object.entries(update)) { if (u.incoming) set.add(id); else set.delete(id); }
      if (set.size === count) owned = [...set];
    }
  }
  if (!owned) {
    const idRes = await rpcBatch(m.chainId, Array.from({ length: count }, (_, i) =>
      call(m.address, encode("tokenOfOwnerByIndex(address,uint256)", ["address", "uint256"], [owner, i]))));
    if (idRes.some((r) => !r)) throw new Error("узел вернул не все позиции");
    owned = idRes.map((r) => BigInt(r).toString());
  }
  entry.v3 = { ids: owned, block: head };
  const dead = new Set(entry.dead);
  const ids = owned.filter((id) => !dead.has(id)).map((id) => BigInt(id));
  if (!ids.length) return [];
  const posRes = await rpcBatch(m.chainId, ids.map((id) => call(m.address, encode("positions(uint256)", ["uint256"], [id]))));
  const open = [];
  ids.forEach((id, i) => {
    const w = words(posRes[i]);
    if (!w || w.length < 12) throw new Error("узел вернул не все позиции");
    if (w[7] === 0n) { if (w[10] === 0n && w[11] === 0n) entry.dead.push(id.toString()); return; }
    open.push({ tokenId: id, token0: toAddress(w[2]), token1: toAddress(w[3]), fee: Number(w[4]), tickLower: signed256(w[5]), tickUpper: signed256(w[6]), liquidity: w[7] });
  });
  if (!open.length) return [];
  // Pool addresses (cached), then prices and pending fees in one go.
  if (!entry.factory) {
    const [f] = await rpcBatch(m.chainId, [call(m.address, selector("factory()"))]);
    entry.factory = toAddress(words(f)[0]);
  }
  entry.pools = entry.pools || {};
  const missing = [...new Set(open.map((p) => `${p.token0}|${p.token1}|${p.fee}`))].filter((k) => !entry.pools[k]);
  if (missing.length) {
    const res = await rpcBatch(m.chainId, missing.map((k) => { const [a, b, f] = k.split("|"); return call(entry.factory, encode("getPool(address,address,uint24)", ["address", "address", "uint24"], [a, b, Number(f)])); }));
    missing.forEach((k, i) => { const w = words(res[i]); if (w) entry.pools[k] = toAddress(w[0]); });
  }
  const pools = [...new Set(open.map((p) => entry.pools[`${p.token0}|${p.token1}|${p.fee}`]))];
  const collectSig = "collect((uint256,address,uint128,uint128))";
  const res = await rpcBatch(m.chainId, [
    ...pools.map((p) => call(p, selector("slot0()"))),
    ...open.map((p) => call(m.address, encode(collectSig, ["(uint256,address,uint128,uint128)"], [[p.tokenId, owner, MAX128, MAX128]]), owner)),
  ]);
  const slot0 = {};
  pools.forEach((p, i) => { const w = words(res[i]); if (w) slot0[p] = { sqrt: Number(w[0]) / Q96, tick: signed256(w[1]) }; });
  return open.map((p, i) => {
    const pool = entry.pools[`${p.token0}|${p.token1}|${p.fee}`];
    const s = slot0[pool];
    if (!s) throw new Error("не прочитана цена пула");
    const f = words(res[pools.length + i]) || [0n, 0n];
    return { ...p, pool, poolId: pool, sqrtPrice: s.sqrt, tick: s.tick, fees0: f[0], fees1: f[1] };
  });
}

async function recentTransfersIn(m, owner) {
  try {
    const [headHex] = await rpcBatch(m.chainId, [{ method: "eth_blockNumber", params: [] }]);
    const head = Number(BigInt(headHex));
    const filter = { address: m.address, fromBlock: "0x" + Math.max(0, head - 4000).toString(16), toBlock: "0x" + head.toString(16),
      topics: [ethers.id("Transfer(address,address,uint256)"), null, "0x" + owner.slice(2).padStart(64, "0")] };
    const [logs] = await rpcBatch(m.chainId, [{ method: "eth_getLogs", params: [filter] }]);
    return (logs || []).map((l) => BigInt(l.topics[3]).toString());
  } catch { return []; }
}

async function loadV4(m, owner, entry, hint) {
  const dead = new Set(entry.dead);
  const fresh = await recentTransfersIn(m, owner);
  const candidates = [...new Set([...entry.known.filter((id) => !dead.has(id)), ...hint, ...fresh])];
  entry.known = [...new Set([...entry.known, ...candidates])];
  if (!candidates.length) return [];
  const own = await rpcBatch(m.chainId, candidates.flatMap((id) => [
    call(m.address, encode("ownerOf(uint256)", ["uint256"], [id])),
    call(m.address, encode("getPositionLiquidity(uint256)", ["uint256"], [id])),
  ]));
  const open = [];
  candidates.forEach((id, i) => {
    const liq = words(own[i * 2 + 1]);
    if (!liq) throw new Error("узел вернул не все позиции");
    const holder = own[i * 2] ? toAddress(words(own[i * 2])[0]) : null;
    if (holder !== owner || liq[0] === 0n) {
      // Closed only after 3 reads in a row: a node a few blocks behind says "no such NFT" about a fresh one.
      entry.strikes[id] = (entry.strikes[id] || 0) + 1;
      if (entry.strikes[id] >= 3) { entry.dead.push(id); delete entry.strikes[id]; }
    } else {
      delete entry.strikes[id];
      entry.dead = entry.dead.filter((d) => d !== id);
      open.push({ tokenId: BigInt(id), liquidity: liq[0] });
    }
  });
  if (!open.length) return [];
  const missing = open.filter((p) => !entry.info[p.tokenId.toString()]);
  if (missing.length) {
    const res = await rpcBatch(m.chainId, missing.map((p) => call(m.address, encode("getPoolAndPositionInfo(uint256)", ["uint256"], [p.tokenId]))));
    missing.forEach((p, i) => {
      const hex = res[i];
      const w = words(hex);
      if (!w || w.length < 6) throw new Error("узел вернул не все позиции");
      entry.info[p.tokenId.toString()] = {
        token0: toAddress(w[0]), token1: toAddress(w[1]), fee: Number(w[2] & 0xffffffn),
        tickLower: int24(w[5] >> 8n), tickUpper: int24(w[5] >> 32n), poolId: keccak("0x" + hex.slice(2, 2 + 320)),
      };
    });
  }
  const pm = CHAINS[m.chainId].poolManager;
  const plan = [];
  const slots = [];
  for (const p of open) {
    const info = entry.info[p.tokenId.toString()];
    const state = mappingSlot(info.poolId, 6n);
    const lower = mappingSlot(word32(info.tickLower), state + 4n);
    const upper = mappingSlot(word32(info.tickUpper), state + 4n);
    const key = keccak("0x" + m.address.slice(2) + int24Hex(info.tickLower) + int24Hex(info.tickUpper) + word32(p.tokenId));
    const position = mappingSlot(key, state + 6n);
    plan.push(info);
    slots.push(state, state + 1n, state + 2n, lower + 1n, lower + 2n, upper + 1n, upper + 2n, position + 1n, position + 2n);
  }
  const vals = await rpcBatch(m.chainId, slots.map((s) => call(pm, encode("extsload(bytes32)", ["bytes32"], ["0x" + word32(s)]))));
  if (vals.some((v) => !v)) throw new Error("не прочитано состояние пула");
  return open.map((p, i) => {
    const info = plan[i];
    const v = vals.slice(i * 9, i * 9 + 9).map((x) => BigInt(x));
    const sqrt = Number(v[0] & ((1n << 160n) - 1n)) / Q96;
    const tick = int24(v[0] >> 160n);
    const inside = (global, lo, hi) => tick < info.tickLower ? sub256(lo, hi) : tick >= info.tickUpper ? sub256(hi, lo) : sub256(sub256(global, lo), hi);
    const fees0 = sub256(inside(v[1], v[3], v[5]), v[7]) * p.liquidity / TWO128;
    const fees1 = sub256(inside(v[2], v[4], v[6]), v[8]) * p.liquidity / TWO128;
    return { ...info, tokenId: p.tokenId, liquidity: p.liquidity, pool: pm, sqrtPrice: sqrt, tick, fees0, fees1 };
  });
}

// ---------- building positions ----------

function amounts(liquidity, sqrtP, tickLower, tickUpper) {
  const L = Number(liquidity);
  const sa = Math.sqrt(1.0001 ** tickLower), sb = Math.sqrt(1.0001 ** tickUpper);
  const sp = Math.min(Math.max(sqrtP, sa), sb);
  return { a0: L * (sb - sp) / (sp * sb), a1: L * (sp - sa) };
}

async function build(raws, m, owner, deposits) {
  if (!raws.length) return [];
  const chain = CHAINS[m.chainId];
  const tokens = await tokenInfo(m.chainId, [...new Set(raws.flatMap((r) => [r.token0, r.token1]))]);
  const others = [];
  const ref = {};
  for (const t of Object.values(tokens)) {
    const q = await quoteUSD(m.chainId, t.address);
    if (q != null) ref[t.address] = q; else others.push(t.address);
  }
  const dex = await dexPrices(m.chainId, others);
  return raws.map((r) => {
    const t0 = tokens[r.token0], t1 = tokens[r.token1];
    const shift = 10 ** (t0.decimals - t1.decimals);
    const poolPrice = r.sqrtPrice * r.sqrtPrice * shift; // token1 per token0
    let p0 = ref[t0.address] ?? dex[t0.address]?.price ?? null;
    let p1 = ref[t1.address] ?? dex[t1.address]?.price ?? null;
    const coin = chartIndex(t0, t1);
    // The coin is priced by this very pool; only the quote side comes from outside.
    if (coin === 0 && p1 != null) p0 = p1 * poolPrice;
    if (coin === 1 && p0 != null && poolPrice > 0) p1 = p0 / poolPrice;
    const a = amounts(r.liquidity, r.sqrtPrice, r.tickLower, r.tickUpper);
    const amt0 = a.a0 / 10 ** t0.decimals, amt1 = a.a1 / 10 ** t1.decimals;
    const fee0 = Number(r.fees0) / 10 ** t0.decimals, fee1 = Number(r.fees1) / 10 ** t1.decimals;
    const underlying = amt0 * (p0 || 0) + amt1 * (p1 || 0);
    const fees = fee0 * (p0 || 0) + fee1 * (p1 || 0);
    const id = `${m.address}-${r.tokenId}`;
    const d = deposits[`${m.chainId}|${id}`];
    // Prices of the coin in USD at both range borders.
    const priceAt = (tick) => {
      const raw = 1.0001 ** tick * shift; // token1 per token0
      return coin === 0 ? raw * (p1 || 0) : (raw > 0 ? (p0 || 0) / raw : 0);
    };
    const lowUSD = Math.min(priceAt(r.tickLower), priceAt(r.tickUpper));
    const highUSD = Math.max(priceAt(r.tickLower), priceAt(r.tickUpper));
    return {
      id, key: `${m.chainId}|${id}`, tokenId: r.tokenId.toString(), chainId: m.chainId, manager: m.address, project: m.project,
      kind: m.kind, owner, pool: r.pool, poolId: r.poolId, feeTier: r.fee / 10_000,
      token0: { ...t0, price: p0, logo: dex[t0.address]?.logo }, token1: { ...t1, price: p1, logo: dex[t1.address]?.logo },
      coin, amount0: amt0, amount1: amt1, fee0, fee1, underlying, fees, value: underlying + fees,
      liquidityRaw: r.liquidity, tick: r.tick, tickLower: r.tickLower, tickUpper: r.tickUpper, inRange: r.tick >= r.tickLower && r.tick < r.tickUpper,
      sqrtPrice: r.sqrtPrice, shift, lowUSD, highUSD,
      deposited: d ? d.deposited : null, withdrawn: d ? d.withdrawn : 0,
      pnl: d ? underlying + fees + d.withdrawn - d.deposited : null,
      chainName: chain.name,
    };
  });
}

// ---------- Krystal (ids + deposit history) ----------

async function krystal(owner) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const r = await fetch(`https://api.krystal.app/all/v1/lp/userPositions?addresses=${owner}&positionStatus=OPEN`, { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json();
    return (j.positions || []).filter((p) => p.status !== "CLOSED");
  } catch { return null; }
}

// ---------- public: one wallet ----------

async function loadWallet(owner) {
  owner = owner.toLowerCase();
  const kr = await krystal(owner);
  const hints = {};
  const deposits = {};
  for (const p of kr || []) {
    const m = (p.tokenAddress || "").toLowerCase();
    if (p.tokenId) (hints[`${p.chainId}|${m}`] ||= []).push(String(p.tokenId));
    const dep = p.totalDepositValue ?? p.initialUnderlyingValue;
    if (dep != null) deposits[`${p.chainId}|${m}-${p.tokenId}`] = { deposited: dep, withdrawn: p.totalWithdrawValue || 0 };
  }
  const failures = [];
  const failed = [];
  const parts = await Promise.all(MANAGERS.map(async (m) => {
    const entry = cacheFor(owner, m);
    try {
      const raws = m.kind === "v3" ? await loadV3(m, owner, entry) : await loadV4(m, owner, entry, hints[`${m.chainId}|${m.address}`] || []);
      saveCache(owner, m, entry);
      return await build(raws, m, owner, deposits);
    } catch (e) {
      failures.push(`${CHAINS[m.chainId].name} ${m.project}: ${e.message}`);
      failed.push(`${m.chainId}|${m.address}`);
      return [];
    }
  }));
  return { positions: parts.flat(), failures, failed, krystal: kr != null };
}

// ---------- groups ----------

function groupPositions(positions) {
  const groups = new Map();
  for (const p of positions) {
    const id = `${p.chainId}-${p.poolId}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(p);
  }
  return [...groups.entries()].map(([id, list]) => {
    list.sort((a, b) => b.highUSD - a.highUSD);
    list.forEach((p, i) => { p.number = i + 1; });
    const f = list[0];
    const coin = f.coin === 0 ? f.token0 : f.token1;
    const quote = f.coin === 0 ? f.token1 : f.token0;
    const price = coin.price || 0;
    const sum = (k) => list.reduce((s, p) => s + (p[k] || 0), 0);
    const known = list.filter((p) => p.deposited != null);
    const deposited = known.reduce((s, p) => s + p.deposited, 0);
    const pnl = known.length ? known.reduce((s, p) => s + p.pnl, 0) : null;
    const low = Math.min(...list.map((p) => p.lowUSD)), high = Math.max(...list.map((p) => p.highUSD));
    const inside = list.filter((p) => price >= p.lowUSD && price <= p.highUSD);
    let status = "inside", label;
    if (inside.length) label = "В диапазоне " + inside.map((p) => "№" + p.number).join(", ");
    else if (price > high) { status = "out"; label = "Выше всех диапазонов"; }
    else if (price < low) { status = "out"; label = "Ниже всех диапазонов"; }
    else { status = "gap"; label = "Между диапазонами"; }
    const edge = 0.03;
    if (status === "inside" && (price >= high / (1 + edge) || price <= low * (1 + edge))) status = "edge";
    return {
      id, chainId: f.chainId, chainName: f.chainName, project: f.project, kind: f.kind, feeTier: f.feeTier,
      pool: f.pool, poolId: f.poolId, coin, quote, pair: `${coin.symbol} / ${quote.symbol}`, price,
      positions: list, value: sum("value"), fees: sum("fees"), deposited, pnl,
      inRange: list.filter((p) => p.inRange).length, status, label, low, high,
    };
  }).sort((a, b) => b.value - a.value);
}

// ---------- price tick between full reads ----------

async function poolPrices(groups) {
  const byChain = {};
  for (const g of groups) (byChain[g.chainId] ||= []).push(g);
  const out = {};
  await Promise.all(Object.entries(byChain).map(async ([chainId, list]) => {
    try {
      const res = await rpcBatch(Number(chainId), list.map((g) => g.kind === "v4"
        ? call(g.pool, encode("extsload(bytes32)", ["bytes32"], ["0x" + word32(mappingSlot(g.poolId, 6n))]))
        : call(g.pool, selector("slot0()"))));
      list.forEach((g, i) => { const w = words(res[i]); if (w) out[g.id] = Number(w[0] & ((1n << 160n) - 1n)) / Q96; });
    } catch { /* keep last */ }
  }));
  return out;
}

// Re-value a position at a new pool price (liquidity and ranges don't change between full reads).
function reprice(p, sqrt) {
  const t0 = p.token0, t1 = p.token1;
  const poolPrice = sqrt * sqrt * p.shift;
  let p0 = t0.price, p1 = t1.price;
  if (p.coin === 0 && p1 != null) p0 = p1 * poolPrice;
  if (p.coin === 1 && p0 != null && poolPrice > 0) p1 = p0 / poolPrice;
  const tick = Math.log(poolPrice / p.shift) / Math.log(1.0001);
  const a = amounts(p.liquidityRaw, sqrt, p.tickLower, p.tickUpper);
  const amt0 = a.a0 / 10 ** t0.decimals, amt1 = a.a1 / 10 ** t1.decimals;
  const underlying = amt0 * (p0 || 0) + amt1 * (p1 || 0);
  const fees = p.fee0 * (p0 || 0) + p.fee1 * (p1 || 0);
  return { ...p, token0: { ...t0, price: p0 }, token1: { ...t1, price: p1 }, amount0: amt0, amount1: amt1,
    underlying, fees, value: underlying + fees, sqrtPrice: sqrt, tick, inRange: tick >= p.tickLower && tick < p.tickUpper,
    pnl: p.deposited != null ? underlying + fees + p.withdrawn - p.deposited : null };
}

// ---------- pools of a coin (DexScreener + fees from the chain) ----------

async function coinPools(chainId, token) {
  const c = CHAINS[chainId];
  const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/${c.dex}/${token}`);
  const pairs = await r.json();
  const list = (Array.isArray(pairs) ? pairs : []).map((p) => {
    const baseIs = p.baseToken?.address?.toLowerCase() === token;
    const other = baseIs ? p.quoteToken : p.baseToken;
    const addr = (p.pairAddress || "").toLowerCase();
    const labels = p.labels || [];
    const version = labels.find((l) => ["v2", "v3", "v4"].includes(l)) || (addr.length === 66 ? "v4" : "v3");
    return {
      key: addr, dexId: p.dexId, version, quoteSymbol: other?.symbol || "?", quoteAddress: (other?.address || "").toLowerCase(),
      liquidity: p.liquidity?.usd || 0, v5m: p.volume?.m5 || 0, v1h: p.volume?.h1 || 0, v24h: p.volume?.h24 || 0, fee: null, url: p.url,
    };
  });
  const readable = list.filter((p) => p.version === "v3" || (p.version === "v4" && p.dexId === "uniswap"));
  if (readable.length) {
    try {
      const res = await rpcBatch(chainId, readable.map((p) => p.version === "v4"
        ? call(c.poolManager, encode("extsload(bytes32)", ["bytes32"], ["0x" + word32(mappingSlot(p.key, 6n))]))
        : call(p.key, selector("fee()"))));
      readable.forEach((p, i) => {
        const w = words(res[i]);
        if (!w) return;
        const pips = p.version === "v4" ? Number((w[0] >> 208n) & 0xffffffn) : Number(w[0] & 0xffffffn);
        p.fee = pips / 10_000;
      });
    } catch { /* fees unknown */ }
  }
  return list.filter((p) => (p.fee || 0) > 0 && p.v1h > 0 && Object.prototype.hasOwnProperty.call(c.quotes, p.quoteAddress));
}

// ---------- candles (GeckoTerminal) ----------

async function candles(group, tf) {
  const map = { "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1] };
  const [period, agg] = map[tf];
  const pool = (group.kind === "v4" ? group.poolId : group.pool).toLowerCase();
  const url = `https://api.geckoterminal.com/api/v2/networks/${CHAINS[group.chainId].gecko}/pools/${pool}/ohlcv/${period}?aggregate=${agg}&limit=300&currency=usd&token=${group.coin.address}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("GeckoTerminal " + r.status);
  const j = await r.json();
  const rows = j?.data?.attributes?.ohlcv_list || [];
  return rows.map((x) => ({ time: x[0], open: x[1], high: x[2], low: x[3], close: x[4] }))
    .filter((c) => c.low > 0).sort((a, b) => a.time - b.time);
}

window.LP = { CHAINS, loadWallet, groupPositions, poolPrices, reprice, coinPools, candles, store };
