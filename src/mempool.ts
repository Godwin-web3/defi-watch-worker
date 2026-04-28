import { WebSocketProvider } from 'ethers';

const WATCHED_ADDRESSES = new Set([
  '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Aave V3
  '0x1F98431c8aD98523631AE4a59f267346ea31F984', // Uniswap V3 Factory
  '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', // Curve 3Pool
  '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022', // Curve stETH
  '0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB', // Gauge Controller
  '0x0a390ced42a6320577002047805d21c97a553245', // Maker Gov
  '0x89B78CfA322F6C573a15239C73F6c1242e8b92ad', // Maker PSM
  '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', // Lido stETH
  '0x889edC2BDE944250596279FE1127e13d8212Ad1b', // Lido Withdrawal Queue
].map(a => a.toLowerCase()));

const HIGH_VALUE_THRESHOLD = BigInt('1000000000000000000000'); // 1000 ETH in wei

async function sendTelegramAlert(token: string, chatId: string, message: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' })
    });
  } catch (e) {}
}

function analyzeTransaction(tx: any): { suspicious: boolean; reason: string; severity: string } | null {
  if (!tx.to) {
    return { suspicious: true, reason: 'Contract deployment to watched ecosystem', severity: 'medium' };
  }

  if (tx.value && tx.value > HIGH_VALUE_THRESHOLD) {
    const ethValue = Number(tx.value / BigInt('1000000000000000000'));
    return { suspicious: true, reason: `High value transfer: ${ethValue} ETH`, severity: 'high' };
  }

  // Flash loan signatures
  const data = tx.data || '';
  const FLASH_LOAN_SIGS = ['0xab9c4b5d', '0x5cffe9de', '0xf2b9fdb8'];
  if (FLASH_LOAN_SIGS.some(sig => data.startsWith(sig))) {
    return { suspicious: true, reason: 'Flash loan detected in mempool', severity: 'high' };
  }

  // Multicall - often used in complex exploits
  const MULTICALL_SIGS = ['0xac9650d8', '0x5ae401dc'];
  if (MULTICALL_SIGS.some(sig => data.startsWith(sig))) {
    return { suspicious: true, reason: 'Multicall to watched contract', severity: 'medium' };
  }

  return null;
}

export async function startMempoolMonitor() {
  const wsUrl = process.env.WS_RPC_URL;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!wsUrl || !token || !chatId) {
    console.error('Mempool monitor: missing WS_RPC_URL, TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return;
  }

  let provider: WebSocketProvider;

  async function connect() {
    try {
      provider = new WebSocketProvider(wsUrl!);

      provider.on('pending', async (txHash: string) => {
        try {
          const tx = await provider.getTransaction(txHash);
          if (!tx || !tx.to) return;
          if (!WATCHED_ADDRESSES.has(tx.to.toLowerCase())) return;

          const result = analyzeTransaction(tx);
          if (!result) return;

          const message = `⚡ *MEMPOOL ALERT*\n\nSeverity: ${result.severity}\nReason: ${result.reason}\nTo: \`${tx.to}\`\nFrom: \`${tx.from}\`\nTX: [View](https://etherscan.io/tx/${txHash})`;
          await sendTelegramAlert(token!, chatId!, message);
          console.log(`Mempool alert fired: ${result.reason} | ${txHash}`);
        } catch (e) {}
      });

      provider.on('error', (e: any) => {
        console.error('WebSocket error:', e);
        setTimeout(connect, 5000);
      });

      console.log('Mempool monitor connected');
    } catch (e) {
      console.error('Mempool connect failed, retrying in 5s:', e);
      setTimeout(connect, 5000);
    }
  }

  await connect();
}
