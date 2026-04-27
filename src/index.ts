import { JsonRpcProvider } from 'ethers';
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
        // Persistence is handled within computeFlowDelta or separate logic if needed, 
        // but here we just update the alert object.
      }
    }
  } catch (e) {
    console.error('Error in handleFlashLoanAlert:', e);
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
  if ((alert.actorScore || 0) <= 30 && alert.severity !== 'critical') return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const threatPrefix = alert.threatPrefix || "";
  const header = `🚨 *${threatPrefix}${alert.title.toUpperCase()} ALERT* 🚨`;
  const text = `${header}\n\nSeverity: ${alert.severity}\nScore: ${alert.actorScore}\nDetails: ${alert.description}\nTX: [View](https://etherscan.io/tx/${alert.txHash})`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
  } catch (e) {}
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
  const toBlock = Math.max(fromBlock, currentBlock - 1);
  const fromBlockHex = '0x' + fromBlock.toString(16);
  const toBlockHex = '0x' + toBlock.toString(16);

  console.log(`Scanning blocks ${fromBlock} to ${toBlock}`);

  const alerts: any[] = [];
  const activityTracker = new Map<string, number>();
  const assetsToMonitor = new Set<string>();
  const now = Date.now();

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
  await monitorOracle({}, provider, toBlock, now, alerts, assetsToMonitor, 
    (asset: string) => checkOraclePrice(asset, provider),
    (asset: string, price: bigint) => checkChainlinkDivergence(asset, price, provider),
    correlativeAlerts
  );

  await saveToSupabase(alerts);
  for (const alert of alerts) {
    if (['critical', 'high'].includes(alert.severity)) {
      await sendTelegram(alert);
    }
  }

  await putKV('last_processed_block', toBlock.toString());
}

console.log('Starting DeFi Watch Worker...');
run().catch(console.error);
setInterval(() => {
  run().catch(console.error);
}, 60000);
