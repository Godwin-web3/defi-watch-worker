// src/aave-mempool.ts
import WebSocket from 'ws';
import { Interface, JsonRpcProvider } from 'ethers';
import { AAVE_ORACLE } from './utils.js';

const WS_URL  = process.env.WS_RPC_URL || 'wss://ethereum-rpc.publicnode.com';
const RPC_URL = process.env.RPC_URL    || 'https://ethereum.publicnode.com';

const RECONNECT_DELAY_MS = 5_000;
const HEALTH_CHECK_MS    = 30_000;
const DEDUP_SEEN_MAX     = 5_000;

const AAVE_V3_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const RAY = BigInt('1000000000000000000000000000');
const RATE_SPIKE_THRESHOLD   = 20n;
const PRICE_DEVIATION_THRESHOLD = 3;

const POOL_ABI = [
  'function getReserveData(address asset) view returns (uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)',
];
const ORACLE_ABI = [
  'function getAssetPrice(address) view returns (uint256)',
  'function getSourceOfAsset(address) view returns (address)',
];
const CHAINLINK_ABI = [
  'function latestAnswer() view returns (int256)',
];

const BORROW_SIG     = '0xa415bcad';
const LIQUIDATION_SIG = '0x00a718a9';

const aaveInterface = new Interface([
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)',
]);

const pendingLiquidations = new Map<string, { senders: Set<string>; timestamp: number }>();
const seenTxHashes        = new Set<string>();

let txsReceived   = 0;
let fullTxObjects = 0;
let alertsFired   = 0;

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegramAlert(token: string, chatId: string, message: string) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
  });
}

