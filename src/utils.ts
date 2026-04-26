import { JsonRpcProvider, Contract, ZeroAddress, Interface } from 'ethers';
import { Env, ActorRecord, ActorEvent } from './types'; // Import types

// --- Local Cache for getTransaction ---
const txCache = new Map<string, any>();

// --- Helper Function Definitions ---

export async function getTransaction(txHash: string, provider: JsonRpcProvider) {
  if (txCache.has(txHash)) return txCache.get(txHash);
  try {
    const tx = await provider.getTransaction(txHash);
    txCache.set(txHash, tx);
    return tx;
  } catch (e) {
    return null;
  }
}

export async function getActorRecord(address: string, env: Env): Promise<ActorRecord> {
  const data = await env.DEFI_WATCH_KV.get(`actor:${address.toLowerCase()}`);
  if (data) {
    const record = JSON.parse(data);
    // Ensure recentEvents is an array of objects, not strings, if compatibility issues arise.
    if (record.recentEvents && record.recentEvents.length > 0 && typeof record.recentEvents[0] === 'string') {
      record.recentEvents = [];
    }
    return record;
  }
  return {
    score: 0,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    eventCount: 0,
    recentEvents: []
  };
}

export async function updateActor(address: string, additionalPoints: number, eventDescription: string, env: Env, txHash: string, blockNumber: number): Promise<ActorRecord> {
  const record = await getActorRecord(address, env);
  let pointsToAdd = additionalPoints;

  if (record.score > 30) {
    pointsToAdd += 30;
  }

  record.score += pointsToAdd;
  record.lastSeen = Date.now();
  record.eventCount += 1;
  record.recentEvents.unshift({
    description: eventDescription,
    txHash,
    blockNumber,
    timestamp: Date.now()
  });
  if (record.recentEvents.length > 10) record.recentEvents.pop();

  await env.DEFI_WATCH_KV.put(`actor:${address.toLowerCase()}`, JSON.stringify(record));
  return record;
}

export function getThreatPrefix(record: ActorRecord) {
  if (record.score >= 91) return `[KNOWN THREAT ACTOR - ${record.eventCount} flags] `;
  if (record.score >= 61) return "[HIGH RISK ACTOR] ";
  if (record.score >= 31) return "[WARNING] ";
  return "";
}

export function formatActorDescription(description: string, record: ActorRecord) {
  return `${description} | Actor Score: ${record.score} | History: ${record.eventCount}`;
}

// --- Constants and Interfaces needed for utility functions ---
// UNISWAP_V3_FACTORY is used by calculatePriceImpact.
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

// calculatePriceImpact requires `uniswapInterface`. This interface definition is not included here
// as it depends on an ABI file ('./abis/uniswap-v3.json'). For full functionality,
// `uniswapInterface` would need to be defined or imported here as well.
// The function signature below is kept as is, assuming `uniswapInterface` will be available in scope
// where this function is called, or passed as an argument if refactored.

export async function calculatePriceImpact(poolAddress: string, newSqrtPriceX96: bigint, blockNumber: number, provider: JsonRpcProvider /*, uniswapInterface: Interface */): Promise<number> {
  try {
    // WARNING: This function requires `uniswapInterface` to be defined or imported.
    // For demonstration purposes, using a placeholder or assuming it's available.
    // A complete solution would involve defining uniswapInterface here or importing it.
    // Example using a hypothetical uniswapInterface:
    // const pool = new Contract(poolAddress, uniswapInterface.getAbi('Swap'), provider); // Placeholder
    // For now, let's assume the ABI structure for `slot0` is known:
    const pool = new Contract(poolAddress, ['function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)'], provider);
    const [oldSqrtPriceX96] = await pool.slot0({ blockTag: blockNumber - 1 });
    
    const oldP = Number(oldSqrtPriceX96);
    const newP = Number(newSqrtPriceX96);
    
    const impact = Math.abs(Math.pow(newP / oldP, 2) - 1);
    return impact;
  } catch (e) {
    console.error('Error calculating price impact:', e);
    return 0;
  }
}

export const AAVE_ORACLE = '0x54586bE62E3c3580375aE3723C145253060Ca0C2';

export async function getUsdValue(asset: string, amount: bigint, provider: any, blockNumber: number): Promise<number> {
  try {
    const { Contract } = await import('ethers');
    const oracle = new Contract(AAVE_ORACLE, ['function getAssetPrice(address) view returns (uint256)'], provider);
    const price = await oracle.getAssetPrice(asset, { blockTag: blockNumber });
    return Number(amount) * Number(price) / 1e26;
  } catch (e) {
    return 0;
  }
}
