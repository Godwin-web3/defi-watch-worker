import { Interface, JsonRpcProvider, Contract, ZeroAddress, formatUnits } from 'ethers';
import aaveAbi from '../abis/aave-v3.json' with { type: 'json' };
import { getUsdValue } from '../utils.js';
import { computeFlowDelta } from '../flowTracker.js';

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
    const tx = await getTransaction(log.transactionHash, provider);
    const actor = tx?.from || ZeroAddress;
    activityTracker.set(actor, (activityTracker.get(actor) || 0) + 1);

    let usdValue = 0;
    if (decoded.name === 'Borrow') {
      usdValue = await getUsdValue(decoded.args.reserve, decoded.args.amount, provider, blockNumber);
      activityTracker.set(decoded.args.user, (activityTracker.get(decoded.args.user) || 0) + 1);
    } else if (decoded.name === 'LiquidationCall') {
      activityTracker.set(decoded.args.user, (activityTracker.get(decoded.args.user) || 0) + 1);
      activityTracker.set(decoded.args.liquidator, (activityTracker.get(decoded.args.liquidator) || 0) + 1);
    } else if (decoded.name === 'FlashLoan') {
      activityTracker.set(decoded.args.initiator, (activityTracker.get(decoded.args.initiator) || 0) + 1);
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
          'function getUserAccountData(address user) view returns (uint256, uint256, uint256, uint256, uint256, uint256)'
        ], provider);
        const [currentData] = await Promise.all([pool.getUserAccountData(user, { blockTag: blockNumber })]);
        const healthFactor = currentData ? Number(formatUnits(currentData[5], 18)) : 0;
        const ltv = currentData ? Number(currentData[4]) : 0;
        const actorRecord = await updateActor(user, healthFactor < 1.5 ? 20 : 0, `Aave Borrow: ${usdValue.toFixed(2)} USD`, env, log.transactionHash, blockNumber);
        alerts.push({
          ...baseAlert, id: `${log.transactionHash}-aave-borrow`, severity: healthFactor < 1.5 ? 'critical' : 'high',
          title: 'Aave V3 Large Borrow', description: formatActorDescription(`Large borrow: ${usdValue.toFixed(2)} USD by ${user}`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord)
        });
      }
    } else if (decoded.name === 'LiquidationCall') {
      const { user } = decoded.args;
      const actorRecord = await updateActor(user, 0, 'Aave Liquidation', env, log.transactionHash, blockNumber);
      alerts.push({
        ...baseAlert, id: `${log.transactionHash}-aave-liq`, severity: 'high', title: 'Aave V3 Liquidation',
        description: formatActorDescription(`Liquidation detected for user ${user}`, actorRecord),
        actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord)
      });
    } else if (decoded.name === 'FlashLoan') {
      const { initiator, asset, amount, premium } = decoded.args;
      assetsToMonitor.add(asset);
      const isNewContract = await checkContractAge(initiator, currentBlock, provider);
      if (isNewContract) {
        const actorRecord = await updateActor(initiator, 35, 'Aave FlashLoan', env, log.transactionHash, blockNumber);
        const alert: any = {
          ...baseAlert, id: `${log.transactionHash}-aave-flash`, severity: 'critical', title: 'Aave V3 Suspicious FlashLoan',
          description: formatActorDescription(`FlashLoan by new contract (<7 days): ${initiator}`, actorRecord),
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord)
        };
        await handleFlashLoanAlert(alert, initiator, env, provider, asset, amount, premium);
        alerts.push(alert);
      }
    }
  }
}
