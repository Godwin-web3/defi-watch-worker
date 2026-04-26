import { Interface, JsonRpcProvider, ZeroAddress, Contract, formatUnits } from 'ethers';
import { monitorAave } from './protocols/aave';
import { monitorUniswap } from './protocols/uniswap';
import { monitorCurve } from './protocols/curve';
import { monitorMaker } from './protocols/maker';
import { monitorLido } from './protocols/lido';
import { monitorOracle } from './protocols/oracle';

// Import utility functions from utils.ts
import { getTransaction, getActorRecord, updateActor, getThreatPrefix, formatActorDescription, calculatePriceImpact, getUsdValue, AAVE_ORACLE } from './utils';
import { computeFlowDelta } from './flowTracker';
// Import types from types.ts
import { Env, ActorRecord } from './types';

// Removed original inline interface definitions for Env, ActorEvent, ActorRecord

const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

import aaveAbi from './abis/aave-v3.json';
import uniswapAbi from './abis/uniswap-v3.json';
const aaveInterface = new Interface(aaveAbi);
const uniswapInterface = new Interface(uniswapAbi);

// Functions defined in index.ts (not extracted to utils.ts)
async function checkContractAge(address: string, currentBlock: number, provider: JsonRpcProvider): Promise<boolean> {
  try {
    // 7 days ~ 50400 blocks (12s per block)
    const historicalBlock = currentBlock - 50400;
    const code = await provider.getCode(address, historicalBlock);
    return code === '0x'; // If no code 7 days ago, it's a new contract
  } catch (e) {
    return false;
  }
}

async function handleFlashLoanAlert(alert: any, actor: string, env: Env, provider: JsonRpcProvider, flashLoanAsset?: string, flashLoanAmount?: bigint, flashLoanPremium?: bigint) {
  try {
    const flowResult = await computeFlowDelta(alert.txHash, actor, provider, flashLoanAsset, flashLoanAmount, flashLoanPremium); // computeFlowDelta is not defined, assumed imported or globally available.
    if (flowResult) {
      alert.classificationTag = flowResult.classificationTag;
      if (flowResult.classificationTag === 'CONFIRMED_EXTRACTION') {
        alert.severity = 'critical';
        alert.usdSurplus = flowResult.atomicExecutionSurplus;
        
        const record = await getActorRecord(actor, env); // getActorRecord imported from utils
        record.confirmedExtractions = (record.confirmedExtractions || 0) + 1;
        record.totalExtractedUsd = (record.totalExtractedUsd || 0) + flowResult.atomicExecutionSurplus;
        await env.DEFI_WATCH_KV.put(`actor:${actor.toLowerCase()}`, JSON.stringify(record));
        await env.DEFI_WATCH_KV.put(`flow:${alert.txHash}`, JSON.stringify(flowResult));
      } else if (flowResult.classificationTag === 'SUSPECTED_ATTEMPT') {
        await updateActor(actor, 0, 'Suspected extraction attempt', env, alert.txHash, alert.blockNumber); // updateActor imported from utils
      }
    }
  } catch (e) {
    // Fail silently
  }
}

async function checkOraclePrice(assetAddress: string, env: Env, provider: JsonRpcProvider) {
  try {
    const oracle = new Contract(AAVE_ORACLE, ['function getAssetPrice(address) view returns (uint256)'], provider); // AAVE_ORACLE is imported from ./utils
    const currentPrice: bigint = await oracle.getAssetPrice(assetAddress);

    const kvKey = `price:${assetAddress.toLowerCase()}`;
    const lastStored = await env.DEFI_WATCH_KV.get(kvKey);

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

    await env.DEFI_WATCH_KV.put(kvKey, JSON.stringify({
      price: currentPrice.toString(),
      timestamp: Date.now()
    }));

    return {
      currentPrice,
      lastPrice,
      deviation
    };
  } catch (e) {
    console.error('Error in checkOraclePrice:', e);
    return null;
  }
}

