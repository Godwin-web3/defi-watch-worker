// src/uniswap-mempool.ts
import WebSocket from 'ws';
import { ethers } from 'ethers';
async function sendTelegramAlert(token: string, chatId: string, message: string) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
  });
}

const WS_URL = process.env.WS_RPC_URL || 'wss://ethereum-rpc.publicnode.com';
const RECONNECT_DELAY_MS   = 5_000;
const HEALTH_CHECK_MS      = 30_000;
const SANDWICH_WINDOW_MS   = 12_000;
const SANDWICH_MIN_VICTIMS = 1;
const CONGESTION_MIN_TXS   = 3;
const DEDUP_SEEN_MAX       = 5_000;
const SANDWICH_GAS_RATIO   = 1.05;

const POOL_BURN_THRESHOLDS: Record<string, bigint> = {
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640': BigInt('500000000000000000'),
  '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8': BigInt('500000000000000000'),
  '0xcbcdf9626bc03e24f779434178a73a0b4bad62ed': BigInt('100000000'),
  '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36': BigInt('500000000000000000'),
};
const DEFAULT_BURN_THRESHOLD = BigInt('1000000000000000000');

const WATCHED_POOLS = new Set(Object.keys(POOL_BURN_THRESHOLDS));

const SIG_SWAP = '0x128acb08';
const SIG_BURN = '0xa34123a7';

const iface = new ethers.Interface([
  'function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data)',
  'function burn(int24 tickLower, int24 tickUpper, uint128 amount)',
]);

interface PendingSwap {
  txHash:          string;
  sender:          string;
  pool:            string;
  zeroForOne:      boolean;
  amountSpecified: bigint;
  gasPrice:        bigint;
  timestamp:       number;
}

const pendingSwaps = new Map<string, PendingSwap[]>();
const seenTxHashes = new Set<string>();

let txsReceived   = 0;
let txsDecoded    = 0;
let alertsFired   = 0;
let fullTxObjects = 0;

function decodeSwap(data: string): { zeroForOne: boolean; amountSpecified: bigint } | null {
  try {
    const d = iface.decodeFunctionData('swap', data);
    return {
      zeroForOne:      d.zeroForOne as boolean,
      amountSpecified: BigInt(d.amountSpecified.toString()),
    };
  } catch { return null; }
}

function decodeBurn(data: string): { amount: bigint } | null {
  try {
    const d = iface.decodeFunctionData('burn', data);
    return { amount: BigInt(d.amount.toString()) };
  } catch { return null; }
}

function parseGasPrice(tx: any): bigint {
  try { return BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? '0x0'); }
  catch { return 0n; }
}

function purgeStale() {
  const now = Date.now();
  for (const [key, swaps] of pendingSwaps.entries()) {
    const fresh = swaps.filter(s => now - s.timestamp < SANDWICH_WINDOW_MS);
    if (fresh.length === 0) pendingSwaps.delete(key);
    else pendingSwaps.set(key, fresh);
  }
  if (seenTxHashes.size > DEDUP_SEEN_MAX) {
    const iter = seenTxHashes.values();
    for (let i = 0; i < DEDUP_SEEN_MAX / 2; i++) seenTxHashes.delete(iter.next().value!);
  }
}

async function fireAlert(msg: string) {
  alertsFired++;
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const chatId = process.env.TELEGRAM_CHAT_ID!;
  try { await sendTelegramAlert(token, chatId, msg); }
  catch (err) { console.error('[uniswap-mempool] Telegram send failed:', err); }
}

