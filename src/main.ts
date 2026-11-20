import {
  ALCClient,
  segmentedALCLaunchFactoryV3Abi,
  AmmoraDataApiClient,
  type AmmoraLaunchSummary,
} from "@ammora-protocol/sdk";
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  parseAbiItem,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

// ---------- config (all addresses come from the SDK's reviewed GIWA catalog) ----------
const CHAIN_ID = 91342;
// Values below are taken from the SDK's reviewed GIWA Sepolia catalog (ammoraDeployments["91342"]);
// hard-coded so the app does not depend on how the catalog is bundled in the browser.
const RPC_URL = "https://sepolia-rpc.giwa.io";
const EXPLORER = "https://sepolia-explorer.giwa.io";
const giwa = {
  id: CHAIN_ID,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: EXPLORER } },
} as const;
const FACTORY = "0x42acd2531e47ea789c03915c9de195bf6250c0a2" as Address;
const CONFIG_REGISTRY = "0x068d624653fe9a6b1e428fee5058aaec93c0d231" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const DATA_API = "https://ammora-giwa-sepolia-data.fly.dev";
const START_BLOCK = 32472683n; // factory deployment block from the SDK catalog

const publicClient = createPublicClient({ chain: giwa, transport: http(RPC_URL) });
const data = new AmmoraDataApiClient(DATA_API);

const wethAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

// ---------- tiny helpers ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const bigintJson = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

function notice(msg: string, kind: "" | "err" | "ok" = "") {
  const n = $("notice");
  n.className = `notice ${kind}`;
  n.innerHTML = msg;
  n.hidden = false;
}
const clearNotice = () => ($("notice").hidden = true);
const errMsg = (e: unknown) => esc((e as any)?.shortMessage ?? (e as any)?.message ?? String(e));
const txLink = (h: string) => `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noreferrer">${short(h)}</a>`;

// ---------- wallet ----------
let account: Address | null = null;
const eth = () => (window as any).ethereum;

async function connect() {
  if (!eth()) return notice("No wallet found. Install MetaMask and reload.", "err");
  try {
    const [addr] = (await eth().request({ method: "eth_requestAccounts" })) as Address[];
    account = addr;
    try {
      await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + CHAIN_ID.toString(16) }] });
    } catch {
      await eth().request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x" + CHAIN_ID.toString(16),
          chainName: giwa.name,
          nativeCurrency: giwa.nativeCurrency,
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER],
        }],
      });
    }
    $("connect").textContent = short(addr);
    clearNotice();
  } catch (e) {
    notice(errMsg(e), "err");
  }
}

function wallet() {
  if (!account) throw new Error("Connect your wallet first.");
  return createWalletClient({ account, chain: giwa, transport: custom(eth()) });
}

async function send(tx: { to: Address; data: Hex; value?: bigint }, label: string) {
  const w = wallet();
  notice(`${label}: confirm in your wallet…`);
  const hash = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, account: account!, chain: giwa });
  notice(`${label}: submitted ${txLink(hash)}, waiting for confirmation…`);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  notice(`${label}: confirmed ${txLink(hash)} ✅`, "ok");
  return hash;
}

