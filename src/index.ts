import { JsonRpcProvider, WebSocketProvider } from 'ethers';
import { monitorAave } from './protocols/aave.js';
import { monitorUniswap } from './protocols/uniswap.js';
import { monitorCurve } from './protocols/curve.js';
import { monitorMaker } from './protocols/maker.js';
import { monitorLido } from './protocols/lido.js';
import { monitorOracle } from './protocols/oracle.js';
import * as dotenv from 'dotenv';
import http from 'http';

import { getTransaction, updateActor, getThreatPrefix, formatActorDescription, calculatePriceImpact, getKV, putKV, supabase, AAVE_ORACLE } from './utils.js';
import { computeFlowDelta } from './flowTracker.js';
import { startMempoolMonitor } from './mempool.js';
import { startAaveMempoolMonitor } from './aave-mempool.js';
import { startUniswapMempoolMonitor } from './uniswap-mempool.js';
import { startCurveMempoolMonitor } from './curve-mempool.js';
import { normalizeAlert } from './alerts.js';
import { Contract, ZeroAddress } from 'ethers';

dotenv.config();

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(port, () => {
  console.log(`Health check server listening on port ${port}`);
});

async function checkContractAge(address: string, currentBlock: number, provider: JsonRpcProvider): Promise<boolean> {
  try {
    const historicalBlock = currentBlock - 50400; // ~7 days
    const code = await provider.getCode(address, historicalBlock);
    return code === '0x';
  } catch (e) {
    return false;
  }
}

async function handleFlashLoanAlert(alert: any, actor: string, provider: JsonRpcProvider, flashLoanAsset?: string, flashLoanAmount?: bigint, flashLoanPremium?: bigint) {
  try {
    const flowResult = await computeFlowDelta(alert.txHash, actor, provider, flashLoanAsset, flashLoanAmount, flashLoanPremium);
    if (flowResult) {
      alert.classificationTag = flowResult.classificationTag;
      if (flowResult.classificationTag === 'CONFIRMED_EXTRACTION') {
        alert.severity = 'critical';
        alert.usdSurplus = flowResult.atomicExecutionSurplus;
      }
    }
  } catch (e) {
    console.error(`[Alert] Flow analysis failed for ${alert.txHash}:`, e);
  }
}

async function checkOraclePrice(assetAddress: string, provider: JsonRpcProvider) {
  try {
    const oracle = new Contract(AAVE_ORACLE, ['function getAssetPrice(address) view returns (uint256)'], provider);
    const currentPrice: bigint = await oracle.getAssetPrice(assetAddress);
    const kvKey = `price:${assetAddress.toLowerCase()}`;
    const lastStored = await getKV(kvKey);
    let lastPrice = 0n;
    let deviation = 0;
    if (lastStored) {
      const parsed = JSON.parse(lastStored);
      lastPrice = BigInt(parsed.price);
      if (lastPrice > 0n) {
        const diff = currentPrice > lastPrice ? currentPrice - lastPrice : lastPrice - currentPrice;
        deviation = Number((diff * 10000n) / lastPrice) / 100;
      }
    }
    await putKV(kvKey, JSON.stringify({ price: currentPrice.toString(), timestamp: Date.now() }));
    return { currentPrice, lastPrice, deviation };
  } catch (e) {
    return null;
  }
}

async function checkChainlinkDivergence(assetAddress: string, aavePrice: bigint, provider: JsonRpcProvider) {
  try {
    const oracle = new Contract(AAVE_ORACLE, ['function getSourceOfAsset(address) view returns (address)'], provider);
    const feedAddress = await oracle.getSourceOfAsset(assetAddress);
    if (feedAddress === ZeroAddress) return null;
    const feed = new Contract(feedAddress, ['function latestAnswer() view returns (int256)'], provider);
    const chainlinkPrice: bigint = await feed.latestAnswer();
    const diff = aavePrice > chainlinkPrice ? aavePrice - chainlinkPrice : chainlinkPrice - aavePrice;
    const divergence = Number((diff * 10000n) / chainlinkPrice) / 100;
    return { chainlinkPrice, divergence };
  } catch (e) {
    return null;
  }
}

async function saveToSupabase(input: any) {
  if (!input) return;
  const items = Array.isArray(input) ? input : [input];
  const normalizedItems = [];
  for (const item of items) {
    const normalized = normalizeAlert(item);
    if (normalized) normalizedItems.push(normalized);
  }
  if (normalizedItems.length === 0) return;
  const { error } = await supabase.from('alerts').insert(normalizedItems);
  if (error) console.error('Failed to save to Supabase:', error);
}