async function handlePendingTx(tx: any) {
  txsReceived++;
  if (!tx || typeof tx !== 'object' || typeof tx.input !== 'string') return;
  if (tx.input.length < 10) return;
  const to = tx.to?.toLowerCase();
  if (!to || !WATCHED_POOLS.has(to)) return;
  fullTxObjects++;

  const txHash = (tx.hash as string)?.toLowerCase();
  if (!txHash) return;
  if (seenTxHashes.has(txHash)) return;
  seenTxHashes.add(txHash);

  const sig      = tx.input.slice(0, 10).toLowerCase();
  const gasPrice = parseGasPrice(tx);
  const sender   = (tx.from as string)?.toLowerCase() || 'unknown';

  if (sig === SIG_SWAP) {
    const decoded = decodeSwap(tx.input);
    if (!decoded) return;
    txsDecoded++;

    const now        = Date.now();
    const sameKey    = `${to}-${decoded.zeroForOne}`;
    const reverseKey = `${to}-${!decoded.zeroForOne}`;

    const incoming: PendingSwap = {
      txHash, sender, pool: to,
      zeroForOne:      decoded.zeroForOne,
      amountSpecified: decoded.amountSpecified,
      gasPrice,
      timestamp: now,
    };

    const sameDir    = (pendingSwaps.get(sameKey)    || []).filter(s => now - s.timestamp < SANDWICH_WINDOW_MS);
    const reverseDir = (pendingSwaps.get(reverseKey) || []).filter(s => now - s.timestamp < SANDWICH_WINDOW_MS);

    const ownFrontRuns = reverseDir.filter(s => s.sender === sender);
    const victims      = sameDir.filter(s => s.sender !== sender);

    if (ownFrontRuns.length > 0 && victims.length >= SANDWICH_MIN_VICTIMS) {
      const avgVictimGas     = victims.reduce((acc, s) => acc + s.gasPrice, 0n) / BigInt(victims.length);
      const attackerFrontGas = ownFrontRuns[ownFrontRuns.length - 1].gasPrice;
      const gasRatioOk       = avgVictimGas === 0n || attackerFrontGas >= (avgVictimGas * BigInt(Math.floor(SANDWICH_GAS_RATIO * 100))) / 100n;

      if (gasRatioOk) {
        await fireAlert(
          `🥪 *SANDWICH ATTACK — BACK-RUN DETECTED*\n` +
          `Pool: \`${to}\`\n` +
          `Attacker: \`${sender}\`\n` +
          `Back-run tx: \`${txHash}\`\n` +
          `Victims in window: ${victims.length}\n` +
          `Attacker front-run gas: ${ethers.formatUnits(attackerFrontGas, 'gwei')} gwei\n` +
          `Avg victim gas: ${ethers.formatUnits(avgVictimGas, 'gwei')} gwei\n` +
          `Direction reversed: ${decoded.zeroForOne ? 'token1→token0' : 'token0→token1'}`
        );
      }
    }

    const otherSenders = sameDir.filter(s => s.sender !== sender);
    if (otherSenders.length >= CONGESTION_MIN_TXS - 1) {
      const gasPrices = [...otherSenders.map(s => s.gasPrice), gasPrice].sort((a, b) => (a > b ? 1 : -1));
      const minGas    = gasPrices[0];
      const maxGas    = gasPrices[gasPrices.length - 1];
      const gasSpread = minGas !== 0n && maxGas > (minGas * 110n) / 100n;

      await fireAlert(
        `⚠️ *SWAP CONGESTION${gasSpread ? ' / FRONT-RUN BIDDING WAR' : ''}*\n` +
        `Pool: \`${to}\`\n` +
        `${otherSenders.length + 1} senders in same direction within ${SANDWICH_WINDOW_MS / 1000}s\n` +
        `Gas range: ${ethers.formatUnits(minGas, 'gwei')}–${ethers.formatUnits(maxGas, 'gwei')} gwei\n` +
        `Latest tx: \`${txHash}\``
      );
    }

    const existing = pendingSwaps.get(sameKey) || [];
    existing.push(incoming);
    pendingSwaps.set(sameKey, existing);
    purgeStale();
  }

  if (sig === SIG_BURN) {
    const decoded = decodeBurn(tx.input);
    if (!decoded) return;
    txsDecoded++;

    const threshold = POOL_BURN_THRESHOLDS[to] ?? DEFAULT_BURN_THRESHOLD;
    if (decoded.amount > threshold) {
      await fireAlert(
        `🔥 *LARGE LIQUIDITY REMOVAL*\n` +
        `Pool: \`${to}\`\n` +
        `From: \`${sender}\`\n` +
        `Amount: \`${decoded.amount.toString()}\` liquidity units\n` +
        `Threshold: \`${threshold.toString()}\`\n` +
        `Tx: \`${txHash}\`\n` +
        `⚠️ Pool may become thin — manipulation risk elevated`
      );
    }
  }
}

export function startUniswapMempoolMonitor() {
  let ws: WebSocket | null = null;
  let lastMessageAt = Date.now();
  let reconnecting  = false;

  function connect() {
    if (reconnecting) return;
    reconnecting = true;
    console.log('[uniswap-mempool] Connecting...');
    ws = new WebSocket(WS_URL);
    ws.on("error", () => {});
    ws.on("unexpected-response", (req, res) => {
      console.warn(`[uniswap-mempool] Unexpected response: ${res.statusCode}`);
      reconnecting = false;
      setTimeout(connect, res.statusCode === 429 ? 10000 : RECONNECT_DELAY_MS);
    });

    ws.on('open', () => {
      reconnecting  = false;
      lastMessageAt = Date.now();
      console.log('[uniswap-mempool] Connected. Subscribing...');
      ws!.send(JSON.stringify({
        jsonrpc: '2.0', id: 10,
        method: 'eth_subscribe',
        params: ['newPendingTransactions', { includeTransactions: true }],
      }));
    });

    ws.on('message', async (raw: Buffer) => {
      lastMessageAt = Date.now();
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg?.id === 10 && msg?.result) {
        console.log('[uniswap-mempool] Subscribed, sub ID:', msg.result);
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
          console.error('[uniswap-mempool] Fallback fetch failed:', err);
          return;
        }
      } else { return; }

      try { await handlePendingTx(tx); }
      catch (err) { console.error('[uniswap-mempool] Handler error:', tx?.hash, err); }
    });

    ws.on('error', (err) => console.error('[uniswap-mempool] WS error:', err));

    ws.on('close', (code) => {
      console.warn(`[uniswap-mempool] Disconnected (${code}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
      reconnecting = false;
      setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  setInterval(() => {
    const silentMs = Date.now() - lastMessageAt;
    if (silentMs > HEALTH_CHECK_MS) {
      console.warn(`[uniswap-mempool] Silent for ${silentMs / 1000}s — reconnecting`);
      try { ws?.terminate(); } catch {}
      reconnecting = false;
      connect();
    }
    console.log(
      `[uniswap-mempool] metrics — received: ${txsReceived} | fullObjects: ${fullTxObjects} | ` +
      `decoded: ${txsDecoded} | alerts: ${alertsFired} | ` +
      `swapKeys: ${pendingSwaps.size} | seenHashes: ${seenTxHashes.size}`
    );
    txsReceived = txsDecoded = alertsFired = fullTxObjects = 0;
  }, HEALTH_CHECK_MS);

  connect();
}
