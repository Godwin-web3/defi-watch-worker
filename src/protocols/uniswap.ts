import { Interface, ZeroAddress } from 'ethers';
import uniAbi from '../abis/uniswap-v3.json' with { type: 'json' };

const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const POOL_CREATED_TOPIC = '0x783cca692c694383c27e8a93911c1e57c669177a6411516f4d857d4722513f56';
const uniswapInterface = new Interface(uniAbi);

// Top 5 Uniswap V3 Pools (ETH-USDC 0.05%, ETH-USDC 0.3%, WBTC-ETH 0.05%, WBTC-ETH 0.3%, USDC-USDT 0.01%)
const TOP_POOLS = [
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
  '0xadcfc8577095696c14104c32b535d51d5c2e92c6',
  '0x4585fe77225b41b697c638b91ded08515783c8f7',
  '0x99ac8ca7087fa4a2a1fb63572695c5a2dca18c0a',
  '0x3416cf6c708da44db2624d63ea0aa7f394236a28'
];

export async function monitorUniswap(env: any, provider: any, fromBlockHex: string, toBlockHex: string, now: number, alerts: any[], activityTracker: Map<string, number>, updateActor: any, getTransaction: any, getThreatPrefix: any, formatActorDescription: any, calculatePriceImpact: any) {
  const mintBurnsByBlock: Record<number, Record<string, { mint: boolean, burn: boolean }>> = {};

  for (const poolAddress of TOP_POOLS) {
    const logs = await provider.send('eth_getLogs', [{
        address: poolAddress,
        fromBlock: fromBlockHex,
        toBlock: toBlockHex,
        topics: [[
          uniswapInterface.getEvent('Swap')?.topicHash,
          uniswapInterface.getEvent('Mint')?.topicHash,
          uniswapInterface.getEvent('Burn')?.topicHash
        ]]
      }]);

    for (const log of logs) {
      const decoded = uniswapInterface.parseLog(log);
      if (!decoded) continue;
      const blockNumber = parseInt(log.blockNumber, 16);
      const tx = await getTransaction(log.transactionHash, provider);
      const actor = tx?.from || ZeroAddress;
      activityTracker.set(actor, (activityTracker.get(actor) || 0) + 1);

      const baseAlert = {
        contractId: poolAddress, contractName: 'Uniswap V3 Pool', contractAddress: poolAddress,
        chain: 'ethereum', protocol: 'uniswap', txHash: log.transactionHash, blockNumber, timestamp: now,
      };

      if (decoded.name === 'Swap') {
        const impact = await calculatePriceImpact(poolAddress, decoded.args.sqrtPriceX96, blockNumber, provider);
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
}
