import { Interface, JsonRpcProvider, Contract, ZeroAddress, formatUnits, getAddress } from 'ethers';
import aaveAbi from './abis/aave-v3.json';
import uniswapAbi from './abis/uniswap-v3.json';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  RPC_URL: string;
}

const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const AAVE_ORACLE = '0x54586BE12322e69969715390d413007F35a9a9c4';

const aaveInterface = new Interface(aaveAbi);
const uniswapInterface = new Interface(uniswapAbi);

async function getUsdValue(reserve: string, amount: bigint, provider: JsonRpcProvider): Promise<number> {
  try {
    reserve = getAddress(reserve);
    const oracle = new Contract(AAVE_ORACLE, ['function getAssetPrice(address) view returns (uint256)'], provider);
    const asset = new Contract(reserve, ['function decimals() view returns (uint8)'], provider);
    
    const [price, decimals] = await Promise.all([
      oracle.getAssetPrice(reserve),
      asset.decimals().catch(() => 18)
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

async function checkContractAge(address: string, currentBlock: number, provider: JsonRpcProvider): Promise<boolean> {
  try {
    // 7 days ~ 50400 blocks (12s per block)
    const historicalBlock = currentBlock - 50400;
    const code = await provider.getCode(address, historicalBlock);
    return code === '0x'; // If no code 7 days ago, it's a new contract
  } catch (e) {
    return false;
  }
}

async function calculatePriceImpact(poolAddress: string, newSqrtPriceX96: bigint, blockNumber: number, provider: JsonRpcProvider): Promise<number> {
  try {
    const pool = new Contract(poolAddress, ['function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)'], provider);
    const [oldSqrtPriceX96] = await pool.slot0({ blockTag: blockNumber - 1 });
    
    const oldP = Number(oldSqrtPriceX96);
    const newP = Number(newSqrtPriceX96);
    
    const impact = Math.abs(Math.pow(newP / oldP, 2) - 1);
    return impact;
  } catch (e) {
    return 0;
  }
}

async function saveToSupabase(alert: any, env: Env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    console.warn('Supabase credentials missing');
    return;
  }
  const url = `${env.SUPABASE_URL}/rest/v1/alerts`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(alert)
    });
    if (!response.ok) {
      console.error('Failed to save to Supabase:', response.statusText, await response.text());
    }
  } catch (e) {
    console.error('Error saving to Supabase:', e);
  }
}

async function sendTelegram(alert: any, env: Env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const text = `🚨 *${alert.title.toUpperCase()} ALERT* 🚨\n\nSeverity: ${alert.severity}\nDetails: ${alert.description}\nBlock: ${alert.blockNumber}\nTX: [View on Etherscan](https://etherscan.io/tx/${alert.txHash})`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'Markdown'
      })
    });
    if (!response.ok) {
      console.error('Failed to send Telegram message:', response.statusText);
    }
  } catch (e) {
    console.error('Error sending Telegram message:', e);
  }
}

