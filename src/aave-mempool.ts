import { WebSocketProvider, Contract, Interface } from 'ethers';
import { AAVE_ORACLE } from './utils.js';

const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const RAY = BigInt('1000000000000000000000000000'); // 1e27
const OPTIMAL_UTILIZATION = 80n; // 80%
const RATE_SPIKE_THRESHOLD = 20n; // 20% jump in borrow rate = suspicious
const PRICE_DEVIATION_THRESHOLD = 3; // 3% divergence from Chainlink

const POOL_ABI = [
  'function getReserveData(address asset) view returns (uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)',
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  'function getReserveNormalizedVariableDebt(address asset) view returns (uint256)'
];

const ORACLE_ABI = [
  'function getAssetPrice(address) view returns (uint256)',
  'function getSourceOfAsset(address) view returns (address)'
];

const CHAINLINK_ABI = [
  'function latestAnswer() view returns (int256)'
];

const BORROW_SIG = '0xa415bcad'; // borrow(address,uint256,uint256,uint16,address)
const LIQUIDATION_SIG = '0x00a718a9'; // liquidationCall(address,address,address,uint256,bool)

// Track pending liquidations to detect front-running races
const pendingLiquidations = new Map<string, { senders: Set<string>, timestamp: number }>();

async function sendTelegramAlert(token: string, chatId: string, message: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' })
    });
  } catch (e) {}
}

async function checkPriceDeviation(asset: string, provider: WebSocketProvider): Promise<{ deviation: number, aavePrice: bigint, chainlinkPrice: bigint } | null> {
  try {
    const oracle = new Contract(AAVE_ORACLE, ORACLE_ABI, provider);
    const aavePrice: bigint = await oracle.getAssetPrice(asset);
    const feedAddress: string = await oracle.getSourceOfAsset(asset);
    if (!feedAddress || feedAddress === '0x0000000000000000000000000000000000000000') return null;

    const feed = new Contract(feedAddress, CHAINLINK_ABI, provider);
    const chainlinkPrice: bigint = await feed.latestAnswer();
    if (chainlinkPrice <= 0n) return null;

    const diff = aavePrice > chainlinkPrice ? aavePrice - chainlinkPrice : chainlinkPrice - aavePrice;
    const deviation = Number((diff * 10000n) / chainlinkPrice) / 100;
    return { deviation, aavePrice, chainlinkPrice };
  } catch (e) {
    return null;
  }
}

async function checkUtilizationAfterBorrow(asset: string, borrowAmount: bigint, provider: WebSocketProvider): Promise<{ currentUtil: number, projectedUtil: number, rateBefore: bigint, suspicious: boolean } | null> {
  try {
    const pool = new Contract(AAVE_V3_POOL, POOL_ABI, provider);
    const data = await pool.getReserveData(asset);

    // data[1] = liquidityIndex, data[4] = currentVariableBorrowRate
    const currentVariableBorrowRate: bigint = data[4];
    const currentLiquidityRate: bigint = data[2];

    // Utilization = borrows / (borrows + liquidity)
    // We approximate from rates: if liquidity rate and borrow rate are both available
    // utilization = liquidityRate / (variableBorrowRate * (1 - reserveFactor))
    // Simpler: flag if projected borrow pushes variable rate up by RATE_SPIKE_THRESHOLD%
    const rateInPercent = Number((currentVariableBorrowRate * 100n) / RAY);
    const projectedRate = rateInPercent + Number((borrowAmount * 10n) / BigInt('1000000000000000000000')); // rough linear approximation

    const suspicious = projectedRate > rateInPercent * (1 + Number(RATE_SPIKE_THRESHOLD) / 100);

    return {
      currentUtil: rateInPercent,
      projectedUtil: projectedRate,
      rateBefore: currentVariableBorrowRate,
      suspicious
    };
  } catch (e) {
    return null;
  }
}

function cleanOldLiquidations() {
  const fiveMinutes = 5 * 60 * 1000;
  const now = Date.now();
  for (const [key, val] of pendingLiquidations.entries()) {
    if (now - val.timestamp > fiveMinutes) pendingLiquidations.delete(key);
  }
}

export async function monitorAaveMempool(provider: WebSocketProvider, token: string, chatId: string) {
  const aaveInterface = new Interface([
    'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
    'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)'
  ]);

  provider.on('pending', async (txHash: string) => {
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx || !tx.to) return;
      if (tx.to.toLowerCase() !== AAVE_V3_POOL.toLowerCase()) return;

      const data = tx.data || '';
      const sig = data.slice(0, 10);

      // --- Liquidation front-running detection ---
      if (sig === LIQUIDATION_SIG) {
        try {
          const decoded = aaveInterface.parseTransaction({ data });
          if (!decoded) return;

          const { collateralAsset, user } = decoded.args;
          const key = `${user.toLowerCase()}-${collateralAsset.toLowerCase()}`;

          cleanOldLiquidations();

          if (!pendingLiquidations.has(key)) {
            pendingLiquidations.set(key, { senders: new Set([tx.from.toLowerCase()]), timestamp: Date.now() });
          } else {
            const entry = pendingLiquidations.get(key)!;
            entry.senders.add(tx.from.toLowerCase());

            if (entry.senders.size >= 2) {
              const message = `⚡ *AAVE LIQUIDATION RACE DETECTED*\n\nTarget user: \`${user}\`\nCollateral: \`${collateralAsset}\`\nCompeting liquidators: ${entry.senders.size}\nTX: [View](https://etherscan.io/tx/${txHash})\n\nMultiple bots racing to liquidate the same position.`;
              await sendTelegramAlert(token, chatId, message);
            }
          }
        } catch (e) {}
      }

      // --- Large borrow: utilization + price deviation check ---
      if (sig === BORROW_SIG) {
        try {
          const decoded = aaveInterface.parseTransaction({ data });
          if (!decoded) return;

          const { asset, amount } = decoded.args;

          // Check utilization impact
          const utilResult = await checkUtilizationAfterBorrow(asset, amount, provider);
          if (utilResult && utilResult.suspicious) {
            const message = `⚡ *AAVE RATE MANIPULATION RISK*\n\nAsset: \`${asset}\`\nBorrow amount: ${(Number(amount) / 1e18).toFixed(2)}\nCurrent borrow rate: ${utilResult.currentUtil.toFixed(2)}%\nProjected after borrow: ${utilResult.projectedUtil.toFixed(2)}%\nTX: [View](https://etherscan.io/tx/${txHash})\n\nLarge borrow may push utilization past optimal threshold.`;
            await sendTelegramAlert(token, chatId, message);
          }

          // Check price deviation
          const priceResult = await checkPriceDeviation(asset, provider);
          if (priceResult && priceResult.deviation >= PRICE_DEVIATION_THRESHOLD) {
            const message = `⚡ *AAVE COLLATERAL PRICE DEVIATION*\n\nAsset: \`${asset}\`\nAave oracle price: ${priceResult.aavePrice}\nChainlink price: ${priceResult.chainlinkPrice}\nDeviation: ${priceResult.deviation.toFixed(2)}%\nTX: [View](https://etherscan.io/tx/${txHash})\n\nAave and Chainlink prices diverging during active borrow.`;
            await sendTelegramAlert(token, chatId, message);
          }
        } catch (e) {}
      }

    } catch (e) {}
  });

  console.log('Aave mempool monitor active');
}