async function fireAlert(msg: string) {
  alertsFired++;
  const token  = process.env.TELEGRAM_BOT_TOKEN!;
  const chatId = process.env.TELEGRAM_CHAT_ID!;
  try { await sendTelegramAlert(token, chatId, msg); }
  catch (err) { console.error('[aave-mempool] Telegram failed:', err); }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanOldLiquidations() {
  const now = Date.now();
  for (const [key, val] of pendingLiquidations.entries()) {
    if (now - val.timestamp > 300_000) pendingLiquidations.delete(key);
  }
}

function purgeDedup() {
  if (seenTxHashes.size > DEDUP_SEEN_MAX) {
    const iter = seenTxHashes.values();
    for (let i = 0; i < DEDUP_SEEN_MAX / 2; i++) seenTxHashes.delete(iter.next().value!);
  }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

async function handlePendingTx(tx: any) {
  txsReceived++;
  if (!tx || typeof tx !== 'object' || typeof tx.input !== 'string') return;
  if (tx.input.length < 10) return;
  fullTxObjects++;

  const to = tx.to?.toLowerCase();
  if (to !== AAVE_V3_POOL) return;

  const txHash = (tx.hash as string)?.toLowerCase();
  if (!txHash) return;
  if (seenTxHashes.has(txHash)) return;
  seenTxHashes.add(txHash);
  purgeDedup();

  const sig    = tx.input.slice(0, 10).toLowerCase();
  const sender = (tx.from as string)?.toLowerCase() || 'unknown';

  const provider = new JsonRpcProvider(RPC_URL);

  // ── LIQUIDATION FRONT-RUNNING ────────────────────────────────────────────
  if (sig === LIQUIDATION_SIG) {
    try {
      const decoded = aaveInterface.parseTransaction({ data: tx.input });
      if (!decoded) return;

      const { collateralAsset, user } = decoded.args;
      const key = `${user.toLowerCase()}-${collateralAsset.toLowerCase()}`;

      cleanOldLiquidations();

      if (!pendingLiquidations.has(key)) {
        pendingLiquidations.set(key, { senders: new Set([sender]), timestamp: Date.now() });
      } else {
        const entry = pendingLiquidations.get(key)!;
        entry.senders.add(sender);
        if (entry.senders.size >= 2) {
          await fireAlert(
            `⚡ *AAVE LIQUIDATION RACE DETECTED*\n` +
            `Target user: \`${user}\`\n` +
            `Collateral: \`${collateralAsset}\`\n` +
            `Competing liquidators: ${entry.senders.size}\n` +
            `Tx: \`${txHash}\`\n` +
            `Multiple bots racing to liquidate the same position.`
          );
        }
      }
    } catch {}
  }

  // ── BORROW: INTEREST RATE + COLLATERAL PRICE CHECKS ─────────────────────
  if (sig === BORROW_SIG) {
    try {
      const decoded = aaveInterface.parseTransaction({ data: tx.input });
      if (!decoded) return;

      const asset = decoded.args.asset as string;

      // Interest rate spike check
      try {
        const pool = new (await import('ethers')).Contract(AAVE_V3_POOL, POOL_ABI, provider);
        const reserveData = await pool.getReserveData(asset);
        const currentRate = BigInt(reserveData[4].toString());
        const borrowAmount = BigInt(decoded.args.amount.toString());
        const rateImpact = (borrowAmount * currentRate) / RAY;
        const rateJump = currentRate > 0n ? (rateImpact * 100n) / currentRate : 0n;

        if (rateJump > RATE_SPIKE_THRESHOLD) {
          await fireAlert(
            `⚡ *AAVE INTEREST RATE SPIKE RISK*\n` +
            `Asset: \`${asset}\`\n` +
            `Borrow amount: \`${borrowAmount.toString()}\`\n` +
            `Estimated rate jump: ${rateJump}%\n` +
            `Tx: \`${txHash}\``
          );
        }
      } catch {}

      // Collateral price deviation check
      try {
        const oracle    = new (await import('ethers')).Contract(AAVE_ORACLE, ORACLE_ABI, provider);
        const aavePrice = BigInt((await oracle.getAssetPrice(asset)).toString());
        const feedAddr  = await oracle.getSourceOfAsset(asset);
        const feed      = new (await import('ethers')).Contract(feedAddr, CHAINLINK_ABI, provider);
        const clPrice   = BigInt((await feed.latestAnswer()).toString());

        if (aavePrice > 0n && clPrice > 0n) {
          const deviation = Number(aavePrice > clPrice
            ? (aavePrice - clPrice) * 100n / clPrice
            : (clPrice - aavePrice) * 100n / aavePrice);

          if (deviation >= PRICE_DEVIATION_THRESHOLD) {
            await fireAlert(
              `⚡ *AAVE COLLATERAL PRICE DEVIATION*\n` +
              `Asset: \`${asset}\`\n` +
              `Aave oracle price: \`${aavePrice.toString()}\`\n` +
              `Chainlink price: \`${clPrice.toString()}\`\n` +
              `Deviation: ${deviation}%\n` +
              `Tx: \`${txHash}\`\n` +
              `Aave and Chainlink prices diverging during active borrow.`
            );
          }
        }
      } catch {}
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// WebSocket + health watchdog
// ---------------------------------------------------------------------------

export function startAaveMempoolMonitor() {
  let ws: WebSocket | null = null;
  let lastMessageAt = Date.now();
  let reconnecting  = false;

  function connect() {
    if (reconnecting) return;
    reconnecting = true;
    console.log('[aave-mempool] Connecting...');
    ws = new WebSocket(WS_URL);
    ws.on("error", () => {});
    ws.on("unexpected-response", (req, res) => {
      console.warn("[aave-mempool] Unexpected response:", res.statusCode);
      reconnecting = false;
      setTimeout(connect, res.statusCode === 429 ? 10000 : RECONNECT_DELAY_MS);
    });

    ws.on('open', () => {
      reconnecting  = false;
      lastMessageAt = Date.now();
      console.log('[aave-mempool] Connected. Subscribing...');
      ws!.send(JSON.stringify({
        jsonrpc: '2.0', id: 30,
        method: 'eth_subscribe',
        params: ['newPendingTransactions', { includeTransactions: true }],
      }));
    });

    ws.on('message', async (raw: Buffer) => {
      lastMessageAt = Date.now();
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg?.id === 30 && msg?.result) {
        console.log('[aave-mempool] Subscribed, sub ID:', msg.result);
        return;
      }

      const result = msg?.params?.result;
      if (!result) return;

      let tx: any;

      if (typeof result === 'object' && result.input) {
        tx = result;
      } else if (typeof result === 'string' && result.startsWith('0x')) {
        try {
          const res  = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1,
              method: 'eth_getTransactionByHash',
              params: [result],
            }),
          });
          const data = await res.json() as { result?: any };
          tx = data?.result;
          if (!tx) return;
        } catch (err) {
          console.error('[aave-mempool] Fallback fetch failed:', err);
          return;
        }
      } else { return; }

      try { await handlePendingTx(tx); }
      catch (err) { console.error('[aave-mempool] Handler error:', tx?.hash, err); }
    });

    ws.on('error', (err) => console.error('[aave-mempool] WS error:', err));

    ws.on('close', (code) => {
      console.warn(`[aave-mempool] Disconnected (${code}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
      reconnecting = false;
      setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  setInterval(() => {
    const silentMs = Date.now() - lastMessageAt;
    if (silentMs > HEALTH_CHECK_MS) {
      console.warn(`[aave-mempool] Silent for ${silentMs / 1000}s — reconnecting`);
      try { ws?.terminate(); } catch {}
      reconnecting = false;
      connect();
    }
    console.log(
      `[aave-mempool] metrics — received: ${txsReceived} | fullObjects: ${fullTxObjects} | alerts: ${alertsFired}`
    );
    txsReceived = fullTxObjects = alertsFired = 0;
  }, HEALTH_CHECK_MS);

  connect();
}

// Keep export for backwards compat but it's no longer used
export async function monitorAaveMempool(..._args: any[]) {
  console.warn('[aave-mempool] monitorAaveMempool is deprecated — use startAaveMempoolMonitor()');
}