async function run(env: Env) {
  const provider = new JsonRpcProvider(env.RPC_URL || 'https://ethereum.publicnode.com');
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = currentBlock - 100;

  const alerts: any[] = [];
  const now = Date.now();

  // 1. Aave V3 Monitoring
  const aaveLogs = await provider.send('eth_getLogs', [{
    address: AAVE_V3_POOL,
    fromBlock: '0x' + fromBlock.toString(16),
    toBlock: 'latest',
    topics: [
      [
        aaveInterface.getEvent('Borrow')?.topicHash,
        aaveInterface.getEvent('LiquidationCall')?.topicHash,
        aaveInterface.getEvent('FlashLoan')?.topicHash
      ]
    ]
  }]);

  for (const log of aaveLogs) {
    const decoded = aaveInterface.parseLog(log);
    if (!decoded) continue;

    const baseAlert = {
      contractId: 'aave-v3',
      contractName: 'Aave V3 Pool',
      contractAddress: AAVE_V3_POOL,
      chain: 'ethereum',
      protocol: 'aave',
      txHash: log.transactionHash,
      blockNumber: parseInt(log.blockNumber, 16),
      timestamp: now,
    };

    if (decoded.name === 'Borrow') {
      const { reserve, amount, user } = decoded.args;
      const usdValue = await getUsdValue(reserve, amount, provider);
      if (usdValue > 1000) {
        alerts.push({
          ...baseAlert,
          id: `${log.transactionHash}-aave-borrow`,
          severity: 'high',
          title: 'Aave V3 Large Borrow',
          description: `Large borrow: ${usdValue.toFixed(2)} USD by ${user}`,
        });
      }
    } else if (decoded.name === 'LiquidationCall') {
      alerts.push({
        ...baseAlert,
        id: `${log.transactionHash}-aave-liq`,
        severity: 'high',
        title: 'Aave V3 Liquidation',
        description: `Liquidation detected for user ${decoded.args.user}`,
      });
    } else if (decoded.name === 'FlashLoan') {
      const { initiator } = decoded.args;
      const isNewContract = await checkContractAge(initiator, currentBlock, provider);
      if (isNewContract) {
        alerts.push({
          ...baseAlert,
          id: `${log.transactionHash}-aave-flash`,
          severity: 'critical',
          title: 'Aave V3 Suspicious FlashLoan',
          description: `FlashLoan by new contract (<7 days): ${initiator}`,
        });
      }
    }
  }

  // 2. Uniswap V3 Monitoring
  const uniswapLogs = await provider.send('eth_getLogs', [{
    address: UNISWAP_V3_FACTORY,
    fromBlock: '0x' + fromBlock.toString(16),
    toBlock: 'latest',
    topics: [
      [
        uniswapInterface.getEvent('Swap')?.topicHash,
        uniswapInterface.getEvent('Mint')?.topicHash,
        uniswapInterface.getEvent('Burn')?.topicHash
      ]
    ]
  }]);

  const mintBurnsByBlock: Record<number, Record<string, { mint: boolean, burn: boolean, txHash: string }>> = {};

  for (const log of uniswapLogs) {
    const decoded = uniswapInterface.parseLog(log);
    if (!decoded) continue;

    const blockNumber = parseInt(log.blockNumber, 16);
    const baseAlert = {
      contractId: 'uni-v3-factory',
      contractName: 'Uniswap V3 Factory',
      contractAddress: UNISWAP_V3_FACTORY,
      chain: 'ethereum',
      protocol: 'uniswap',
      txHash: log.transactionHash,
      blockNumber,
      timestamp: now,
    };

    if (decoded.name === 'Swap') {
      const { sqrtPriceX96 } = decoded.args;
      const impact = await calculatePriceImpact(log.address, sqrtPriceX96, blockNumber, provider);
      if (impact > 0.03) {
        alerts.push({
          ...baseAlert,
          id: `${log.transactionHash}-uni-swap`,
          severity: 'warning',
          title: 'Uniswap V3 High Impact Swap',
          description: `High price impact swap: ${(impact * 100).toFixed(2)}%`,
        });
      }
    } else if (decoded.name === 'Mint' || decoded.name === 'Burn') {
      const owner = decoded.args.owner || decoded.args.sender;
      if (!mintBurnsByBlock[blockNumber]) mintBurnsByBlock[blockNumber] = {};
      if (!mintBurnsByBlock[blockNumber][owner]) mintBurnsByBlock[blockNumber][owner] = { mint: false, burn: false, txHash: log.transactionHash };
      
      if (decoded.name === 'Mint') mintBurnsByBlock[blockNumber][owner].mint = true;
      if (decoded.name === 'Burn') mintBurnsByBlock[blockNumber][owner].burn = true;

      if (mintBurnsByBlock[blockNumber][owner].mint && mintBurnsByBlock[blockNumber][owner].burn) {
        alerts.push({
          ...baseAlert,
          id: `${log.transactionHash}-uni-mintburn`,
          severity: 'high',
          title: 'Uniswap V3 Mint & Burn Spike',
          description: `Mint and Burn in same block by ${owner}`,
        });
      }
    }
  }

  // 3. Save to Supabase and Notify Telegram
  for (const alert of alerts) {
    await saveToSupabase(alert, env);
    if (alert.severity === 'critical' || alert.severity === 'emergency' || alert.severity === 'high') {
      await sendTelegram(alert, env);
    }
  }
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    await run(env);
    return new Response('Worker executed');
  }
};
