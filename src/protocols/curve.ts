import { Interface, ZeroAddress, Contract } from 'ethers';
import curveAbi from '../abis/curve-stableswap.json' with { type: 'json' };

const CURVE_3POOL = '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7';
const CURVE_STETH_POOL = '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022';
const GAUGE_CONTROLLER = '0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB';
const curveInterface = new Interface(curveAbi);

export async function monitorCurve(env: any, provider: any, fromBlockHex: string, toBlockHex: string, now: number, alerts: any[], activityTracker: Map<string, number>, updateActor: any, getTransaction: any, getThreatPrefix: any, formatActorDescription: any) {
  const curveLogs = await provider.send('eth_getLogs', [{
    address: [CURVE_3POOL, CURVE_STETH_POOL, GAUGE_CONTROLLER],
    fromBlock: fromBlockHex,
    toBlock: toBlockHex,
    topics: [[
      curveInterface.getEvent('TokenExchange')?.topicHash, curveInterface.getEvent('RampA')?.topicHash,
      curveInterface.getEvent('StopRampA')?.topicHash, curveInterface.getEvent('RemoveLiquidityImbalance')?.topicHash,
      curveInterface.getEvent('KillGauge')?.topicHash, curveInterface.getEvent('Pause')?.topicHash, curveInterface.getEvent('Unpause')?.topicHash
    ]]
  }]);

  for (const log of curveLogs) {
    const decoded = curveInterface.parseLog(log);
    if (!decoded) continue;
    const blockNumber = parseInt(log.blockNumber, 16);
    const tx = await getTransaction(log.transactionHash, provider);
    const actor = tx?.from || ZeroAddress;
    
    const baseAlert = {
      contractId: 'curve-pool', contractName: log.address.toLowerCase() === CURVE_3POOL.toLowerCase() ? 'Curve 3Pool' : 'Curve stETH Pool',
      contractAddress: log.address, chain: 'ethereum', protocol: 'curve', txHash: log.transactionHash, blockNumber, timestamp: now,
    };

    if (decoded.name === 'TokenExchange') {
      const { sold_id, tokens_sold, bought_id, tokens_bought } = decoded.args;
      
      // Dynamic decimal check for Curve 3Pool (DAI, USDC, USDT)
      let decimals = 18n;
      if (log.address.toLowerCase() === CURVE_3POOL.toLowerCase()) {
         if (sold_id === 1n || sold_id === 2n) decimals = 6n; // USDC or USDT
      }

      if (tokens_sold > 500000n * 10n**decimals) {
        const actorRecord = await updateActor(actor, 10, 'Curve Large Swap', env, log.transactionHash, blockNumber);
        alerts.push({ 
          ...baseAlert, 
          id: `${log.transactionHash}-curve-swap`, 
          severity: 'warning', 
          type: 'CURVE_LARGE_SWAP',
          title: 'Curve Large Swap', 
          description: formatActorDescription(`Large swap detected in Curve pool: ${(Number(tokens_sold) / Number(10n**decimals)).toFixed(2)} tokens sold`, actorRecord), 
          actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord) 
        });
      }
    } else if (['KillGauge', 'Pause', 'Unpause'].includes(decoded.name)) {
      const actorRecord = await updateActor(actor, 80, `Curve Admin Action: ${decoded.name}`, env, log.transactionHash, blockNumber);
      alerts.push({ 
        ...baseAlert, 
        id: `${log.transactionHash}-curve-admin`, 
        severity: 'high', 
        type: 'CURVE_ADMIN_ACTION',
        title: `Curve Admin Action: ${decoded.name}`, 
        description: formatActorDescription(`Critical admin action triggered: ${decoded.name}`, actorRecord), 
        actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord) 
      });
    }
  }
}
