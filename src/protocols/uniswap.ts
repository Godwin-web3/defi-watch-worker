import { Interface, ZeroAddress } from 'ethers';
import uniAbi from '../abis/uniswap-v3.json';

const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const uniswapInterface = new Interface(uniAbi);

export async function monitorUniswap(env: any, provider: any, fromBlockHex: string, toBlockHex: string, now: number, alerts: any[], activityTracker: Map<string, number>, updateActor: any, getTransaction: any, getThreatPrefix: any, formatActorDescription: any, calculatePriceImpact: any) {
  const uniswapLogs = await provider.send('eth_getLogs', [{
    address: UNISWAP_V3_FACTORY,
    fromBlock: fromBlockHex,
    toBlock: toBlockHex,
    topics: [[
      uniswapInterface.getEvent('Swap')?.topicHash, uniswapInterface.getEvent('Mint')?.topicHash,
      uniswapInterface.getEvent('Burn')?.topicHash
    ]]
  }]);

  const mintBurnsByBlock: Record<number, Record<string, { mint: boolean, burn: boolean }>> = {};

  for (const log of uniswapLogs) {
    const decoded = uniswapInterface.parseLog(log);
    if (!decoded) continue;
    const blockNumber = parseInt(log.blockNumber, 16);
    const tx = await getTransaction(log.transactionHash, provider);
    const actor = tx?.from || ZeroAddress;
    activityTracker.set(actor, (activityTracker.get(actor) || 0) + 1);

    const baseAlert = {
      contractId: 'uni-v3-factory', contractName: 'Uniswap V3 Factory', contractAddress: UNISWAP_V3_FACTORY,
      chain: 'ethereum', protocol: 'uniswap', txHash: log.transactionHash, blockNumber, timestamp: now,
    };

    if (decoded.name === 'Swap') {
      const impact = await calculatePriceImpact(log.address, decoded.args.sqrtPriceX96, blockNumber, provider);
      if (impact > 0.03) {
        const actorRecord = await updateActor(actor, 0, 'Uniswap High Impact Swap', env, log.transactionHash, blockNumber);
        alerts.push({ ...baseAlert, id: `${log.transactionHash}-uni-swap`, severity: 'warning', title: 'Uniswap V3 High Impact Swap', description: formatActorDescription(`High price impact swap: ${(impact * 100).toFixed(2)}%`, actorRecord), actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord) });
      }
    } else if (decoded.name === 'Mint' || decoded.name === 'Burn') {
      const owner = decoded.args.owner || decoded.args.sender;
      if (!mintBurnsByBlock[blockNumber]) mintBurnsByBlock[blockNumber] = {};
      if (!mintBurnsByBlock[blockNumber][owner]) mintBurnsByBlock[blockNumber][owner] = { mint: false, burn: false };
      if (decoded.name === 'Mint') mintBurnsByBlock[blockNumber][owner].mint = true;
      if (decoded.name === 'Burn') mintBurnsByBlock[blockNumber][owner].burn = true;
      if (mintBurnsByBlock[blockNumber][owner].mint && mintBurnsByBlock[blockNumber][owner].burn) {
        const actorRecord = await updateActor(owner, 0, 'Uniswap Mint & Burn Spike', env, log.transactionHash, blockNumber);
        alerts.push({ ...baseAlert, id: `${log.transactionHash}-uni-mintburn`, severity: 'high', title: 'Uniswap V3 Mint & Burn Spike', description: formatActorDescription(`Mint and Burn in same block by ${owner}`, actorRecord), actorScore: actorRecord.score, actorHistoryCount: actorRecord.eventCount, recentEvents: actorRecord.recentEvents, threatPrefix: getThreatPrefix(actorRecord) });
      }
    }
  }
}
