import { JsonRpcProvider, Contract, ZeroAddress } from 'ethers';
import { ActorRecord, ActorEvent } from './types.js';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || '';

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Supabase credentials missing in environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

// Supabase KV-like helpers for monitor_state
export async function getKV(key: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('monitor_state')
    .select('value')
    .eq('key', key)
    .single();

  if (error) {
    if (error.code !== 'PGRST116') { // PGRST116 is "no rows returned"
      console.error(`Error getting KV for key ${key}:`, error);
    }
    return null;
  }
  return data?.value;
}

export async function putKV(key: string, value: string): Promise<void> {
  const { error } = await supabase
    .from('monitor_state')
    .upsert({ key, value, updated_at: Date.now() });

  if (error) {
    console.error(`Error putting KV for key ${key}:`, error);
  }
}

export async function getActorRecord(address: string): Promise<ActorRecord> {
  const { data, error } = await supabase
    .from('actor_memory')
    .select('*')
    .eq('address', address.toLowerCase())
    .single();

  if (error) {
    if (error.code !== 'PGRST116') {
      console.error(`Error getting actor record for ${address}:`, error);
    }
    return {
      score: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      eventCount: 0,
      recentEvents: []
    };
  }

  return {
    address: data.address,
    score: data.score,
    firstSeen: Date.now(), // Table doesn't have firstSeen, using current for new or just ignoring if not critical
    lastSeen: new Date(data.last_seen).getTime(),
    eventCount: data.event_count,
    recentEvents: data.recent_events || [],
    confirmedExtractions: data.confirmed_extractions,
    totalExtractedUsd: data.total_extracted_usd
  };
}

export async function updateActor(address: string, additionalPoints: number, eventDescription: string, env: any, txHash: string, blockNumber: number): Promise<ActorRecord> {
  const record = await getActorRecord(address);
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

  const { error } = await supabase
    .from('actor_memory')
    .upsert({
      address: address.toLowerCase(),
      score: record.score,
      event_count: record.eventCount,
      confirmed_extractions: record.confirmedExtractions || 0,
      total_extracted_usd: record.totalExtractedUsd || 0,
      last_seen: record.lastSeen,
      recent_events: record.recentEvents
    });

  if (error) {
    console.error(`Error updating actor record for ${address}:`, error);
  }

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

const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

export async function calculatePriceImpact(poolAddress: string, newSqrtPriceX96: bigint, blockNumber: number, provider: JsonRpcProvider): Promise<number> {
  try {
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
    const token = new Contract(asset, ['function decimals() view returns (uint8)'], provider);
    
    const [price, decimals] = await Promise.all([
      oracle.getAssetPrice(asset, { blockTag: blockNumber }),
      token.decimals({ blockTag: blockNumber }).catch(() => 18)
    ]);

    const decimalsNum = Number(decimals);
    return Number(BigInt(amount) * BigInt(price) / BigInt(10 ** decimalsNum)) / 1e8;
  } catch (e) {
    return 0;
  }
}
