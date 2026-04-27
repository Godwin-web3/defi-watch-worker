import { Interface, JsonRpcProvider, ZeroAddress, Contract, formatUnits } from 'ethers';
import { monitorAave } from './protocols/aave.js';
import { monitorUniswap } from './protocols/uniswap.js';
import { monitorCurve } from './protocols/curve.js';
import { monitorMaker } from './protocols/maker.js';
import { monitorLido } from './protocols/lido.js';
import { monitorOracle } from './protocols/oracle.js';
import * as dotenv from 'dotenv';

// Import utility functions from utils.ts
import { getTransaction, getActorRecord, updateActor, getThreatPrefix, formatActorDescription, calculatePriceImpact, getUsdValue, AAVE_ORACLE, getKV, putKV, supabase } from './utils.js';
import { computeFlowDelta } from './flowTracker.js';
// Import types from types.ts
import { ActorRecord } from './types.js';

dotenv.config();

const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

import aaveAbi from './abis/aave-v3.json' with { type: 'json' };
import uniswapAbi from './abis/uniswap-v3.json' with { type: 'json' };
const aaveInterface = new Interface(aaveAbi);
const uniswapInterface = new Interface(uniswapAbi);

async function checkContractAge(address: string, currentBlock: number, provider: JsonRpcProvider): Promise<boolean> {
  try {
    const historicalBlock = currentBlock - 50400;
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
        
        const record = await getActorRecord(actor);
        record.confirmedExtractions = (record.confirmedExtractions || 0) + 1;
        record.totalExtractedUsd = (record.totalExtractedUsd || 0) + flowResult.atomicExecutionSurplus;
        
        await supabase
          .from('actor_memory')
          .upsert({
            address: actor.toLowerCase(),
            score: record.score,
            event_count: record.eventCount,
            confirmed_extractions: record.confirmedExtractions,
            total_extracted_usd: record.totalExtractedUsd,
            last_seen: record.lastSeen,
            recent_events: record.recentEvents
          });

        await putKV(`flow:${alert.txHash}`, JSON.stringify(flowResult));
      } else if (flowResult.classificationTag === 'SUSPECTED_ATTEMPT') {
        await updateActor(actor, 0, 'Suspected extraction attempt', {}, alert.txHash, alert.blockNumber);
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

    await putKV(kvKey, JSON.stringify({
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
    const oracle = new Contract(AAVE_ORACLE, ['function getSourceOfAsset(address) view returns (address)'], provider);
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

async function saveToSupabase(alert: any) {
  const { error } = await supabase.from('alerts').insert(alert);
  if (error) {
    console.error('Failed to save to Supabase:', error);
  }
}

async function sendTelegram(alert: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  
  if ((alert.actorScore || 0) <= 30) {
    console.log(`Log only (Score ${alert.actorScore}): ${alert.title} - ${alert.description}`);
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const threatPrefix = alert.threatPrefix || "";
  
  const actorScoreLine = `Actor Score: ${alert.actorScore} | History: ${alert.actorHistoryCount}`;
  let historySection = "";
  if ((alert.actorScore || 0) > 60 && alert.recentEvents && alert.recentEvents.length > 1) {
    const history = alert.recentEvents.slice(1, 6);
    const df = new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC'
    });
    
    historySection = `\n` + history.map((ev: any) => {
      const dateStr = df.format(new Date(ev.timestamp)).replace(',', '') + " UTC";
      return `• ${ev.description} (${dateStr} | Block: ${ev.blockNumber}) [TX](https://etherscan.io/tx/${ev.txHash})`;
    }).join(`\n`);
  }

  const currentEventDetails = alert.description.split(" | Actor Score:")[0];

  let header = `🚨 *${threatPrefix}${alert.title.toUpperCase()} ALERT* 🚨`;
  if (alert.firstTimeActor) {
    header = `🔴 FIRST-TIME ACTOR + FLASH LOAN: No prior history.\n${header}`;
  }
  if (alert.classificationTag === 'CONFIRMED_EXTRACTION') {
    header = `💰 CONFIRMED EXTRACTION: $${alert.usdSurplus?.toFixed(2)} pre-gas surplus\n${header}`;
  }

  let footer = "";
  if (alert.classificationTag === 'SUSPECTED_ATTEMPT') {
    footer += `\n\n⚠️ Suspected extraction attempt.`;
  }
  if (alert.cascadeRisk) {
    footer += `\n\n⚠️ CASCADE RISK: Active liquidations in same block.`;
  }

  const text = `${header}\n\nSeverity: ${alert.severity}\n${actorScoreLine}${historySection}\nDetails: ${currentEventDetails}\nBlock: ${alert.blockNumber}\nTX: [View on Etherscan](https://etherscan.io/tx/${alert.txHash})${footer}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
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

async function run() {
  const provider = new JsonRpcProvider(process.env.RPC_URL || 'https://ethereum.publicnode.com');
  const currentBlock = await provider.getBlockNumber();
  
  let fromBlock: number;
  const lastBlockStr = await getKV('last_processed_block');
  
  if (lastBlockStr) {
    fromBlock = parseInt(lastBlockStr) + 1;
  } else {
    fromBlock = currentBlock - 10;
  }

  if (fromBlock > currentBlock) {
    console.log(`Already processed up to block ${currentBlock}`);
    return;
  }

  if (currentBlock - fromBlock > 1000) {
    console.warn(`Large gap detected: ${currentBlock - fromBlock} blocks. Capping at 1000.`);
    fromBlock = currentBlock - 1000;
  }

  const toBlock = currentBlock - 2;
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
    topics: [[
      aaveInterface.getEvent('Borrow')?.topicHash,
      aaveInterface.getEvent('LiquidationCall')?.topicHash,
      aaveInterface.getEvent('FlashLoan')?.topicHash
    ]]
  }]);

  const decodedAaveLogs: any[] = [];
  for (const log of aaveLogs) {
    const decoded = aaveInterface.parseLog(log);
    if (!decoded) continue;

    const blockNumber = parseInt(log.blockNumber, 16);
    let usdValue = 0;
    if (decoded.name === 'Borrow') {
      usdValue = await getUsdValue(decoded.args.reserve, decoded.args.amount, provider, blockNumber);
    }

    decodedAaveLogs.push({ log, decoded, usdValue, blockNumber, transactionHash: log.transactionHash });

    const baseAlert = {
      contractId: 'aave-v3', contractName: 'Aave V3 Pool', contractAddress: AAVE_V3_POOL,
      chain: 'ethereum', protocol: 'aave', txHash: log.transactionHash, blockNumber: blockNumber, timestamp: now,
    };

    if (decoded.name === 'Borrow') {
      const { reserve, amount, user } = decoded.args;
      assetsToMonitor.add(reserve);
      if (usdValue > 250000) {
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

        const actorRecord = await updateActor(user, actorPoints, `Aave Borrow: ${usdValue.toFixed(2)} USD`, {}, log.transactionHash, blockNumber);

        const blockLiquidations = decodedAaveLogs.filter(l => l.blockNumber === blockNumber && l.decoded.name === 'LiquidationCall');
        const cascadeRisk = healthFactor < 1.05 && blockLiquidations.length >= 2;

        alerts.push({
          ...baseAlert, id: `${log.transactionHash}-aave-borrow`, severity: 'high', title: 'Aave V3 Large Borrow',
          description: formatActorDescription(`Large borrow: ${usdValue.toFixed(2)} USD by ${user} | Health Factor: ${healthFactor.toFixed(2)} | LTV: ${(ltv / 100).toFixed(0)}% | First time borrower: ${isFirstTime ? 'yes' : 'no'}`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord), cascadeRisk
        });
      }
    } else if (decoded.name === 'LiquidationCall') {
      const { user } = decoded.args;
      const tx = await getTransaction(log.transactionHash, provider);
      let actorPoints = 0;
      if (tx && !tx.to) actorPoints += 25;
      
      const actorRecord = await updateActor(user, actorPoints, 'Aave Liquidation', {}, log.transactionHash, blockNumber);

      alerts.push({
        ...baseAlert, id: `${log.transactionHash}-aave-liq`, severity: 'high', title: 'Aave V3 Liquidation',
        description: formatActorDescription(`Liquidation detected for user ${user}`, actorRecord),
        actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord)
      });
    } else if (decoded.name === 'FlashLoan') {
      const { initiator, asset, amount, premium } = decoded.args;
      assetsToMonitor.add(asset);
      const isNewContract = await checkContractAge(initiator, currentBlock, provider);
      
      let actorPoints = 15;
      if (isNewContract) actorPoints += 20;
      const tx = await getTransaction(log.transactionHash, provider);
      if (tx && !tx.to) actorPoints += 25;

      const actorRecord = await updateActor(initiator, actorPoints, 'Aave FlashLoan', {}, log.transactionHash, blockNumber);

      if (isNewContract) {
        const alert: any = {
          ...baseAlert, id: `${log.transactionHash}-aave-flash`, severity: 'critical', title: 'Aave V3 Suspicious FlashLoan',
          description: formatActorDescription(`FlashLoan by new contract (<7 days): ${initiator}`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord),
          flashLoanAmount: amount, flashLoanPremium: premium, firstTimeActor: actorRecord.eventCount === 1
        };
        await handleFlashLoanAlert(alert, initiator, provider, asset, amount, premium);
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
      contractId: 'aave-v3', contractName: 'Aave V3 Pool', contractAddress: AAVE_V3_POOL,
      chain: 'ethereum', protocol: 'aave', txHash: txHash, blockNumber: txLogs[0].blockNumber, timestamp: now,
    };

    const tx = await getTransaction(txHash, provider);
    const actor = tx?.from || ZeroAddress;
    let actorPoints = 0;
    if (hasFlashLoan && hasBorrow) actorPoints += 25;
    if (tx && !tx.to) actorPoints += 25;

    if (hasFlashLoan && hasBorrow && hasLiquidation) {
      const actorRecord = await updateActor(actor, actorPoints, 'Aave Exploit Pattern (Flash+Borrow+Liq)', {}, txHash, txLogs[0].blockNumber);
      const alert: any = {
        ...baseAlert, id: `${txHash}-aave-exploit-pattern`, severity: 'critical', title: 'Aave V3 Exploit Pattern',
        description: formatActorDescription(`FlashLoan, Borrow, and Liquidation detected in same transaction: ${txHash}`, actorRecord),
        actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord), firstTimeActor: actorRecord.eventCount === 1
      };
      const fl = txLogs.find(l => l.decoded.name === 'FlashLoan')?.decoded;
      await handleFlashLoanAlert(alert, actor, provider, fl?.args.asset, fl?.args.amount, fl?.args.premium);
      alerts.push(alert);
    } else if (hasFlashLoan && hasBorrow) {
      const actorRecord = await updateActor(actor, actorPoints, 'Aave FlashLoan + Borrow', {}, txHash, txLogs[0].blockNumber);
      const alert: any = {
        ...baseAlert, id: `${txHash}-aave-flash-borrow`, severity: 'high', title: 'Aave V3 FlashLoan + Borrow',
        description: formatActorDescription(`FlashLoan and Borrow detected in same transaction: ${txHash}`, actorRecord),
        actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord), firstTimeActor: actorRecord.eventCount === 1
      };
      const fl = txLogs.find(l => l.decoded.name === 'FlashLoan')?.decoded;
      await handleFlashLoanAlert(alert, actor, provider, fl?.args.asset, fl?.args.amount, fl?.args.premium);
      alerts.push(alert);
    } else if (hasFlashLoan && hasLiquidation) {
      const actorRecord = await updateActor(actor, actorPoints, 'Aave FlashLoan + Liquidation', {}, txHash, txLogs[0].blockNumber);
      const alert: any = {
        ...baseAlert, id: `${txHash}-aave-flash-liq`, severity: 'critical', title: 'Aave V3 FlashLoan + Liquidation',
        description: formatActorDescription(`FlashLoan and Liquidation detected in same transaction: ${txHash}`, actorRecord),
        actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord), firstTimeActor: actorRecord.eventCount === 1
      };
      const fl = txLogs.find(l => l.decoded.name === 'FlashLoan')?.decoded;
      await handleFlashLoanAlert(alert, actor, provider, fl?.args.asset, fl?.args.amount, fl?.args.premium);
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
      contractId: 'aave-v3', contractName: 'Aave V3 Pool', contractAddress: AAVE_V3_POOL,
      chain: 'ethereum', protocol: 'aave', blockNumber: blockNumber, timestamp: now,
    };

    if (liquidations.length >= 3 || (hasLargeBorrow && liquidations.length > 0)) {
      const triggerLog = borrows.find(b => b.usdValue > 100000) || liquidations[0];
      const tx = await getTransaction(triggerLog.transactionHash, provider);
      const actor = tx?.from || ZeroAddress;
      let actorPoints = 0;
      if (tx && !tx.to) actorPoints += 25;

      if (liquidations.length >= 3) {
        const actorRecord = await updateActor(actor, actorPoints, 'Aave Liquidation Cascade', {}, liquidations[0].transactionHash, blockNumber);
        alerts.push({
          ...baseAlert, id: `${blockNumber}-aave-liq-cascade`, txHash: liquidations[0].transactionHash, severity: 'critical', title: 'Aave V3 Liquidation Cascade',
          description: formatActorDescription(`${liquidations.length} liquidations detected in block ${blockNumber}`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord)
        });
      }

      if (hasLargeBorrow && liquidations.length > 0) {
        const actorRecord = await updateActor(actor, actorPoints, 'Aave Borrow + Liquidation Block', {}, triggerLog.transactionHash, blockNumber);
        alerts.push({
          ...baseAlert, id: `${blockNumber}-aave-borrow-liq-block`, txHash: triggerLog.transactionHash, severity: 'critical', title: 'Aave V3 Borrow + Liquidation Block',
          description: formatActorDescription(`Large borrow (>$100k) and liquidation detected in same block ${blockNumber}`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord)
        });
      }
    }
  }

  // 2. Uniswap V3 Monitoring
  const uniswapLogs = await provider.send('eth_getLogs', [{
    address: UNISWAP_V3_FACTORY,
    fromBlock: fromBlockHex,
    toBlock: toBlockHex,
    topics: [[
      uniswapInterface.getEvent('Swap')?.topicHash,
      uniswapInterface.getEvent('Mint')?.topicHash,
      uniswapInterface.getEvent('Burn')?.topicHash
    ]]
  }]);

  const mintBurnsByBlock: Record<number, Record<string, { mint: boolean, burn: boolean, txHash: string }>> = {};

  for (const log of uniswapLogs) {
    const decoded = uniswapInterface.parseLog(log);
    if (!decoded) continue;

    const blockNumber = parseInt(log.blockNumber, 16);
    const baseAlert = {
      contractId: 'uni-v3-factory', contractName: 'Uniswap V3 Factory', contractAddress: UNISWAP_V3_FACTORY,
      chain: 'ethereum', protocol: 'uniswap', txHash: log.transactionHash, blockNumber, timestamp: now,
    };

    if (decoded.name === 'Swap') {
      const { sqrtPriceX96 } = decoded.args;
      const impact = await calculatePriceImpact(log.address, sqrtPriceX96, blockNumber, provider);
      if (impact > 0.03) {
        const tx = await getTransaction(log.transactionHash, provider);
        const actor = tx?.from || ZeroAddress;
        let actorPoints = 0;
        if (tx && !tx.to) actorPoints += 25;
        const actorRecord = await updateActor(actor, actorPoints, 'Uniswap High Impact Swap', {}, log.transactionHash, blockNumber);

        alerts.push({
          ...baseAlert, id: `${log.transactionHash}-uni-swap`, severity: 'warning', title: 'Uniswap V3 High Impact Swap',
          description: formatActorDescription(`High price impact swap: ${(impact * 100).toFixed(2)}%`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord)
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
        const actor = tx?.from || ZeroAddress;
        let actorPoints = 0;
        if (tx && !tx.to) actorPoints += 25;
        const actorRecord = await updateActor(owner, actorPoints, 'Uniswap Mint & Burn Spike', {}, log.transactionHash, blockNumber);

        alerts.push({
          ...baseAlert, id: `${log.transactionHash}-uni-mintburn`, severity: 'high', title: 'Uniswap V3 Mint & Burn Spike',
          description: formatActorDescription(`Mint and Burn in same block by ${owner}`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord)
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
    const oracleInfo = await checkOraclePrice(asset, provider);
    if (!oracleInfo) continue;

    const chainlinkInfo = oracleInfo.deviation > 3 ? await checkChainlinkDivergence(asset, oracleInfo.currentPrice, provider) : null;

    let severity = '';
    let type = '';

    if (oracleInfo.deviation > 10) {
      severity = 'critical'; type = 'Oracle_Price_Spike';
    } else if (chainlinkInfo && chainlinkInfo.divergence > 7) {
      severity = 'critical'; type = 'Oracle_Manipulation';
    } else if (oracleInfo.deviation > 5) {
      severity = 'high'; type = 'Oracle_Price_Movement';
    } else if (chainlinkInfo && chainlinkInfo.divergence > 3) {
      severity = 'high'; type = 'Oracle_Divergence';
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
        id: `oracle-${asset}-${toBlock}`, contractId: 'aave-oracle', contractName: 'Aave Oracle', contractAddress: AAVE_ORACLE,
        chain: 'ethereum', protocol: 'aave', severity, type, title, description, blockNumber: toBlock, timestamp: now, txHash: 'N/A'
      });
    }
  }

  // 4. Save to Supabase and Notify Telegram
  await saveToSupabase(alerts);
  for (const alert of alerts) {
    if (alert.severity === 'critical' || alert.severity === 'emergency' || alert.severity === 'high') {
      await sendTelegram(alert);
    }
  }

  await putKV('last_processed_block', toBlock.toString());
}

// Node.js setInterval execution
console.log('Starting DeFi Watch Worker (Node.js)...');
run().catch(console.error);
setInterval(() => {
  run().catch(console.error);
}, 60000);
