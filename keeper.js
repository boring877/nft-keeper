// GachaWiki OGs keeper — one tick, run by GitHub Actions every 15 min.
//   1. Prices: pin ETH + $GW mint prices to the same USD target (operator key).
//   2. Buyback: withdraw accumulated ETH mint revenue, swap it (minus a small
//      gas buffer) for $GW on the GW/WETH Uniswap V3 pool, and burn every $GW
//      bought (owner key).
// Runs from GitHub runner IPs (the Robinhood RPC throttles Cloudflare Worker
// egress). All keys come from GitHub Secrets; nothing sensitive lives here.
const { ethers } = require('ethers');

const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const NFT = process.env.NFT_CONTRACT || '0x9C0f41ce4F8e72F866CC79Acd80386472c53B40B';
const GW_TOKEN = '0x50bE7832849EFEdB15611799074FcC409522f27A';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2';
const QUOTER = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const POOL_FEE = 10000;
const TARGET_USD = 2;
const DRIFT_PCT = 2n;
const FLOOR_ETH_WEI = 400000000000000n; // mirrors the contract's price floors
const FLOOR_GW_UNITS = 100000n * 10n ** 18n;
const BUYBACK_MIN_WEI = 1000000000000000n; // act once the swap can carry ≥0.001 ETH
const GAS_BUFFER_WEI = 500000000000000n; // ETH kept in the owner wallet for the swap/burn gas

const NFT_ABI = [
  'function mintPrice() view returns (uint256)',
  'function gwMintPrice() view returns (uint256)',
  'function updatePrices(uint256 ethPrice, uint256 gwPrice) external',
  'function withdraw(address to) external',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)'];
const ROUTER_ABI = ['function multicall(bytes[] data) payable returns (bytes[] results)', 'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)'];

const report = { prices: null, buyback: null };

// GitHub runners share egress IPs, so Coinbase/Dexscreener intermittently 429
// or return error bodies; retry before giving up on a source.
async function fetchJson(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000 * i));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function keepPrices(provider) {
  const ethUsd = parseFloat((await fetchJson('https://api.coinbase.com/v2/prices/ETH-USD/spot')).data.amount);
  if (!(ethUsd > 0)) throw new Error('bad ethUsd ' + ethUsd);

  let gwUsd, gwSrc;
  try {
    const pairs = (await fetchJson('https://api.dexscreener.com/latest/dex/tokens/' + GW_TOKEN)).pairs;
    const pair = (pairs || []).find((x) => x.liquidity && x.liquidity.usd > 100);
    if (!pair) throw new Error('no liquid GW pair');
    gwUsd = parseFloat(pair.priceUsd);
    gwSrc = 'dexscreener';
  } catch (e) {
    // Dexscreener unavailable — take the marginal price straight from the same
    // GW/WETH pool the buyback swaps through; pool price × ETH/USD is exactly
    // what Dexscreener reports for this pair anyway.
    const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
    const q = await quoter.quoteExactInputSingle.staticCall({ tokenIn: GW_TOKEN, tokenOut: WETH, amountIn: 10n ** 18n, fee: POOL_FEE, sqrtPriceLimitX96: 0 });
    const wethPerGw = Number(q[0]) / 1e18;
    if (!(wethPerGw > 0)) throw new Error('dexscreener failed (' + String(e.message || e).slice(0, 120) + ') and pool quote empty');
    gwUsd = ethUsd * wethPerGw;
    gwSrc = 'onchain (dexscreener: ' + String(e.message || e).slice(0, 120) + ')';
  }
  if (!(gwUsd > 0)) throw new Error('bad gwUsd ' + gwUsd);

  let ethWei = BigInt(Math.ceil((TARGET_USD / ethUsd) * 1e6)) * 10n ** 12n;
  let gwUnits = BigInt(Math.ceil((TARGET_USD / gwUsd) / 1000) * 1000) * 10n ** 18n;
  if (ethWei < FLOOR_ETH_WEI) ethWei = FLOOR_ETH_WEI;
  if (gwUnits < FLOOR_GW_UNITS) gwUnits = FLOOR_GW_UNITS;

  const nft = new ethers.Contract(NFT, NFT_ABI, provider);
  const [curEth, curGw] = await Promise.all([nft.mintPrice(), nft.gwMintPrice()]);
  const drifted = (cur, tgt) => cur === 0n || ((cur > tgt ? cur - tgt : tgt - cur) * 100n > cur * DRIFT_PCT);

  const out = { market: { ethUsd, gwUsd, gwSrc }, target: { eth: Number(ethWei) / 1e18, gw: Number(gwUnits) / 1e18 }, onChain: { eth: Number(curEth) / 1e18, gw: Number(curGw) / 1e18 }, updated: false };
  if (drifted(curEth, ethWei) || drifted(curGw, gwUnits)) {
    const wallet = new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);
    const tx = await (await nft.connect(wallet)).updatePrices(ethWei, gwUnits, { gasLimit: 150000 });
    await tx.wait();
    out.updated = true;
    out.tx = tx.hash;
  }
  return out;
}

async function buybackBurn(provider) {
  const revenue = await provider.getBalance(NFT);
  const out = { revenueEth: ethers.formatEther(revenue) };

  const owner = new ethers.Wallet(process.env.OWNER_PRIVATE_KEY, provider);
  const nft = new ethers.Contract(NFT, NFT_ABI, owner);
  const gw = new ethers.Contract(GW_TOKEN, ERC20_ABI, owner);
  const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, owner);

  if (revenue >= BUYBACK_MIN_WEI) {
    const t1 = await nft.withdraw(owner.address, { gasLimit: 100000 });
    await t1.wait();
    out.withdrawTx = t1.hash;
  }

  // Swap whatever the wallet holds beyond a gas cushion — sending the whole
  // withdrawn amount as the swap value leaves nothing for the swap's own gas
  // (the 2026-08-31 run withdrew the revenue, then failed on exactly that and
  // left the ETH stranded in the owner wallet until the next tick sweeps it).
  const spendable = (await provider.getBalance(owner.address)) - GAS_BUFFER_WEI;
  if (spendable < BUYBACK_MIN_WEI) { out.skipped = 'below 0.001 ETH threshold'; return out; }
  out.swapEth = ethers.formatEther(spendable);

  const q = await quoter.quoteExactInputSingle.staticCall({ tokenIn: WETH, tokenOut: GW_TOKEN, amountIn: spendable, fee: POOL_FEE, sqrtPriceLimitX96: 0 });
  const minOut = (q[0] * 97n) / 100n;
  out.minGwOut = ethers.formatEther(minOut);

  const gwBefore = await gw.balanceOf(owner.address);
  const t2 = await router.multicall([
    (await router.exactInputSingle.populateTransaction({
      tokenIn: WETH, tokenOut: GW_TOKEN, fee: POOL_FEE, recipient: owner.address,
      amountIn: spendable, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
    })).data,
  ], { value: spendable, gasLimit: 400000 });
  await t2.wait();
  const bought = (await gw.balanceOf(owner.address)) - gwBefore;
  const t3 = await gw.transfer(DEAD, bought, { gasLimit: 100000 });
  await t3.wait();

  out.done = true;
  out.gwBoughtAndBurned = ethers.formatEther(bought);
  out.txs = [out.withdrawTx, t2.hash, t3.hash].filter(Boolean);
  return out;
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  report.prices = await keepPrices(provider).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  report.buyback = await buybackBurn(provider).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  console.log(JSON.stringify(report, null, 1));
  if (report.prices.error || report.buyback.error) process.exit(1);
})();
