import { Interface, JsonRpcProvider, getAddress } from 'ethers';
import { getUsdValue } from './utils';

const ERC20_ABI = [
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "name": "from", "type": "address" },
      { "indexed": true, "name": "to", "type": "address" },
      { "indexed": false, "name": "value", "type": "uint256" }
    ],
    "name": "Transfer",
    "type": "event"
  }
];

const erc20Interface = new Interface(ERC20_ABI);

export async function computeFlowDelta(
  txHash: string,
  initiatorAddress: string,
  provider: JsonRpcProvider,
  flashLoanAsset?: string,
  flashLoanAmount?: bigint,
  flashLoanPremium?: bigint
) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return null;

    const initiator = initiatorAddress.toLowerCase();
    let totalInflow = 0;
    let totalOutflow = 0;
    let tokenNetDelta = BigInt(0); // This will track the specific flash loan asset outflow

    const flashLoanAssetAddr = flashLoanAsset ? getAddress(flashLoanAsset) : null;

    for (const log of receipt.logs) {
      try {
        const decoded = erc20Interface.parseLog({
          topics: log.topics as string[],
          data: log.data
        });

        if (decoded && decoded.name === 'Transfer') {
          const { from, to, value } = decoded.args;
          const tokenAddress = log.address;
          const fromLower = from.toLowerCase();
          const toLower = to.toLowerCase();

          const usdValue = await getUsdValue(tokenAddress, value, provider, receipt.blockNumber);

          if (toLower === initiator) {
            totalInflow += usdValue;
          }
          if (fromLower === initiator) {
            totalOutflow += usdValue;
            
            if (flashLoanAssetAddr && getAddress(tokenAddress) === flashLoanAssetAddr) {
              tokenNetDelta += value;
            }
          }
        }
      } catch (e) {
        // Skip logs that fail to parse
      }
    }

    const totalVolume = totalInflow + totalOutflow;
    const atomicExecutionSurplus = totalInflow - totalOutflow;
    const usdSurplus = atomicExecutionSurplus;

    let classificationTag: 'CONFIRMED_EXTRACTION' | 'SUSPECTED_ATTEMPT' | 'NO_EXTRACTION' = 'NO_EXTRACTION';
    if (atomicExecutionSurplus > Math.max(10000, totalVolume * 0.02)) {
      classificationTag = 'CONFIRMED_EXTRACTION';
    } else if (atomicExecutionSurplus > 0) {
      classificationTag = 'SUSPECTED_ATTEMPT';
    }

    let neutralityBreached = false;
    if (flashLoanAsset && flashLoanAmount !== undefined && flashLoanPremium !== undefined) {
      const expectedOutflow = flashLoanAmount + flashLoanPremium;
      const diff = tokenNetDelta > expectedOutflow ? tokenNetDelta - expectedOutflow : expectedOutflow - tokenNetDelta;
      
      // Check if absolute net delta deviates more than 1% from flashLoanAmount + flashLoanPremium
      if (expectedOutflow > 0n) {
        if (diff * 100n > expectedOutflow) {
          neutralityBreached = true;
        }
      } else if (tokenNetDelta > 0n) {
        neutralityBreached = true;
      }
    }

    return {
      atomicExecutionSurplus,
      totalInflow,
      totalOutflow,
      totalVolume,
      classificationTag,
      neutralityBreached,
      usdSurplus
    };
  } catch (error) {
    return null;
  }
}
