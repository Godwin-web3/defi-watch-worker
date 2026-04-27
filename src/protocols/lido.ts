import { Interface, ZeroAddress } from 'ethers';
import lidoAbi from '../abis/lido.json' with { type: 'json' };

const LIDO_STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
const LIDO_WITHDRAWAL_QUEUE = '0x889edC2BDE944250596279FE1127e13d8212Ad1b';
const lidoInterface = new Interface(lidoAbi);

export async function monitorLido(env: any, provider: any, fromBlockHex: string, toBlockHex: string, now: number, alerts: any[], activityTracker: Map<string, number>, updateActor: any, getTransaction: any, getThreatPrefix: any, formatActorDescription: any) {
  const lidoLogs = await provider.send('eth_getLogs', [{
    address: [LIDO_STETH, LIDO_WITHDRAWAL_QUEUE],
    fromBlock: fromBlockHex,
    toBlock: toBlockHex,
    topics: [[
      lidoInterface.getEvent('PostTotalSharesUpdated')?.topicHash, lidoInterface.getEvent('WithdrawalRequested')?.topicHash,
      lidoInterface.getEvent('StakingPaused')?.topicHash, lidoInterface.getEvent('SetMaxShareRate')?.topicHash
    ]]
  }]);

  for (const log of lidoLogs) {
    const decoded = lidoInterface.parseLog(log);
    if (!decoded) continue;
    const blockNumber = parseInt(log.blockNumber, 16);
    const tx = await getTransaction(log.transactionHash, provider);
    const actor = tx?.from || ZeroAddress;
    
    const baseAlert = {
      contractId: 'lido', contractName: log.address.toLowerCase() === LIDO_STETH.toLowerCase() ? 'Lido stETH' : 'Lido Withdrawal Queue',
      contractAddress: log.address, chain: 'ethereum', protocol: 'lido', txHash: log.transactionHash, blockNumber, timestamp: now,
    };

    if (['StakingPaused', 'SetMaxShareRate'].includes(decoded.name)) {
      const actorRecord = await updateActor(actor, 80, `Lido Admin Action: ${decoded.name}`, env, log.transactionHash, blockNumber);
      alerts.push({ 
        ...baseAlert, 
        id: `${log.transactionHash}-lido-admin`, 
        severity: 'high', 
        type: 'LIDO_ADMIN_ACTION',
        title: `Lido Admin Action: ${decoded.name}`, 
        description: formatActorDescription(`Lido governance event triggered: ${decoded.name}`, actorRecord), 
        actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord) 
      });
    } else if (decoded.name === 'WithdrawalRequested') {
      if (decoded.args.amountStETH > 1000n * 10n**18n) {
        const actorRecord = await updateActor(actor, 20, 'Lido Large Withdrawal', env, log.transactionHash, blockNumber);
        alerts.push({ 
          ...baseAlert, 
          id: `${log.transactionHash}-lido-withdrawal`, 
          severity: 'high', 
          type: 'LIDO_LARGE_WITHDRAWAL',
          title: 'Lido Large Withdrawal Request', 
          description: formatActorDescription(`Large withdrawal request: ${(Number(decoded.args.amountStETH) / 1e18).toFixed(2)} stETH`, actorRecord), 
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord) 
        });
      }
    }
  }
}