async function sendTelegram(alert: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  if ((alert.actorScore || 0) <= 30 && alert.severity !== 'critical' && !alert.firstTimeActor) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const threatPrefix = alert.threatPrefix || "";
  const header = `🚨 *${threatPrefix}${alert.title.toUpperCase()} ALERT* 🚨`;
  const pastEvents = (alert.recentEvents || []).slice(1);
  const historyBlock = pastEvents.length > 0 ? "\nPrevious Activity:\n" + pastEvents.map((e: any, i: number) => "• " + e.description + " (Block: " + e.blockNumber + ") [TX](https://etherscan.io/tx/" + e.txHash + ")").join("\n") : "";
  const text = `${header}\n\nSeverity: ${alert.severity}\nScore: ${alert.actorScore}\nDetails: ${alert.description}\nTX: [View](https://etherscan.io/tx/${alert.txHash})${historyBlock}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
    if (!response.ok) {
      console.error(`[Alert] Telegram API error: ${response.status} ${response.statusText}`);
    }
  } catch (e) {
    console.error(`[Alert] Failed to send Telegram:`, e);
  }
}

async function run() {
  const provider = new JsonRpcProvider(process.env.RPC_URL || 'https://ethereum.publicnode.com');
  const currentBlock = await provider.getBlockNumber();
  let fromBlock: number;
  const lastBlockStr = await getKV('last_processed_block');
  
  if (lastBlockStr) {
    fromBlock = parseInt(lastBlockStr) + 1;
  } else {
    fromBlock = currentBlock - 5;
  }

  if (fromBlock > currentBlock) return;
  
  const targetBlock = Math.max(fromBlock, currentBlock - 1);
  // Process in chunks of 5 blocks to keep it efficient yet robust
  const CHUNK_SIZE = 5;

  for (let start = fromBlock; start <= targetBlock; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, targetBlock);
    const fromBlockHex = '0x' + start.toString(16);
    const toBlockHex = '0x' + end.toString(16);

    console.log(`Scanning blocks ${start} to ${end}`);

    const alerts: any[] = [];
    const activityTracker = new Map<string, number>();
    const assetsToMonitor = new Set<string>();
    const now = Date.now();

    try {
      // Run all protocol monitors
      await Promise.all([
        monitorAave({}, provider, fromBlockHex, toBlockHex, now, alerts, activityTracker, updateActor, getTransaction, getThreatPrefix, formatActorDescription, checkContractAge, handleFlashLoanAlert, currentBlock, assetsToMonitor),
        monitorUniswap({}, provider, fromBlockHex, toBlockHex, now, alerts, activityTracker, updateActor, getTransaction, getThreatPrefix, formatActorDescription, calculatePriceImpact),
        monitorCurve({}, provider, fromBlockHex, toBlockHex, now, alerts, activityTracker, updateActor, getTransaction, getThreatPrefix, formatActorDescription),
        monitorMaker({}, provider, fromBlockHex, toBlockHex, now, alerts, activityTracker, updateActor, getTransaction, getThreatPrefix, formatActorDescription),
        monitorLido({}, provider, fromBlockHex, toBlockHex, now, alerts, activityTracker, updateActor, getTransaction, getThreatPrefix, formatActorDescription)
      ]);

      // Oracle Monitor (runs after protocols to use assetsToMonitor)
      const correlativeAlerts = alerts.filter(a => a.severity === 'critical');
      await monitorOracle({}, provider, end, now, alerts, assetsToMonitor, 
        (asset: string) => checkOraclePrice(asset, provider),
        (asset: string, price: bigint) => checkChainlinkDivergence(asset, price, provider),
        correlativeAlerts
      );

      if (alerts.length > 0) {
        await saveToSupabase(alerts);
        for (const alert of alerts) {
          if (['critical', 'high'].includes(alert.severity)) {
            await sendTelegram(alert);
          }
        }
      }

      // Checkpoint after successful chunk processing
      await putKV('last_processed_block', end.toString());
    } catch (e) {
      console.error(`[Worker] Critical failure in block range ${start}-${end}:`, e);
      break; // Exit loop on critical failure to prevent corrupted state
    }
  }
}

console.log('Starting DeFi Watch Worker...');
startMempoolMonitor();
startAaveMempoolMonitor();
startUniswapMempoolMonitor();
startCurveMempoolMonitor();

run().catch(console.error);
setInterval(() => {
  run().catch(console.error);
}, 60000);
