import { Interface, ZeroAddress } from 'ethers';
import makerAbi from '../abis/maker-psm.json' with { type: 'json' };

const MAKER_GOV = '0x0a390ced42a6320577002047805d21c97a553245';
const MAKER_PSM_USDC = '0x89B78CfA322F6C573a15239C73F6c1242e8b92ad';
const makerPsmInterface = new Interface(makerAbi);

export async function monitorMaker(env: any, provider: any, fromBlockHex: string, toBlockHex: string, now: number, alerts: any[], activityTracker: Map<string, number>, updateActor: any, getTransaction: any, getThreatPrefix: any, formatActorDescription: any) {
  const makerLogs = await provider.send('eth_getLogs', [{
    address: [MAKER_PSM_USDC],
    fromBlock: fromBlockHex,
    toBlock: toBlockHex,
    topics: [[
      makerPsmInterface.getEvent('SellGem')?.topicHash, makerPsmInterface.getEvent('BuyGem')?.topicHash,
      makerPsmInterface.getEvent('File')?.topicHash, makerPsmInterface.getEvent('Rely')?.topicHash,
      makerPsmInterface.getEvent('Deny')?.topicHash
    ]]
  }]);

  for (const log of makerLogs) {
    const decoded = makerPsmInterface.parseLog(log);
    if (!decoded) continue;
    const tx = await getTransaction(log.transactionHash, provider);
    const actor = tx?.from || ZeroAddress;
    activityTracker.set(actor, (activityTracker.get(actor) || 0) + 1);
    
    const baseAlert = {
      contractId: 'maker-psm', contractName: 'Maker PSM USDC', contractAddress: MAKER_PSM_USDC,
      chain: 'ethereum', protocol: 'maker', txHash: log.transactionHash, blockNumber: parseInt(log.blockNumber, 16), timestamp: now,
    };

    if (decoded.name === 'Rely' || decoded.name === 'Deny') {
      if (tx?.from?.toLowerCase() !== MAKER_GOV.toLowerCase()) {
        const actorRecord = await updateActor(actor, 100, `Maker Access Control: ${decoded.name}`, env, log.transactionHash, baseAlert.blockNumber);
        alerts.push({ ...baseAlert, id: `${log.transactionHash}-maker-acl`, severity: 'critical', title: 'Maker PSM Access Control Change', description: formatActorDescription(`Authorization change detected: ${decoded.name} for user ${decoded.args.usr}`, actorRecord), actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord) });
      }
    } else if (decoded.name === 'SellGem' || decoded.name === 'BuyGem') {
      if (decoded.args.value > 5000000n * 10n**6n) {
        const actorRecord = await updateActor(actor, 15, `Maker PSM ${decoded.name}`, env, log.transactionHash, baseAlert.blockNumber);
        alerts.push({ ...baseAlert, id: `${log.transactionHash}-maker-swap`, severity: 'high', title: `Maker PSM Large ${decoded.name === 'SellGem' ? 'Inflow' : 'Outflow'}`, description: formatActorDescription(`Large movement in Maker PSM: ${(Number(decoded.args.value) / 1e6).toFixed(2)} USDC`, actorRecord), actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord) });
      }
    }
  }
}