async function checkChainlinkDivergence(assetAddress: string, aavePrice: bigint, provider: JsonRpcProvider) {
  try {
    const oracle = new Contract(AAVE_ORACLE, ['function getSourceOfAsset(address) view returns (address)'], provider); // AAVE_ORACLE is imported from ./utils
    const feedAddress = await oracle.getSourceOfAsset(assetAddress);

    if (feedAddress === ZeroAddress) return null;

    const feed = new Contract(feedAddress, ['function latestAnswer() view returns (int256)'], provider);
    const chainlinkPrice: bigint = await feed.latestAnswer();

    const diff = aavePrice > chainlinkPrice ? aavePrice - chainlinkPrice : chainlinkPrice - aavePrice;
    const divergence = Number((diff * 10000n) / chainlinkPrice) / 100;

    return {
      chainlinkPrice,
      divergence
    };
  } catch (e) {
    console.error('Error in checkChainlinkDivergence:', e);
    return null;
  }
}

async function saveToSupabase(alert: any, env: Env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    console.warn('Supabase credentials missing');
    return;
  }
  const url = `${env.SUPABASE_URL}/rest/v1/alerts`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(alert)
    });
    if (!response.ok) {
      console.error('Failed to save to Supabase:', response.statusText, await response.text());
    }
  } catch (e) {
    console.error('Error saving to Supabase:', e);
  }
}

