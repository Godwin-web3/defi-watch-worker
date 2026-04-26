import { Contract, JsonRpcProvider, formatUnits, getAddress } from 'ethers';

export const AAVE_ORACLE = '0x54586bE62E3c3580375aE3723C145253060Ca0C2';

export async function getUsdValue(reserve: string, amount: bigint, provider: JsonRpcProvider, blockNumber?: number): Promise<number> {
  try {
    reserve = getAddress(reserve);
    const oracle = new Contract(AAVE_ORACLE, ['function getAssetPrice(address) view returns (uint256)'], provider);
    const asset = new Contract(reserve, ['function decimals() view returns (uint8)'], provider);
    
    const [price, decimals] = await Promise.all([
      oracle.getAssetPrice(reserve, { blockTag: blockNumber }),
      asset.decimals({ blockTag: blockNumber }).catch(() => 18)
    ]);

    // Aave Oracle returns price in 8 decimals
    const amountFormatted = parseFloat(formatUnits(amount, decimals));
    const priceFormatted = parseFloat(formatUnits(price, 8));
    return amountFormatted * priceFormatted;
  } catch (e) {
    console.error('Error fetching USD value:', e);
    return 0;
  }
}
