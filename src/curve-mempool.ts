// src/curve-mempool.ts
import WebSocket from 'ws';
import { ethers } from 'ethers';

const WS_URL = process.env.WS_RPC_URL || 'wss://ethereum-rpc.publicnode.com';
const RECONNECT_DELAY_MS  = 5_000;
const HEALTH_CHECK_MS     = 30_000;
const IMBALANCE_WINDOW_MS = 12_000; // 1 block
const DEDUP_SEEN_MAX      = 5_000;

// Large exchange threshold — flag swaps moving more than this many tokens
// 500,000 USDC/USDT (6 decimals) or 500 ETH (18 decimals)
const LARGE_EXCHANGE_THRESHOLDS: Record<string, bigint> = {
  '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7': BigInt('500000000000'), // 3Pool: 500k stables (6 dec)
  '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022': BigInt('500000000000000000000'), // stETH: 500 ETH (18 dec)
};
const DEFAULT_EXCHANGE_THRESHOLD = BigInt('500000000000000000000');

// Large liquidity removal threshold (LP token amount)
const LARGE_REMOVE_THRESHOLD = BigInt('100000000000000000000000'); // 100k LP tokens

// Gauge weight vote threshold — flag votes above this % (in basis points, 10000 = 100%)
const LARGE_VOTE_WEIGHT = 5000; // 50%

const WATCHED_POOLS = new Set([
  '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', // Curve 3Pool
  '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022', // Curve stETH
]);

const GAUGE_CONTROLLER = '0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB'.toLowerCase();

// Function signatures
const SIG_EXCHANGE              = '0x3df02124';
const SIG_REMOVE_LIQ            = '0x5b36389c';
const SIG_REMOVE_LIQ_IMBALANCE  = '0x18a7bd76';
const SIG_REMOVE_LIQ_ONE_COIN   = '0x1a4d01d2';
const SIG_VOTE_GAUGE            = '0xd4d2646e';

const iface = new ethers.Interface([
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)',
  'function remove_liquidity(uint256 _amount, uint256[3] min_amounts)',
  'function remove_liquidity_imbalance(uint256[3] amounts, uint256 max_burn_amount)',
  'function remove_liquidity_one_coin(uint256 _token_amount, int128 i, uint256 min_amount)',
  'function vote_for_gauge_weights(address _gauge_addr, uint256 _user_weight)',
]);

// Track pending large exchanges per pool for imbalance detection
// key: `${pool}-${i}-${j}` (token pair direction)
interface PendingExchange {
  txHash:    string;
  sender:    string;
  pool:      string;
  i:         number;
  j:         number;
  dx:        bigint;
  timestamp: number;
}

const pendingExchanges = new Map<string, PendingExchange[]>();
const seenTxHashes     = new Set<string>();

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
  catch (err) { console.error('[curve-mempool] Telegram failed:', err); }
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

function decodeExchange(data: string) {
  try {
    const d = iface.decodeFunctionData('exchange', data);
    return { i: Number(d.i), j: Number(d.j), dx: BigInt(d.dx.toString()) };
  } catch { return null; }
}

function decodeRemoveLiq(data: string) {
  try {
    const d = iface.decodeFunctionData('remove_liquidity', data);
    return { amount: BigInt(d._amount.toString()) };
  } catch { return null; }
}

function decodeRemoveLiqOneCoin(data: string) {
  try {
    const d = iface.decodeFunctionData('remove_liquidity_one_coin', data);
    return { amount: BigInt(d._token_amount.toString()), i: Number(d.i) };
  } catch { return null; }
}

function decodeRemoveLiqImbalance(data: string) {
  try {
    const d = iface.decodeFunctionData('remove_liquidity_imbalance', data);
    return { maxBurn: BigInt(d.max_burn_amount.toString()) };
  } catch { return null; }
}