async function sendTelegram(alert: any, env: Env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  
  // 0 to 30 log only no Telegram
  if ((alert.actorScore || 0) <= 30) {
    console.log(`Log only (Score ${alert.actorScore}): ${alert.title} - ${alert.description}`);
    return;
  }

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const threatPrefix = alert.threatPrefix || "";
  
  const actorScoreLine = `Actor Score: ${alert.actorScore} | History: ${alert.actorHistoryCount}`;
  let historySection = "";
  if ((alert.actorScore || 0) > 60 && alert.recentEvents && alert.recentEvents.length > 1) {
    const history = alert.recentEvents.slice(1, 6);
    const df = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC'
    });
    
    historySection = `
` + history.map((ev: any) => {
      const dateStr = df.format(new Date(ev.timestamp)).replace(',', '') + " UTC";
      return `• ${ev.description} (${dateStr} | Block: ${ev.blockNumber}) [TX](https://etherscan.io/tx/${ev.txHash})`;
    }).join(`
`);
  }

  const currentEventDetails = alert.description.split(" | Actor Score:")[0];

  let header = `🚨 *${threatPrefix}${alert.title.toUpperCase()} ALERT* 🚨`;
  if (alert.firstTimeActor) {
    header = `🔴 FIRST-TIME ACTOR + FLASH LOAN: No prior history.
${header}`;
  }
  if (alert.classificationTag === 'CONFIRMED_EXTRACTION') {
    header = `💰 CONFIRMED EXTRACTION: $${alert.usdSurplus?.toFixed(2)} pre-gas surplus
${header}`;
  }

  let footer = "";
  if (alert.classificationTag === 'SUSPECTED_ATTEMPT') {
    footer += `

⚠️ Suspected extraction attempt.`;
  }
  if (alert.cascadeRisk) {
    footer += `

⚠️ CASCADE RISK: Active liquidations in same block.`;
  }

  const text = `${header}

Severity: ${alert.severity}
${actorScoreLine}${historySection}
Details: ${currentEventDetails}
Block: ${alert.blockNumber}
TX: [View on Etherscan](https://etherscan.io/tx/${alert.txHash})${footer}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'Markdown'
      })
    });
    if (!response.ok) {
      console.error('Failed to send Telegram message:', response.statusText);
    }
  } catch (e) {
    console.error('Error sending Telegram message:', e);
  }
}

async function run(env: Env) {
  const provider = new JsonRpcProvider(env.RPC_URL || 'https://ethereum.publicnode.com');
  const currentBlock = await provider.getBlockNumber();
  
  // Retrieve the last processed block from KV
  let fromBlock: number;
  const lastBlockStr = await env.DEFI_WATCH_KV.get('last_processed_block');
  
  if (lastBlockStr) {
    fromBlock = parseInt(lastBlockStr) + 1;
  } else {
    // Default to scanning the last 10 blocks if no record exists
    fromBlock = currentBlock - 10;
  }

  // If fromBlock is greater than currentBlock, we've already processed everything
  if (fromBlock > currentBlock) {
    console.log(`Already processed up to block ${currentBlock}`);
    return;
  }

  // Safety cap: scan at most 1000 blocks at once
  if (currentBlock - fromBlock > 1000) {
    console.warn(`Large gap detected: ${currentBlock - fromBlock} blocks. Capping at 1000.`);
    fromBlock = currentBlock - 1000;
  }

  const toBlock = currentBlock;
  const fromBlockHex = '0x' + fromBlock.toString(16);
  const toBlockHex = '0x' + toBlock.toString(16);

  console.log(`Scanning blocks ${fromBlock} to ${toBlock}`);

  const alerts: any[] = [];
  const now = Date.now();
  const assetsToMonitor = new Set<string>();

  // 1. Aave V3 Monitoring
  const aaveLogs = await provider.send('eth_getLogs', [{
    address: AAVE_V3_POOL,
    fromBlock: fromBlockHex,
    toBlock: toBlockHex,
    topics: [
      [
        aaveInterface.getEvent('Borrow')?.topicHash,
        aaveInterface.getEvent('LiquidationCall')?.topicHash,
        aaveInterface.getEvent('FlashLoan')?.topicHash
      ]
    ]
  }]);

  const decodedAaveLogs: any[] = [];
  for (const log of aaveLogs) {
    const decoded = aaveInterface.parseLog(log);
    if (!decoded) continue;

    const blockNumber = parseInt(log.blockNumber, 16);
    let usdValue = 0;
    if (decoded.name === 'Borrow') {
      usdValue = await getUsdValue(decoded.args.reserve, decoded.args.amount, provider, blockNumber); // getUsdValue is imported from ./utils
    }

    decodedAaveLogs.push({
      log,
      decoded,
      usdValue,
      blockNumber,
      transactionHash: log.transactionHash
    });

    const baseAlert = {
      contractId: 'aave-v3',
      contractName: 'Aave V3 Pool',
      contractAddress: AAVE_V3_POOL,
      chain: 'ethereum',
      protocol: 'aave',
      txHash: log.transactionHash,
      blockNumber: blockNumber,
      timestamp: now,
    };

    if (decoded.name === 'Borrow') {
      const { reserve, amount, user } = decoded.args;
      assetsToMonitor.add(reserve);
      if (usdValue > 1000) {
        const pool = new Contract(AAVE_V3_POOL, [
          'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)'
        ], provider);

        const [currentData, previousData] = await Promise.all([
          pool.getUserAccountData(user, { blockTag: blockNumber }),
          pool.getUserAccountData(user, { blockTag: blockNumber - 1 }).catch(() => null)
        ]);

        const healthFactor = currentData ? Number(formatUnits(currentData.healthFactor, 18)) : 0;
        const ltv = currentData ? Number(currentData.ltv) : 0;
        const isFirstTime = previousData ? previousData.totalCollateralBase === 0n : true;

        let actorPoints = 0;
        if (isFirstTime) actorPoints += 15;
        if (healthFactor < 1.5) actorPoints += 20;
        if (ltv > 80) actorPoints += 15;
        
        const tx = await getTransaction(log.transactionHash, provider);
        if (tx && !tx.to) actorPoints += 25;

        const actorRecord = await updateActor(user, actorPoints, `Aave Borrow: ${usdValue.toFixed(2)} USD`, env, log.transactionHash, blockNumber);

        // Cascade risk: health factor < 1.05 AND 2+ LiquidationCall events in same block
        const blockLiquidations = decodedAaveLogs.filter(l => l.blockNumber === blockNumber && l.decoded.name === 'LiquidationCall');
        const cascadeRisk = healthFactor < 1.05 && blockLiquidations.length >= 2;

        alerts.push({
          ...baseAlert,
          id: `${log.transactionHash}-aave-borrow`,
          severity: 'high',
          title: 'Aave V3 Large Borrow',
          description: formatActorDescription(`Large borrow: ${usdValue.toFixed(2)} USD by ${user} | Health Factor: ${healthFactor.toFixed(2)} | LTV: ${(ltv / 100).toFixed(0)}% | First time borrower: ${isFirstTime ? 'yes' : 'no'}`, actorRecord),
          actorScore: actorRecord.score,
          actorHistoryCount: actorRecord.eventCount,
          recentEvents: actorRecord.recentEvents,
          threatPrefix: getThreatPrefix(actorRecord),
          cascadeRisk
        });
      }
    } else if (decoded.name === 'LiquidationCall') {
      const { user, collateralAsset, debtAsset } = decoded.args;
      assetsToMonitor.add(collateralAsset);
      assetsToMonitor.add(debtAsset);
      const tx = await getTransaction(log.transactionHash, provider);
      let actorPoints = 0;
      if (tx && !tx.to) actorPoints += 25;
      
      const actorRecord = await updateActor(user, actorPoints, 'Aave Liquidation', env, log.transactionHash, blockNumber);

      alerts.push({
        ...baseAlert,
        id: `${log.transactionHash}-aave-liq`,
        severity: 'high',
        title: 'Aave V3 Liquidation',
        description: formatActorDescription(`Liquidation detected for user ${user}`, actorRecord),
        actorScore: actorRecord.score,
        actorHistoryCount: actorRecord.eventCount,
        recentEvents: actorRecord.recentEvents,
        threatPrefix: getThreatPrefix(actorRecord)
      });
    } else if (decoded.name === 'FlashLoan') {
      const { initiator, asset, amount, premium } = decoded.args;
      assetsToMonitor.add(asset);
      const isNewContract = await checkContractAge(initiator, currentBlock, provider); // checkContractAge is defined in index.ts
      
      let actorPoints = 15; // flash loan detected
      if (isNewContract) actorPoints += 20;
      const tx = await getTransaction(log.transactionHash, provider);
      if (tx && !tx.to) actorPoints += 25;

      const actorRecord = await updateActor(initiator, actorPoints, 'Aave FlashLoan', env, log.transactionHash, blockNumber);

      if (isNewContract) {
        const alert: any = {
          ...baseAlert,
          id: `${log.transactionHash}-aave-flash`,
          severity: 'critical',
          title: 'Aave V3 Suspicious FlashLoan',
          description: formatActorDescription(`FlashLoan by new contract (<7 days): ${initiator}`, actorRecord),
          actorScore: actorRecord.score,
          actorHistoryCount: actorRecord.eventCount,
          recentEvents: actorRecord.recentEvents,
          threatPrefix: getThreatPrefix(actorRecord),
          flashLoanAmount: amount,
          flashLoanPremium: premium,
          firstTimeActor: actorRecord.eventCount === 1 // After updateActor, eventCount is at least 1
        };
        await handleFlashLoanAlert(alert, initiator, env, provider, asset, amount, premium); // handleFlashLoanAlert is defined in index.ts
        alerts.push(alert);
      }
    }
  }

  // Layer 1 - Same transaction correlation
  const logsByTx: Record<string, any[]> = {};
  for (const item of decodedAaveLogs) {
    if (!logsByTx[item.transactionHash]) logsByTx[item.transactionHash] = [];
    logsByTx[item.transactionHash].push(item);
  }

  for (const [txHash, txLogs] of Object.entries(logsByTx)) {
    const hasFlashLoan = txLogs.some(l => l.decoded.name === 'FlashLoan');
    const hasBorrow = txLogs.some(l => l.decoded.name === 'Borrow');
    const hasLiquidation = txLogs.some(l => l.decoded.name === 'LiquidationCall');

    const baseAlert = {
      contractId: 'aave-v3',
      contractName: 'Aave V3 Pool',
      contractAddress: AAVE_V3_POOL,
      chain: 'ethereum',
      protocol: 'aave',
      txHash: txHash,
      blockNumber: txLogs[0].blockNumber,
      timestamp: now,
    };

    const tx = await getTransaction(txHash, provider);
    const actor = tx?.from || ZeroAddress;
    let actorPoints = 0;
    if (hasFlashLoan && hasBorrow) actorPoints += 25;
    if (tx && !tx.to) actorPoints += 25;

    if (hasFlashLoan && hasBorrow && hasLiquidation) {
      const actorRecord = await updateActor(actor, actorPoints, 'Aave Exploit Pattern (Flash+Borrow+Liq)', env, txHash, txLogs[0].blockNumber);
      const alert: any = {
        ...baseAlert,
        id: `${txHash}-aave-exploit-pattern`,
        severity: 'critical',
        title: 'Aave V3 Exploit Pattern',
        description: formatActorDescription(`FlashLoan, Borrow, and Liquidation detected in same transaction: ${txHash}`, actorRecord),
        actorScore: actorRecord.score,
        actorHistoryCount: actorRecord.eventCount,
        recentEvents: actorRecord.recentEvents,
        threatPrefix: getThreatPrefix(actorRecord),
        firstTimeActor: actorRecord.eventCount === 1
      };
      const fl = txLogs.find(l => l.decoded.name === 'FlashLoan')?.decoded;
      await handleFlashLoanAlert(alert, actor, env, provider, fl?.args.asset, fl?.args.amount, fl?.args.premium);
      alerts.push(alert);
    } else if (hasFlashLoan && hasBorrow) {
      const actorRecord = await updateActor(actor, actorPoints, 'Aave FlashLoan + Borrow', env, txHash, txLogs[0].blockNumber);
      const alert: any = {
        ...baseAlert,
        id: `${txHash}-aave-flash-borrow`,
        severity: 'high',
        title: 'Aave V3 FlashLoan + Borrow',
        description: formatActorDescription(`FlashLoan and Borrow detected in same transaction: ${txHash}`, actorRecord),
        actorScore: actorRecord.score,
        actorHistoryCount: actorRecord.eventCount,
        recentEvents: actorRecord.recentEvents,
        threatPrefix: getThreatPrefix(actorRecord),
        firstTimeActor: actorRecord.eventCount === 1
      };
      const fl = txLogs.find(l => l.decoded.name === 'FlashLoan')?.decoded;
      await handleFlashLoanAlert(alert, actor, env, provider, fl?.args.asset, fl?.args.amount, fl?.args.premium);
      alerts.push(alert);
    } else if (hasFlashLoan && hasLiquidation) {
      const actorRecord = await updateActor(actor, actorPoints, 'Aave FlashLoan + Liquidation', env, txHash, txLogs[0].blockNumber);
      const alert: any = {
        ...baseAlert,
        id: `${txHash}-aave-flash-liq`,
        severity: 'critical',
        title: 'Aave V3 FlashLoan + Liquidation',
        description: formatActorDescription(`FlashLoan and Liquidation detected in same transaction: ${txHash}`, actorRecord),
        actorScore: actorRecord.score,
        actorHistoryCount: actorRecord.eventCount,
        recentEvents: actorRecord.recentEvents,
        threatPrefix: getThreatPrefix(actorRecord),
        firstTimeActor: actorRecord.eventCount === 1
      };
      const fl = txLogs.find(l => l.decoded.name === 'FlashLoan')?.decoded;
      await handleFlashLoanAlert(alert, actor, env, provider, fl?.args.asset, fl?.args.amount, fl?.args.premium);
      alerts.push(alert);
    }
  }

  // Layer 2 - Same block correlation
  const logsByBlock: Record<number, any[]> = {};
  for (const item of decodedAaveLogs) {
    if (!logsByBlock[item.blockNumber]) logsByBlock[item.blockNumber] = [];
    logsByBlock[item.blockNumber].push(item);
  }

  for (const [blockNumberStr, blockLogs] of Object.entries(logsByBlock)) {
    const blockNumber = parseInt(blockNumberStr);
    const liquidations = blockLogs.filter(l => l.decoded.name === 'LiquidationCall');
    const borrows = blockLogs.filter(l => l.decoded.name === 'Borrow');
    const hasLargeBorrow = borrows.some(l => l.usdValue > 100000);

    const baseAlert = {
      contractId: 'aave-v3',
      contractName: 'Aave V3 Pool',
      contractAddress: AAVE_V3_POOL,
      chain: 'ethereum',
      protocol: 'aave',
      blockNumber: blockNumber,
      timestamp: now,
    };

    if (liquidations.length >= 3 || (hasLargeBorrow && liquidations.length > 0)) {
      const triggerLog = borrows.find(b => b.usdValue > 100000) || liquidations[0];
      const tx = await getTransaction(triggerLog.transactionHash, provider);
      const actor = tx?.from || ZeroAddress;
      let actorPoints = 0;
      if (tx && !tx.to) actorPoints += 25;

      if (liquidations.length >= 3) {
        const actorRecord = await updateActor(actor, actorPoints, 'Aave Liquidation Cascade', env, liquidations[0].transactionHash, blockNumber);
        alerts.push({
          ...baseAlert,
          id: `${blockNumber}-aave-liq-cascade`,
          txHash: liquidations[0].transactionHash,
          severity: 'critical',
          title: 'Aave V3 Liquidation Cascade',
          description: formatActorDescription(`${liquidations.length} liquidations detected in block ${blockNumber}`, actorRecord),
          actorScore: actorRecord.score,
          actorHistoryCount: actorRecord.eventCount,
          recentEvents: actorRecord.recentEvents,
          threatPrefix: getThreatPrefix(actorRecord)
        });
      }

      if (hasLargeBorrow && liquidations.length > 0) {
        const actorRecord = await updateActor(actor, actorPoints, 'Aave Borrow + Liquidation Block', env, triggerLog.transactionHash, blockNumber);
        alerts.push({
          ...baseAlert,
          id: `${blockNumber}-aave-borrow-liq-block`,
          txHash: triggerLog.transactionHash,
          severity: 'critical',
          title: 'Aave V3 Borrow + Liquidation Block',
          description: formatActorDescription(`Large borrow (>$100k) and liquidation detected in same block ${blockNumber}`, actorRecord),
          actorScore: actorRecord.score,
          actorHistoryCount: actorRecord.eventCount,
          recentEvents: actorRecord.recentEvents,
          threatPrefix: getThreatPrefix(actorRecord)
        });
      }
    }
  }

  // 2. Uniswap V3 Monitoring
  const uniswapLogs = await provider.send('eth_getLogs', [{
    address: UNISWAP_V3_FACTORY,
    fromBlock: fromBlockHex,
    toBlock: toBlockHex,
    topics: [
      [
        uniswapInterface.getEvent('Swap')?.topicHash,
        uniswapInterface.getEvent('Mint')?.topicHash,
        uniswapInterface.getEvent('Burn')?.topicHash
      ]
    ]
  }]);

  const mintBurnsByBlock: Record<number, Record<string, { mint: boolean, burn: boolean, txHash: string }>> = {};

  for (const log of uniswapLogs) {
    const decoded = uniswapInterface.parseLog(log);
    if (!decoded) continue;

    const blockNumber = parseInt(log.blockNumber, 16);
    const baseAlert = {
      contractId: 'uni-v3-factory',
      contractName: 'Uniswap V3 Factory',
      contractAddress: UNISWAP_V3_FACTORY,
      chain: 'ethereum',
      protocol: 'uniswap',
      txHash: log.transactionHash,
      blockNumber,
      timestamp: now,
    };

    if (decoded.name === 'Swap') {
      const { sqrtPriceX96 } = decoded.args;
      const impact = await calculatePriceImpact(log.address, sqrtPriceX96, blockNumber, provider); // calculatePriceImpact is imported from utils
      if (impact > 0.03) {
        const tx = await getTransaction(log.transactionHash, provider);
        const actor = tx?.from || ZeroAddress;
        let actorPoints = 0;
        if (tx && !tx.to) actorPoints += 25;
        const actorRecord = await updateActor(actor, actorPoints, 'Uniswap High Impact Swap', env, log.transactionHash, blockNumber);

        alerts.push({
          ...baseAlert,
          id: `${log.transactionHash}-uni-swap`,
          severity: 'warning',
          title: 'Uniswap V3 High Impact Swap',
          description: formatActorDescription(`High price impact swap: ${(impact * 100).toFixed(2)}%`, actorRecord),
          actorScore: actorRecord.score,
          actorHistoryCount: actorRecord.eventCount,
          recentEvents: actorRecord.recentEvents,
          threatPrefix: getThreatPrefix(actorRecord)
        });
      }
    } else if (decoded.name === 'Mint' || decoded.name === 'Burn') {
      const owner = decoded.args.owner || decoded.args.sender;
      if (!mintBurnsByBlock[blockNumber]) mintBurnsByBlock[blockNumber] = {};
      if (!mintBurnsByBlock[blockNumber][owner]) mintBurnsByBlock[blockNumber][owner] = { mint: false, burn: false, txHash: log.transactionHash };
      
      if (decoded.name === 'Mint') mintBurnsByBlock[blockNumber][owner].mint = true;
      if (decoded.name === 'Burn') mintBurnsByBlock[blockNumber][owner].burn = true;

      if (mintBurnsByBlock[blockNumber][owner].mint && mintBurnsByBlock[blockNumber][owner].burn) {
        const tx = await getTransaction(log.transactionHash, provider);
        const actor = tx?.from || ZeroAddress; // Use from if owner is not available, but owner should be here
        let actorPoints = 0;
        if (tx && !tx.to) actorPoints += 25;
        const actorRecord = await updateActor(owner, actorPoints, 'Uniswap Mint & Burn Spike', env, log.transactionHash, blockNumber);

        alerts.push({
          ...baseAlert,
          id: `${log.transactionHash}-uni-mintburn`,
          severity: 'high',
          title: 'Uniswap V3 Mint & Burn Spike',
          description: formatActorDescription(`Mint and Burn in same block by ${owner}`, actorRecord),
          actorScore: actorRecord.score,
          actorHistoryCount: actorRecord.eventCount,
          recentEvents: actorRecord.recentEvents,
          threatPrefix: getThreatPrefix(actorRecord)
        });
      }
    }
  }

  // 3. Oracle Monitoring
  const correlativeAlerts = alerts.filter(a => 
    a.title.toLowerCase().includes('flashloan') || 
    a.title.toLowerCase().includes('liquidation') ||
    a.title.toLowerCase().includes('exploit pattern')
  );

  for (const asset of assetsToMonitor) {
    const oracleInfo = await checkOraclePrice(asset, env, provider); // checkOraclePrice defined in index.ts
    if (!oracleInfo) continue;

    const chainlinkInfo = await checkChainlinkDivergence(asset, oracleInfo.currentPrice, provider); // checkChainlinkDivergence defined in index.ts

    let severity = '';
    let type = '';

    if (oracleInfo.deviation > 10) {
      severity = 'critical';
      type = 'Oracle_Price_Spike';
    } else if (chainlinkInfo && chainlinkInfo.divergence > 7) {
      severity = 'critical';
      type = 'Oracle_Manipulation';
    } else if (oracleInfo.deviation > 5) {
      severity = 'high';
      type = 'Oracle_Price_Movement';
    } else if (chainlinkInfo && chainlinkInfo.divergence > 3) {
      severity = 'high';
      type = 'Oracle_Divergence';
    }

    if (severity) {
      let title = 'Aave Oracle Price Anomaly';
      let description = `Significant price anomaly detected for asset ${asset}. Deviation: ${oracleInfo.deviation.toFixed(2)}%, Chainlink Divergence: ${chainlinkInfo ? chainlinkInfo.divergence.toFixed(2) : 'N/A'}%`;

      if (severity === 'critical' && correlativeAlerts.length > 0) {
        title = 'ORACLE ATTACK IN PROGRESS';
        const details = correlativeAlerts.map(a => a.title).join(', ');
        description += ` | Triggered alongside: ${details}`;
      }

      alerts.push({
        id: `oracle-${asset}-${toBlock}`,
        contractId: 'aave-oracle',
        contractName: 'Aave Oracle',
        contractAddress: AAVE_ORACLE, // AAVE_ORACLE is imported from ./utils
        chain: 'ethereum',
        protocol: 'aave',
        severity,
        type,
        title,
        description,
        blockNumber: toBlock,
        timestamp: now,
        txHash: 'N/A'
      });
    }
  }

  // 4. Save to Supabase and Notify Telegram
  for (const alert of alerts) {
    await saveToSupabase(alert, env); // saveToSupabase defined in index.ts
    if (alert.severity === 'critical' || alert.severity === 'emergency' || alert.severity === 'high') {
      await sendTelegram(alert, env); // sendTelegram defined in index.ts
    }
  }

  // Update the last processed block in KV
  await env.DEFI_WATCH_KV.put('last_processed_block', toBlock.toString());
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await run(env);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    await run(env);
    return new Response('Worker executed');
  }
};
