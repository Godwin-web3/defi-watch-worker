import { Interface, JsonRpcProvider, Contract, ZeroAddress, formatUnits } from 'ethers';
import aaveAbi from '../abis/aave-v3.json' with { type: 'json' };
import { getUsdValue } from '../utils.js';

const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const aaveInterface = new Interface(aaveAbi);

export async function monitorAave(env: any, provider: JsonRpcProvider, fromBlockHex: string, toBlockHex: string, now: number, alerts: any[], activityTracker: Map<string, number>, updateActor: any, getTransaction: any, getThreatPrefix: any, formatActorDescription: any, checkContractAge: any, handleFlashLoanAlert: any, currentBlock: number, assetsToMonitor: Set<string>) {
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
      usdValue = await getUsdValue(decoded.args.reserve, decoded.args.amount, provider, blockNumber);
    }

    decodedAaveLogs.push({ log, decoded, usdValue, blockNumber, transactionHash: log.transactionHash });

    const baseAlert = {
      contractId: 'aave-v3', contractName: 'Aave V3 Pool', contractAddress: AAVE_V3_POOL,
      chain: 'ethereum', protocol: 'aave', txHash: log.transactionHash, blockNumber, timestamp: now,
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

        let actorPoints = 10;
        if (isFirstTime) actorPoints += 15;
        if (healthFactor < 1.5) actorPoints += 20;
        if (ltv > 80) actorPoints += 15;
        
        const tx = await getTransaction(log.transactionHash, provider);
        if (tx && !tx.to) actorPoints += 25;

        const actorRecord = await updateActor(user, actorPoints, `Aave Borrow: ${usdValue.toFixed(2)} USD`, env, log.transactionHash, blockNumber);

        alerts.push({
          ...baseAlert, id: `${log.transactionHash}-aave-borrow`, severity: 'high', title: 'Aave V3 Large Borrow',
          type: 'AAVE_LARGE_BORROW',
          description: formatActorDescription(`Large borrow: ${usdValue.toFixed(2)} USD by ${user} | Health Factor: ${healthFactor.toFixed(2)} | LTV: ${(ltv / 100).toFixed(0)}% | First time borrower: ${isFirstTime ? 'yes' : 'no'}`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord),
          evidence: { healthFactor, ltv, isFirstTime, usdValue }
        });      }
    } else if (decoded.name === 'LiquidationCall') {
      const { user } = decoded.args;
      const tx = await getTransaction(log.transactionHash, provider);
      let actorPoints = 10;
      if (tx && !tx.to) actorPoints += 25;
      
      const actorRecord = await updateActor(user, actorPoints, 'Aave Liquidation', env, log.transactionHash, blockNumber);

      alerts.push({
        ...baseAlert, id: `${log.transactionHash}-aave-liq`, severity: 'high', title: 'Aave V3 Liquidation',
        type: 'AAVE_LIQUIDATION',
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

      const actorRecord = await updateActor(initiator, actorPoints, 'Aave FlashLoan', env, log.transactionHash, blockNumber);

      if (isNewContract) {
        const alert: any = {
          ...baseAlert, id: `${log.transactionHash}-aave-flash`, severity: 'critical', title: 'Aave V3 Suspicious FlashLoan',
          type: 'AAVE_SUSPICIOUS_FLASHLOAN',
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
      const actorRecord = await updateActor(actor, actorPoints, 'Aave Exploit Pattern (Flash+Borrow+Liq)', env, txHash, txLogs[0].blockNumber);
      const alert: any = {
        ...baseAlert, id: `${txHash}-aave-exploit-pattern`, severity: 'critical', title: 'Aave V3 Exploit Pattern',
        type: 'AAVE_EXPLOIT_PATTERN',
        description: formatActorDescription(`FlashLoan, Borrow, and Liquidation detected in same transaction: ${txHash}`, actorRecord),
        actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord), firstTimeActor: actorRecord.eventCount === 1
      };
      const fl = txLogs.find(l => l.decoded.name === 'FlashLoan')?.decoded;
      await handleFlashLoanAlert(alert, actor, provider, fl?.args.asset, fl?.args.amount, fl?.args.premium);
      alerts.push(alert);
    } else if (hasFlashLoan && hasBorrow) {
      const actorRecord = await updateActor(actor, actorPoints, 'Aave FlashLoan + Borrow', env, txHash, txLogs[0].blockNumber);
      const alert: any = {
        ...baseAlert, id: `${txHash}-aave-flash-borrow`, severity: 'high', title: 'Aave V3 FlashLoan + Borrow',
        type: 'AAVE_FLASH_BORROW',
        description: formatActorDescription(`FlashLoan and Borrow detected in same transaction: ${txHash}`, actorRecord),
        actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord), firstTimeActor: actorRecord.eventCount === 1
      };
      const fl = txLogs.find(l => l.decoded.name === 'FlashLoan')?.decoded;
      await handleFlashLoanAlert(alert, actor, provider, fl?.args.asset, fl?.args.amount, fl?.args.premium);
      alerts.push(alert);
    } else if (hasFlashLoan && hasLiquidation) {
      const actorRecord = await updateActor(actor, actorPoints, 'Aave FlashLoan + Liquidation', env, txHash, txLogs[0].blockNumber);
      const alert: any = {
        ...baseAlert, id: `${txHash}-aave-flash-liq`, severity: 'critical', title: 'Aave V3 FlashLoan + Liquidation',
        type: 'AAVE_FLASH_LIQUIDATION',
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
        const actorRecord = await updateActor(actor, actorPoints, 'Aave Liquidation Cascade', env, liquidations[0].transactionHash, blockNumber);
        alerts.push({
          ...baseAlert, id: `${blockNumber}-aave-liq-cascade`, txHash: liquidations[0].transactionHash, severity: 'critical', title: 'Aave V3 Liquidation Cascade',
          type: 'AAVE_LIQUIDATION_CASCADE',
          description: formatActorDescription(`${liquidations.length} liquidations detected in block ${blockNumber}`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord)
        });
      }

      if (hasLargeBorrow && liquidations.length > 0) {
        const actorRecord = await updateActor(actor, actorPoints, 'Aave Borrow + Liquidation Block', env, triggerLog.transactionHash, blockNumber);
        alerts.push({
          ...baseAlert, id: `${blockNumber}-aave-borrow-liq-block`, txHash: triggerLog.transactionHash, severity: 'critical', title: 'Aave V3 Borrow + Liquidation Block',
          type: 'AAVE_BORROW_LIQ_BLOCK',
          description: formatActorDescription(`Large borrow (>$100k) and liquidation detected in same block ${blockNumber}`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord)
        });
      }
    }
  }
}