// ---------- metadata ----------
type Meta = { name?: string; symbol?: string; image?: string; description?: string };
const metaCache = new Map<string, Promise<Meta>>();
const gateway = (u: string) => (u.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${u.slice(7)}` : u);

function loadMeta(uri: string): Promise<Meta> {
  if (!metaCache.has(uri)) {
    metaCache.set(uri, (async () => {
      try {
        if (uri.startsWith("data:application/json")) {
          const body = uri.split(",").slice(1).join(",");
          return JSON.parse(uri.includes("base64") ? atob(body) : decodeURIComponent(body));
        }
        const res = await fetch(gateway(uri));
        return (await res.json()) as Meta;
      } catch {
        return {};
      }
    })());
  }
  return metaCache.get(uri)!;
}

async function tokenInfo(token: Address) {
  const [name, symbol, decimals] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "?"),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
  ]);
  return { name: name as string, symbol: symbol as string, decimals: Number(decimals) };
}

// ---------- launches list ----------
const launchCreated = parseAbiItem(
  "event LaunchCreated(address indexed token, address indexed curve, address indexed creator, uint256 configId, bytes32 configHash, uint16 protocolVersion, string metadataURI)",
);
void segmentedALCLaunchFactoryV3Abi;

/** Fallback when the Data API is unreachable: read LaunchCreated events straight from the factory.
 *  Public RPCs cap eth_getLogs ranges, so the window shrinks automatically on "invalid params" errors. */
async function launchesFromChain(max = 24, budget = 60): Promise<AmmoraLaunchSummary[]> {
  const latest = await publicClient.getBlockNumber();
  const out: AmmoraLaunchSummary[] = [];
  let step = 10_000n;
  let to = latest;
  let calls = 0;
  while (to >= START_BLOCK && out.length < max && calls < budget) {
    const from = to - step + 1n > START_BLOCK ? to - step + 1n : START_BLOCK;
    calls++;
    let logs;
    try {
      logs = await publicClient.getLogs({ address: FACTORY, event: launchCreated, fromBlock: from, toBlock: to });
    } catch (e) {
      if (step > 500n) { step = step / 4n; continue; } // shrink window and retry same range
      throw e;
    }
    for (const lg of logs.reverse()) {
      out.push({
        address: lg.args.token!, curveAddress: lg.args.curve!, creatorAddress: lg.args.creator!,
        metadataUri: lg.args.metadataURI ?? "", status: "ACTIVE",
        createdBlock: String(lg.blockNumber), canonicalPool: null,
      } as unknown as AmmoraLaunchSummary);
      if (out.length >= max) break;
    }
    if (from === START_BLOCK) break;
    to = from - 1n;
  }
  return out;
}

async function loadLaunches(): Promise<{ items: AmmoraLaunchSummary[]; source: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const page = await data.getLaunches({ chainId: BigInt(CHAIN_ID), signal: ctrl.signal });
    clearTimeout(t);
    return { items: page.items, source: "Ammora Data API" };
  } catch {
    return { items: await launchesFromChain(), source: "GIWA Sepolia RPC (factory events)" };
  }
}

async function renderLaunches() {
  const el = $("launches");
  el.innerHTML = `<p class="mut">Loading launches…</p>`;
  try {
    const page = await loadLaunches();
    if (!page.items.length) {
      el.innerHTML = `<p class="mut">No launches found in recent blocks (source: ${page.source}). Be the first — open the Create tab.</p>`;
      return;
    }
    el.innerHTML = `<p class="mut">Source: ${page.source} · ${page.items.length} launches</p><div class="grid">${page.items.map((l) => `
      <div class="card" data-token="${l.address}">
        <div class="ph" id="img-${l.address}">◎</div>
        <h3 id="nm-${l.address}">${short(l.address)}</h3>
        <div class="mut"><span class="badge ${l.status}">${l.status}</span> · block ${esc(l.createdBlock)}</div>
      </div>`).join("")}</div>`;
    el.querySelectorAll<HTMLElement>(".card").forEach((c) => (c.onclick = () => {
      const l = page.items.find((x) => x.address === c.dataset.token)!;
      void openDetail(l);
    }));
    for (const l of page.items) {
      void (async () => {
        const [m, info] = await Promise.all([loadMeta(l.metadataUri), tokenInfo(l.address)]);
        const nm = document.getElementById(`nm-${l.address}`);
        if (nm) nm.textContent = `${m.name ?? info.name} (${m.symbol ?? info.symbol})`;
        const im = document.getElementById(`img-${l.address}`);
        if (im && m.image) im.outerHTML = `<img src="${esc(gateway(m.image))}" alt="" />`;
      })();
    }
  } catch (e) {
    el.innerHTML = "";
    notice(`Could not load launches from the Data API or the RPC: ${errMsg(e)}`, "err");
  }
}

// ---------- launch detail / trade ----------
async function openDetail(l: AmmoraLaunchSummary) {
  $("launches").hidden = true;
  const el = $("detail");
  el.hidden = false;
  el.innerHTML = `<button id="back">← Back</button><p class="mut">Loading…</p>`;
  $("back").onclick = () => { el.hidden = true; $("launches").hidden = false; };

  const alc = new ALCClient(publicClient, l.curveAddress, CONFIG_REGISTRY);
  const [meta, info, prog] = await Promise.all([
    loadMeta(l.metadataUri),
    tokenInfo(l.address),
    alc.getMigrationProgress().catch(() => null),
  ]);
  const pct = prog ? Math.min(100, prog.progressBps / 100) : 0;

  el.innerHTML = `
    <button id="back">← Back</button>
    <div class="row panel">
      <div>
        <h2 style="margin-top:0">${esc(meta.name ?? info.name)} <span class="mut">(${esc(meta.symbol ?? info.symbol)})</span></h2>
        <p class="mut">${esc(meta.description ?? "")}</p>
        <div class="kv"><span>Status</span><span class="badge ${l.status}">${l.status}</span></div>
        <div class="kv"><span>Token</span><a target="_blank" rel="noreferrer" href="${EXPLORER}/address/${l.address}">${short(l.address)}</a></div>
        <div class="kv"><span>Curve</span><a target="_blank" rel="noreferrer" href="${EXPLORER}/address/${l.curveAddress}">${short(l.curveAddress)}</a></div>
        <div class="kv"><span>Creator</span><span>${short(l.creatorAddress)}</span></div>
        ${l.canonicalPool ? `<div class="kv"><span>Graduated pool</span><a target="_blank" rel="noreferrer" href="${EXPLORER}/address/${l.canonicalPool}">${short(l.canonicalPool)}</a></div>` : ""}
        <label>Graduation progress ${prog ? `(${pct.toFixed(2)}%)` : "(unavailable)"}</label>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>
      <div>
        <h3 style="margin-top:0">Trade on the curve</h3>
        <select id="side"><option value="buy">Buy (WETH → ${esc(info.symbol)})</option><option value="sell">Sell (${esc(info.symbol)} → WETH)</option></select>
        <label id="amtlabel">Amount in WETH</label>
        <input id="amt" type="number" min="0" step="any" value="0.01" />
        <label>Slippage (%)</label>
        <input id="slip" type="number" min="0.1" max="50" step="0.1" value="1" />
        <div id="quote" class="mut" style="margin:10px 0"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="wrap">Wrap ETH → WETH</button>
          <button id="doquote">Get quote</button>
          <button id="dotrade" class="primary" disabled>Approve &amp; trade</button>
        </div>
      </div>
    </div>`;
  $("back").onclick = () => { el.hidden = true; $("launches").hidden = false; };

  let plan: Awaited<ReturnType<ALCClient["planSwapExactInput"]>> | null = null;
  const side = () => ($<HTMLSelectElement>("side").value === "sell");
  const amount = () => parseUnits($<HTMLInputElement>("amt").value || "0", side() ? info.decimals : 18);
  const slipBps = () => Math.round(Number($<HTMLInputElement>("slip").value) * 100);

  $<HTMLSelectElement>("side").onchange = () => {
    $("amtlabel").textContent = side() ? `Amount in ${info.symbol}` : "Amount in WETH";
    plan = null; ($("dotrade") as HTMLButtonElement).disabled = true;
  };

  $("wrap").onclick = async () => {
    try {
      const w = wallet();
      const value = parseEther($<HTMLInputElement>("amt").value || "0");
      notice("Wrap ETH: confirm in your wallet…");
      const hash = await w.writeContract({ address: WETH, abi: wethAbi, functionName: "deposit", value, account: account!, chain: giwa });
      await publicClient.waitForTransactionReceipt({ hash });
      notice(`Wrapped ${formatEther(value)} ETH ${txLink(hash)} ✅`, "ok");
    } catch (e) { notice(errMsg(e), "err"); }
  };

  $("doquote").onclick = async () => {
    try {
      if (!account) await connect();
      if (!account) return;
      // The curve may not be able to absorb the whole amount (e.g. near graduation or a per-swap cap).
      // Pre-quote: if part of the input would be returned, plan a partial fill and tell the user.
      const pre = await alc.quoteExactInput(amount(), side());
      const partial = pre.amountLeft !== 0n;
      plan = await alc.planSwapExactInput({
        includedAmountIn: amount(),
        baseForQuote: side(),
        allowPartialFill: partial,
        slippageBps: slipBps(),
        recipient: account,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
      });
      const outDec = side() ? 18 : info.decimals;
      $("quote").innerHTML = `Expected out: <b>${formatUnits(plan.quote.amountOut, outDec)}</b> · min out: ${formatUnits(plan.quote.minimumAmountOut, outDec)} · fee: ${plan.quote.fee}${partial ? `<br><span style="color:#ffb84d">Partial fill: only ${formatUnits(pre.amountIn, side() ? info.decimals : 18)} will be used, ${formatUnits(pre.amountLeft, side() ? info.decimals : 18)} is returned to you.</span>` : ""}`;
      ($("dotrade") as HTMLButtonElement).disabled = false;
      clearNotice();
    } catch (e) { plan = null; notice(`Quote failed: ${errMsg(e)}`, "err"); }
  };

  $("dotrade").onclick = async () => {
    if (!plan) return;
    try {
      for (const req of plan.approvalRequirements) {
        const allowance = (await publicClient.readContract({ address: req.token, abi: erc20Abi, functionName: "allowance", args: [account!, req.spender] })) as bigint;
        if (allowance < req.amount) {
          const w = wallet();
          notice("Approve: confirm in your wallet…");
          const h = await w.writeContract({ address: req.token, abi: erc20Abi, functionName: "approve", args: [req.spender, req.amount], account: account!, chain: giwa });
          await publicClient.waitForTransactionReceipt({ hash: h });
        }
      }
      await send(plan.transaction, side() ? "Sell" : "Buy");
    } catch (e) { notice(errMsg(e), "err"); }
  };
}

// ---------- create launch ----------
async function renderCreate() {
  const el = $("create");
  el.innerHTML = `<div class="panel"><h2 style="margin-top:0">Create a launch</h2><p class="mut">Calldata is built by <code>ALCClient.planLaunchWithTokenConfigFromConfig</code>; you sign it in your wallet.</p>
    <p class="mut">Loading curve configs from the registry…</p></div>`;
  let options = "";
  try {
    const page = await new ALCClient(publicClient, zeroAddress, CONFIG_REGISTRY).listConfigs({ limit: 20 });
    options = page.items.map((c) => `<option value="${c.configId}">Config #${c.configId} · ${c.curve.length} segments</option>`).join("");
    if (!options) options = `<option value="">No enabled configs found</option>`;
  } catch (e) {
    options = `<option value="">Could not load configs</option>`;
    notice(`Config list failed: ${errMsg(e)}`, "err");
  }
  el.innerHTML = `<div class="panel"><h2 style="margin-top:0">Create a launch</h2>
    <p class="mut">Calldata is built by <code>ALCClient.planLaunchWithTokenConfigFromConfig</code>; you sign it in your wallet.</p>
    <div class="row"><div>
      <label>Token name</label><input id="c-name" value="My Token" />
      <label>Symbol</label><input id="c-sym" value="MTK" />
      <label>Curve config</label><select id="c-cfg">${options}</select>
      <label>Token decimals (6–9)</label><input id="c-dec" type="number" min="6" max="9" value="9" />
    </div><div>
      <label>Description (stored in generated metadata)</label><input id="c-desc" value="Launched with GiwaPad on GIWA Sepolia" />
      <label>Image URL (optional)</label><input id="c-img" placeholder="https://… or ipfs://…" />
      <label>Metadata URI (leave empty to auto-generate)</label><input id="c-uri" placeholder="ipfs://…" />
      <p style="margin-top:18px"><button id="c-go" class="primary">Create launch</button></p>
    </div></div></div>`;
  $("c-go").onclick = async () => {
    try {
      if (!account) await connect();
      if (!account) return;
      const name = $<HTMLInputElement>("c-name").value.trim();
      const symbol = $<HTMLInputElement>("c-sym").value.trim();
      const cfg = $<HTMLSelectElement>("c-cfg").value;
      if (!name || !symbol || !cfg) throw new Error("Name, symbol and a curve config are required.");
      let uri = $<HTMLInputElement>("c-uri").value.trim();
      if (!uri) {
        const json = JSON.stringify({ name, symbol, description: $<HTMLInputElement>("c-desc").value, image: $<HTMLInputElement>("c-img").value.trim() || undefined });
        uri = `data:application/json;base64,${btoa(unescape(encodeURIComponent(json)))}`;
      }
      const alc = new ALCClient(publicClient, zeroAddress, CONFIG_REGISTRY);
      const tx = await alc.planLaunchWithTokenConfigFromConfig({
        factory: FACTORY,
        name,
        symbol,
        metadataURI: uri,
        creatorMetadataURI: uri,
        configId: BigInt(cfg),
        tokenDecimals: Number($<HTMLInputElement>("c-dec").value),
      });
      await send(tx, "Create launch");
      void renderLaunches();
    } catch (e) { notice(errMsg(e), "err"); }
  };
}

// ---------- tabs / boot ----------
document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll("nav button").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  clearNotice();
  $("detail").hidden = true;
  $("launches").hidden = b.dataset.tab !== "launches";
  $("create").hidden = b.dataset.tab !== "create";
  if (b.dataset.tab === "create") void renderCreate(); else void renderLaunches();
}));
$("connect").onclick = connect;
window.addEventListener("unhandledrejection", (e) => notice(`Unexpected error: ${errMsg(e.reason)}`, "err"));
void renderLaunches().catch((e) => notice(`Startup error: ${errMsg(e)}`, "err"));
void bigintJson;
