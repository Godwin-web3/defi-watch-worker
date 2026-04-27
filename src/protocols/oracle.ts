import { Contract, ZeroAddress } from 'ethers';
import { AAVE_ORACLE } from '../utils.js';

export async function monitorOracle(env: any, provider: any, toBlock: number, now: number, alerts: any[], assetsToMonitor: Set<string>, checkOraclePrice: any, checkChainlinkDivergence: any, correlativeAlerts: any[]) {
  for (const asset of assetsToMonitor) {
    const oracleInfo = await checkOraclePrice(asset, env, provider);
    if (!oracleInfo) continue;
    const chainlinkInfo = await checkChainlinkDivergence(asset, oracleInfo.currentPrice, provider);

    let severity = '', type = '';
    if (oracleInfo.deviation > 10) { severity = 'critical'; type = 'Oracle_Price_Spike'; }
    else if (chainlinkInfo && chainlinkInfo.divergence > 7) { severity = 'critical'; type = 'Oracle_Manipulation'; }
    else if (oracleInfo.deviation > 5) { severity = 'high'; type = 'Oracle_Price_Movement'; }
    else if (chainlinkInfo && chainlinkInfo.divergence > 3) { severity = 'high'; type = 'Oracle_Divergence'; }

    if (severity) {
      let title = 'Aave Oracle Price Anomaly', description = `Significant price anomaly for asset ${asset}. Deviation: ${oracleInfo.deviation.toFixed(2)}%, Chainlink Divergence: ${chainlinkInfo ? chainlinkInfo.divergence.toFixed(2) : 'N/A'}%`;
      if (severity === 'critical' && correlativeAlerts.length > 0) {
        title = 'ORACLE ATTACK IN PROGRESS';
        description += ` | Triggered alongside: ${correlativeAlerts.map(a => a.title).join(', ')}`;
      }
      alerts.push({ id: `oracle-${asset}-${toBlock}`, contractId: 'aave-oracle', contractName: 'Aave Oracle', contractAddress: AAVE_ORACLE, chain: 'ethereum', protocol: 'aave', severity, type, title, description, blockNumber: toBlock, timestamp: now, txHash: 'N/A', deviation: oracleInfo.deviation, chainlinkDivergence: chainlinkInfo?.divergence });
    }
  }
}
