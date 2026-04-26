import { Env } from './index';

export interface InterpretationResult {
  interpretation: string;
  source: 'ai' | 'rule-based';
}

export async function interpretAlert(alert: any, env: Env): Promise<InterpretationResult> {
  if (env.GEMINI_API_KEY) {
    try {
      const aiInterpretation = await callGeminiAI(alert, env.GEMINI_API_KEY);
      if (aiInterpretation) {
        return { interpretation: aiInterpretation, source: 'ai' };
      }
    } catch (e) {
      console.error('Gemini AI Interpretation failed, falling back to rules:', e);
    }
  }

  return { interpretation: getRuleBasedInterpretation(alert), source: 'rule-based' };
}

async function callGeminiAI(alert: any, apiKey: string): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const prompt = `
    You are a DeFi security expert. Interpret the following security alert and provide a concise, human-readable narrative (2-4 sentences) explaining:
    1. What happened.
    2. Why it is a risk or significant.
    3. What the immediate implication is for the protocol.

    Use professional but urgent tone. Format with Markdown. Use emojis appropriately.

    Alert Data:
    ${JSON.stringify(alert, null, 2)}

    Interpretation:
  `;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.4,
        topK: 32,
        topP: 1,
        maxOutputTokens: 256,
      }
    })
  });

  if (!response.ok) return null;

  const data: any = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return text || null;
}

function getRuleBasedInterpretation(alert: any): string {
  let sections: string[] = [];

  // 1. Flash Loan & Extraction Narratives
  if (alert.classificationTag === 'CONFIRMED_EXTRACTION') {
    const surplus = alert.usdSurplus?.toFixed(2);
    const inflow = alert.totalInflow?.toFixed(2);
    const outflow = alert.totalOutflow?.toFixed(2);
    sections.push(`💰 *CONFIRMED EXTRACTION*\n` +
      `An address walked away with *$${surplus}* more than they put in.\n` +
      `→ Inflow: $${inflow} | Outflow: $${outflow}\n` +
      (alert.neutralityBreached ? `→ ⚠️ Flash loan neutrality breached — repayment deviated >1%\n` : `→ Flash loan repaid correctly (surplus came from protocol interaction)\n`) +
      (alert.firstTimeActor ? `→ 🆕 First-time actor — no prior history, debut exploit signature\n` : `→ Known actor with ${alert.actorHistoryCount} prior event(s)\n`));
  } else if (alert.classificationTag === 'SUSPECTED_ATTEMPT') {
    const surplus = alert.usdSurplus?.toFixed(2);
    sections.push(`⚠️ *SUSPECTED ATTEMPT*\n` +
      `Flash loan executed with a small positive surplus ($${surplus}).\n` +
      `→ Below extraction threshold but pattern is consistent with a probe or failed attempt.\n` +
      (alert.neutralityBreached ? `→ ⚠️ Flash loan neutrality breached — repayment deviated >1%\n` : "") +
      (alert.firstTimeActor ? `→ 🆕 First-time actor — watch for follow-up transactions\n` : ""));
  } else if (alert.firstTimeActor && alert.title.includes('FlashLoan')) {
    sections.push(`🆕 *FIRST-TIME ACTOR*\n` +
      `A contract with no prior history just executed a flash loan.\n` +
      `→ No extraction detected yet, but debut flash loans are high-risk signals.\n` +
      `→ Monitor this address for follow-up activity in next 1–3 blocks.\n`);
  }

  // 2. Aave Specific Narratives
  if (alert.title.includes('Liquidation Cascade')) {
    sections.push(`🌊 *LIQUIDATION CASCADE*\n` +
      `Multiple liquidations detected in a single block. This suggests a sharp price drop or a coordinated attempt to flush out leveraged positions.\n`);
  } else if (alert.title.includes('Borrow + Liquidation Block')) {
    sections.push(`⚖️ *ATOMIC ARBITRAGE/LIQUIDATION*\n` +
      `An actor borrowed assets and performed liquidations in the same block. This is often a sign of efficient arbitrage or a self-liquidation to avoid larger losses.\n`);
  } else if (alert.title.includes('Large Borrow')) {
    let borrowMsg = `💰 *LARGE BORROW DETECTED*\n` +
      `Address borrowed $${alert.borrowAmountUsd?.toFixed(2)} USD.\n` +
      `→ Health Factor: ${alert.healthFactor?.toFixed(2)}\n` +
      `→ LTV: ${alert.ltv?.toFixed(2)}%\n`;
    if (alert.cascadeRisk) {
      borrowMsg += `→ ⚠️ *CASCADE RISK:* Position is near liquidation threshold while other liquidations are occurring in the same block.\n`;
    }
    sections.push(borrowMsg);
  }

  // 3. Uniswap Narratives
  if (alert.title.includes('High Impact Swap')) {
    const impactPercent = (alert.priceImpact * 100).toFixed(2);
    sections.push(`📉 *HIGH PRICE IMPACT*\n` +
      `A single swap moved the pool price by *${impactPercent}%*. This could be a large legitimate trade or an attempt to manipulate price for dependent protocols (oracles).\n`);
  } else if (alert.title.includes('Mint & Burn Spike')) {
    sections.push(`⚡ *JIT LIQUIDITY / SANDWICH*\n` +
      `Rapid minting and burning of liquidity in the same block. This is a classic signature of Just-In-Time (JIT) liquidity or sandwiching activity.\n`);
  }

  // 4. Oracle Narratives
  if (alert.title.includes('ORACLE ATTACK')) {
    sections.push(`🚨 *CRITICAL ORACLE DIVERGENCE*\n` +
      `Prices across different sources are significantly out of sync (${alert.deviation?.toFixed(2)}% deviation) while exploit patterns are detected. High probability of an active price manipulation attack.\n`);
  } else if (alert.title.includes('Oracle Price Anomaly')) {
    const div = alert.chainlinkDivergence ? ` | Chainlink Divergence: ${alert.chainlinkDivergence.toFixed(2)}%` : "";
    sections.push(`🔍 *PRICE FEED INSTABILITY*\n` +
      `The on-chain oracle reported a *${alert.deviation?.toFixed(2)}%* deviation from previous values${div}. Potential for bad debt if used for lending/borrowing.\n`);
  }

  if (sections.length === 0) {
    return "No specific narrative available for this alert type.";
  }

  return sections.join("\n");
}