function decodeVoteGauge(data: string) {
  try {
    const d = iface.decodeFunctionData('vote_for_gauge_weights', data);
    return { gauge: d._gauge_addr as string, weight: Number(d._user_weight) };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Stale purge + dedup trim
// ---------------------------------------------------------------------------

function purgeStale() {
  const now = Date.now();
  for (const [key, exchanges] of pendingExchanges.entries()) {
    const fresh = exchanges.filter(e => now - e.timestamp < IMBALANCE_WINDOW_MS);
    if (fresh.length === 0) pendingExchanges.delete(key);
    else pendingExchanges.set(key, fresh);
  }
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

  const to     = tx.to?.toLowerCase();
  const txHash = (tx.hash as string)?.toLowerCase();
  const sender = (tx.from as string)?.toLowerCase() || 'unknown';
  if (!txHash) return;
  if (seenTxHashes.has(txHash)) return;
  seenTxHashes.add(txHash);

  const sig = tx.input.slice(0, 10).toLowerCase();

  // ── POOL TRANSACTIONS ────────────────────────────────────────────────────
  if (to && WATCHED_POOLS.has(to)) {

    // Large exchange — potential price manipulation
    if (sig === SIG_EXCHANGE) {
      const decoded = decodeExchange(tx.input);
      if (!decoded) return;

      const threshold = LARGE_EXCHANGE_THRESHOLDS[to] ?? DEFAULT_EXCHANGE_THRESHOLD;

      if (decoded.dx > threshold) {
        await fireAlert(
          `📊 *LARGE CURVE SWAP DETECTED*\n` +
          `Pool: \`${to}\`\n` +
          `From: \`${sender}\`\n` +
          `Token[${decoded.i}] → Token[${decoded.j}]\n` +
          `Amount in: \`${decoded.dx.toString()}\`\n` +
          `Tx: \`${txHash}\`\n` +
          `⚠️ May move pool price — watch for oracle manipulation downstream`
        );
      }

      // Track for imbalance pattern detection
      const key = `${to}-${decoded.i}-${decoded.j}`;
      const now = Date.now();
      const existing = pendingExchanges.get(key) || [];

      // Multiple large swaps same direction in one block = coordinated imbalance attack
      const recentSame = existing.filter(
        e => e.sender !== sender && now - e.timestamp < IMBALANCE_WINDOW_MS && e.dx > threshold / 2n
      );

      if (recentSame.length >= 2) {
        await fireAlert(
          `🚨 *CURVE POOL IMBALANCE ATTACK PATTERN*\n` +
          `Pool: \`${to}\`\n` +
          `${recentSame.length + 1} large swaps in same direction within 12s\n` +
          `Direction: Token[${decoded.i}] → Token[${decoded.j}]\n` +
          `Latest tx: \`${txHash}\`\n` +
          `⚠️ Pool ratio being skewed — potential exploit setup`
        );
      }

      existing.push({ txHash, sender, pool: to, ...decoded, timestamp: now });
      pendingExchanges.set(key, existing);
      purgeStale();
    }

    // Large liquidity removal
    if (sig === SIG_REMOVE_LIQ) {
      const decoded = decodeRemoveLiq(tx.input);
      if (!decoded) return;

      if (decoded.amount > LARGE_REMOVE_THRESHOLD) {
        await fireAlert(
          `🔥 *LARGE CURVE LIQUIDITY REMOVAL*\n` +
          `Pool: \`${to}\`\n` +
          `From: \`${sender}\`\n` +
          `LP Amount: \`${decoded.amount.toString()}\`\n` +
          `Tx: \`${txHash}\`\n` +
          `⚠️ Pool liquidity dropping — slippage and manipulation risk elevated`
        );
      }
    }

    // Remove liquidity one coin — targeted withdrawal, higher manipulation signal
    if (sig === SIG_REMOVE_LIQ_ONE_COIN) {
      const decoded = decodeRemoveLiqOneCoin(tx.input);
      if (!decoded) return;

      if (decoded.amount > LARGE_REMOVE_THRESHOLD / 2n) {
        await fireAlert(
          `🔥 *CURVE ONE-SIDED LIQUIDITY REMOVAL*\n` +
          `Pool: \`${to}\`\n` +
          `From: \`${sender}\`\n` +
          `LP Amount: \`${decoded.amount.toString()}\`\n` +
          `Target token index: ${decoded.i}\n` +
          `Tx: \`${txHash}\`\n` +
          `⚠️ One-sided removal skews pool ratio — higher risk than balanced removal`
        );
      }
    }

    // Remove liquidity imbalanced
    if (sig === SIG_REMOVE_LIQ_IMBALANCE) {
      const decoded = decodeRemoveLiqImbalance(tx.input);
      if (!decoded) return;

      if (decoded.maxBurn > LARGE_REMOVE_THRESHOLD) {
        await fireAlert(
          `🔥 *CURVE IMBALANCED LIQUIDITY REMOVAL*\n` +
          `Pool: \`${to}\`\n` +
          `From: \`${sender}\`\n` +
          `Max LP Burn: \`${decoded.maxBurn.toString()}\`\n` +
          `Tx: \`${txHash}\`\n` +
          `⚠️ Imbalanced removal — pool ratio at risk`
        );
      }
    }
  }

  // ── GAUGE CONTROLLER ─────────────────────────────────────────────────────
  if (to === GAUGE_CONTROLLER && sig === SIG_VOTE_GAUGE) {
    const decoded = decodeVoteGauge(tx.input);
    if (!decoded) return;

    if (decoded.weight >= LARGE_VOTE_WEIGHT) {
      await fireAlert(
        `🗳️ *LARGE GAUGE WEIGHT VOTE*\n` +
        `From: \`${sender}\`\n` +
        `Gauge: \`${decoded.gauge}\`\n` +
        `Weight: ${decoded.weight / 100}%\n` +
        `Tx: \`${txHash}\`\n` +
        `⚠️ Large CRV emission redirect — potential governance attack`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket + health watchdog
// ---------------------------------------------------------------------------

export function startCurveMempoolMonitor() {
  let ws: WebSocket | null = null;
  let lastMessageAt = Date.now();
  let reconnecting  = false;

  function connect() {
    if (reconnecting) return;
    reconnecting = true;
    console.log('[curve-mempool] Connecting...');
    ws = new WebSocket(WS_URL);
    ws.on("error", () => {});
    ws.on("unexpected-response", (req, res) => {
      console.warn(`[curve-mempool] Unexpected response: ${res.statusCode}`);
      reconnecting = false;
      setTimeout(connect, res.statusCode === 429 ? 10000 : RECONNECT_DELAY_MS);
    });

    ws.on('open', () => {
      reconnecting  = false;
      lastMessageAt = Date.now();
      console.log('[curve-mempool] Connected. Subscribing...');
      ws!.send(JSON.stringify({
        jsonrpc: '2.0', id: 20,
        method: 'eth_subscribe',
        params: ['newPendingTransactions', { includeTransactions: true }],
      }));
    });

    ws.on('message', async (raw: Buffer) => {
      lastMessageAt = Date.now();
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg?.id === 20 && msg?.result) {
        console.log('[curve-mempool] Subscribed, sub ID:', msg.result);
        return;
      }

      const result = msg?.params?.result;
      if (!result) return;

      let tx: any;

      if (typeof result === 'object' && result.input) {
        tx = result;
      } else if (typeof result === 'string' && result.startsWith('0x')) {
        try {
          const rpcUrl = process.env.RPC_URL;
          if (!rpcUrl) return;
          const res  = await fetch(rpcUrl, {
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
          console.error('[curve-mempool] Fallback fetch failed:', err);
          return;
        }
      } else { return; }

      try { await handlePendingTx(tx); }
      catch (err) { console.error('[curve-mempool] Handler error:', tx?.hash, err); }
    });

    ws.on('error', (err) => console.error('[curve-mempool] WS error:', err));

    ws.on('close', (code) => {
      console.warn(`[curve-mempool] Disconnected (${code}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
      reconnecting = false;
      setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  // Health watchdog + metrics
  setInterval(() => {
    const silentMs = Date.now() - lastMessageAt;
    if (silentMs > HEALTH_CHECK_MS) {
      console.warn(`[curve-mempool] Silent for ${silentMs / 1000}s — reconnecting`);
      try { ws?.terminate(); } catch {}
      reconnecting = false;
      connect();
    }
    console.log(
      `[curve-mempool] metrics — received: ${txsReceived} | fullObjects: ${fullTxObjects} | alerts: ${alertsFired}`
    );
    txsReceived = fullTxObjects = alertsFired = 0;
  }, HEALTH_CHECK_MS);

  connect();
}
