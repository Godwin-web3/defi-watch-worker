import { Env } from './types.js';

export interface InterpretationResult {
  interpretation: string;
  source: 'ai' | 'rule-based';
}

interface AlertContext {
  event_type: string;
  protocol: string;
  chain: string;
  amount_usd?: number;
  health_factor?: number;
  ltv_percent?: number;
  actor_score: number;
  recent_events: number;
  hasFlashLoan: boolean;
  isNewAddress: boolean;
  repeatedBehavior: boolean;
  classificationTag?: string;
  usdSurplus?: number;
  totalInflow?: number;
  totalOutflow?: number;
  neutralityBreached?: boolean;
  priceImpact?: number;
  deviation?: number;
  cascadeRisk?: boolean;
  severity: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

interface AIInterpretation {
  summary: string;
  risk: string;
  next_move: string;
  watch: string;
}

function deriveConfidence(alert: any): 'HIGH' | 'MEDIUM' | 'LOW' {
  let score = 0;
  const title = (alert.title || '').toLowerCase();
  const prefix = (alert.threatPrefix || '').toUpperCase();
  if (title.includes('flash') || title.includes('exploit')) score += 2;
  if (title.includes('exploit pattern')) score += 3;
  if (prefix.includes('KNOWN THREAT')) score += 3;
  if (prefix.includes('HIGH RISK')) score += 2;
  if (alert.severity === 'critical') score += 2;
  if (alert.severity === 'high') score += 1;
  if (alert.classificationTag === 'CONFIRMED_EXTRACTION') score += 3;
  if (alert.classificationTag === 'SUSPECTED_ATTEMPT') score += 1;
  if (alert.neutralityBreached) score += 2;
  if (alert.cascadeRisk) score += 2;
  if (alert.firstTimeActor) score += 1;
  score = Math.min(score, 10);
  if (score >= 6) return 'HIGH';
  if (score >= 3) return 'MEDIUM';
  return 'LOW';
}

function buildAlertContext(alert: any): AlertContext {
  const desc = alert.description || '';
  const evidence = alert.evidence || {};
  const hfMatch = desc.match(/Health Factor[:\s]+([0-9.]+)/i);
  const health_factor = evidence.healthFactor || (hfMatch ? parseFloat(hfMatch[1]) : alert.healthFactor);
  const ltvMatch = desc.match(/LTV[:\s]+([0-9.]+)%/i);
  const ltv_percent = evidence.ltv || (ltvMatch ? parseFloat(ltvMatch[1]) : alert.ltv);
  const borrowMatch = desc.match(/(?:borrow|borrowed|Large borrow)[:\s]+\$?([0-9,.]+)/i);
  const amount_usd = evidence.usdValue || (borrowMatch ? parseFloat(borrowMatch[1].replace(',', '')) : alert.borrowAmountUsd || alert.usdSurplus);
  const title = alert.title || '';
  const confidence = deriveConfidence(alert);
  return {
    event_type: title,
    protocol: title.includes('Aave') ? 'Aave V3' : title.includes('Uniswap') ? 'Uniswap V3' : title.includes('Curve') ? 'Curve Finance' : title.includes('Maker') ? 'MakerDAO' : title.includes('Lido') ? 'Lido Finance' : 'Unknown',
    chain: 'Ethereum',
    amount_usd,
    health_factor,
    ltv_percent,
    actor_score: alert.actorScore || 0,
    recent_events: alert.actorHistoryCount || 0,
    hasFlashLoan: title.toLowerCase().includes('flash'),
    isNewAddress: !!alert.firstTimeActor,
    repeatedBehavior: (alert.actorHistoryCount || 0) > 1,
    classificationTag: alert.classificationTag,
    usdSurplus: alert.usdSurplus,
    totalInflow: alert.totalInflow,
    totalOutflow: alert.totalOutflow,
    neutralityBreached: alert.neutralityBreached,
    priceImpact: alert.priceImpact,
    deviation: alert.deviation,
    cascadeRisk: alert.cascadeRisk,
    severity: alert.severity,
    confidence,
  };
}

async function callGeminiAI(context: AlertContext, apiKey: string): Promise<AIInterpretation | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const systemPrompt = `You are a DeFi security expert analyzing on-chain alerts.
Return ONLY a valid JSON object with exactly these 4 fields:
{
  "summary": "one sentence — what happened",
  "risk": "one sentence — why this is dangerous",
  "next_move": "one sentence — what the actor is likely to do next",
  "watch": "one sentence — what signals to monitor"
}
Rules:
- Never invent numbers not in the input
- Never change severity
- Never claim profit unless classificationTag is CONFIRMED_EXTRACTION
- No markdown, no preamble, no explanation — JSON only`;
  const userPrompt = `Interpret this DeFi alert:\n${JSON.stringify(context, null, 2)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 256 }
      })
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) return null;
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    if (!parsed.summary || !parsed.risk || !parsed.next_move || !parsed.watch) return null;
    return parsed as AIInterpretation;
  } catch (e) {
    return null;
  }
}

function formatInterpretation(interp: AIInterpretation, confidence: 'HIGH' | 'MEDIUM' | 'LOW', source: 'ai' | 'rule-based'): string {
  const label = source === 'ai' ? `🧠 *Intelligence [${confidence}]* ✨` : `🧠 *Intelligence [${confidence}]* 📋`;
  return `${label}\n*Summary:* ${interp.summary}\n*Risk:* ${interp.risk}\n*Next Move:* ${interp.next_move}\n*Watch:* ${interp.watch}`;
}

function getRuleBasedInterpretation(context: AlertContext): AIInterpretation {
  if (context.classificationTag === 'CONFIRMED_EXTRACTION') {
    return {
      summary: `An address extracted $${context.usdSurplus?.toFixed(2)} in a single atomic transaction using a flash loan.`,
      risk: context.neutralityBreached ? `Flash loan repayment deviated >1% — malformed exploit or partial failure.` : `Surplus of $${context.usdSurplus?.toFixed(2)} was extracted cleanly; flash loan repaid correctly.`,
      next_move: context.isNewAddress ? `Debut exploit — actor may attempt a larger follow-up now that the pattern is proven.` : `Known actor with ${context.recent_events} prior events — likely to repeat with larger capital.`,
      watch: `Monitor this address for follow-up flash loans, new contract deployments, and token movements to CEX.`
    };
  } else if (context.classificationTag === 'SUSPECTED_ATTEMPT') {
    return {
      summary: `Flash loan executed with a small positive surplus — below extraction threshold but pattern matches a probe.`,
      risk: context.neutralityBreached ? `Flash loan neutrality breached — repayment deviated >1%.` : `Surplus is small but non-zero; actor may be testing attack parameters.`,
      next_move: `Actor is likely probing protocol conditions before a larger extraction attempt.`,
      watch: `Watch for repeat flash loans from this address, increasing amounts, or same-block oracle interactions.`
    };
  } else if (context.hasFlashLoan && context.isNewAddress) {
    return {
      summary: `A contract deployed less than 7 days ago executed its first flash loan on Aave V3.`,
      risk: `No extraction detected yet, but debut flash loans from new contracts are a high-risk signal.`,
      next_move: `Actor may be setting up for a multi-step exploit or testing contract interactions.`,
      watch: `Monitor for follow-up activity in next 1–3 blocks, especially borrows or liquidations.`
    };
  } else if (context.cascadeRisk) {
    return {
      summary: `A large borrow dropped a health factor below 1.05 while active liquidations are firing in the same block.`,
      risk: `Early signature of a liquidation spiral — collateral positions under stress.`,
      next_move: `If price continues moving, more positions will breach liquidation threshold.`,
      watch: `Monitor health factors below 1.05, additional borrow events, and liquidation volume.`
    };
  } else if (context.event_type.includes('Large Borrow')) {
    return {
      summary: `Address borrowed $${context.amount_usd?.toFixed(2)} with a health factor of ${context.health_factor?.toFixed(2)} and ${context.ltv_percent?.toFixed(0)}% LTV.`,
      risk: context.health_factor && context.health_factor < 1.3 ? `Health factor is dangerously close to liquidation — a small price move triggers forced unwinding.` : `High LTV position; leverage is elevated but not immediately at risk.`,
      next_move: `Actor may attempt to leverage further or is positioning for a liquidation opportunity.`,
      watch: `Monitor health factor below 1.05, additional borrows, and same-block liquidation events.`
    };
  } else if (context.event_type.includes('Curve Large Swap')) {
    return {
      summary: `A massive swap was detected in a Curve pool, indicating large capital movement or possible stablecoin instability.`,
      risk: `High-volume swaps can de-peg stables or indicate a flight to safety before an exploit or market crash.`,
      next_move: `Actor may be withdrawing liquidity or interacting with other protocols using the swapped assets.`,
      watch: `Watch for liquidity withdrawals in Curve and borrow activity in Aave/Maker for the swapped assets.`
    };
  } else if (context.event_type.includes('Curve RampA')) {
    return {
      summary: `Admin action: The amplification coefficient (A) of a Curve pool is being adjusted over time.`,
      risk: `Changes to A modify the price curve; while often legitimate maintenance, it can be used to "slow-drain" or manipulate a pool if the admin key is compromised.`,
      next_move: `The pool's pricing efficiency for large trades will change as A ramps to its new target.`,
      watch: `Monitor for large swaps or liquidity exits while A is ramping.`
    };
  } else if (context.event_type.includes('Curve Imbalanced Withdrawal')) {
    return {
      summary: `Large imbalanced liquidity removal from a Curve pool, skewing the pool's asset ratios.`,
      risk: `Imbalanced withdrawals can be used to intentionally tilt a pool's price or as part of a sandwich/reentrancy attack.`,
      next_move: `Actor may be positioning to exploit a pricing disparity or has finished a multi-step trade.`,
      watch: `Watch for same-block swaps or interactions with other DEXs to capitalize on the pool's new ratio.`
      };
      } else if (context.event_type.includes('REENTRANCY ATTACK DETECTED')) {
      return {
        summary: `A high-confidence reentrancy signature was detected in a Curve pool: simultaneous imbalanced withdrawal and swaps in a single transaction.`,
        risk: `This is a definitive exploit pattern where the attacker manipulates pool state mid-execution to withdraw more funds than they are entitled to.`,
        next_move: `The attacker will likely bridge the stolen funds, swap to ETH/BTC via mixers, or move them to a centralized exchange.`,
        watch: `IMMEDIATE ACTION REQUIRED: Monitor for fund movements to mixers (Tornado Cash) or CEX deposit addresses.`
      };
      } else if (context.event_type.includes('Curve Large Swap')) {
    return {
      summary: `A massive amount of USDC was swapped for DAI (or vice versa) via the Maker Peg Stability Module.`,
      risk: `Extremely large PSM swaps can drain the module's collateral or indicate systemic flight from a specific stablecoin.`,
      next_move: `Actor may be using the DAI to interact with Maker vaults, or moving large capital across the DeFi ecosystem.`,
      watch: `Monitor PSM liquidity levels and any same-block interactions with the Maker protocol.`
    };
  } else if (context.event_type.includes('Maker Governance Action')) {
    return {
      summary: `MakerDAO governance parameter was updated, potentially changing fees or debt ceilings.`,
      risk: `While usually routine, unexpected governance changes can be a precursor to emergency actions or indicate a compromised administrative key.`,
      next_move: `Market participants will adjust their positions according to the new protocol parameters.`,
      watch: `Monitor for large liquidations or vault closures following the parameter change.`
    };
  } else if (context.event_type.includes('Lido Rebase Anomaly')) {
    return {
      summary: `A Lido stETH rebase event reported an unexpected ratio, either negative or significantly higher than normal.`,
      risk: `Negative rebases indicate slashing of validators, while massive positive rebases could signal a math bug or oracle failure.`,
      next_move: `If severe, users may rush to the withdrawal queue, causing secondary liquidity stress.`,
      watch: `Monitor the Lido Withdrawal Queue and stETH price on secondary markets (Curve/Uniswap).`
    };
  } else if (context.event_type.includes('Lido Large Withdrawal')) {
    return {
      summary: `A single address requested a massive withdrawal of stETH from the Lido protocol.`,
      risk: `Large withdrawals increase the exit queue time and can indicate institutional flight or a "bank run" scenario if combined with other stress signals.`,
      next_move: `Actor will wait for the withdrawal to be fulfilled, which could take days depending on the queue.`,
      watch: `Watch for same-block activity from this address and overall growth of the withdrawal queue.`
    };
  } else if (context.event_type.includes('High Impact Swap')) {
    const impact = context.priceImpact ? (context.priceImpact * 100).toFixed(2) : 'unknown';
    return {
      summary: `A single swap moved the pool price by ${impact}% — far beyond normal trading activity.`,
      risk: `Large price impact can manipulate oracle prices used by lending protocols, enabling bad debt.`,
      next_move: `Actor may follow with a borrow against the manipulated price before it corrects.`,
      watch: `Monitor for borrow events on Aave immediately after this swap for the affected asset.`
    };
  } else if (context.event_type.includes('Oracle')) {
    return {
      summary: `On-chain oracle reported a ${context.deviation?.toFixed(2)}% price deviation from expected values.`,
      risk: `Price feed instability can cause protocol mispricing, enabling undercollateralized borrows or bad debt.`,
      next_move: `If exploited, actor will borrow against the inflated price before the feed corrects.`,
      watch: `Monitor borrow events for affected assets and Chainlink divergence returning to baseline.`
    };
  }
  return {
    summary: `Suspicious activity detected on ${context.protocol}.`,
    risk: `Actor score ${context.actor_score} with ${context.recent_events} recent events suggests elevated threat level.`,
    next_move: `Monitor this address for follow-up transactions.`,
    watch: `Watch for flash loans, large borrows, or liquidation events from this address.`
  };
}

export async function interpretAlert(alert: any, env: Env): Promise<InterpretationResult> {
  const context = buildAlertContext(alert);
  const confidence = context.confidence;
  if (env.GEMINI_API_KEY) {
    try {
      const aiResult = await callGeminiAI(context, env.GEMINI_API_KEY);
      if (aiResult) {
        return { interpretation: formatInterpretation(aiResult, confidence, 'ai'), source: 'ai' };
      }
    } catch (e) {
      console.error('Gemini AI failed, falling back to rules:', e);
    }
  }
  const ruleResult = getRuleBasedInterpretation(context);
  return { interpretation: formatInterpretation(ruleResult, confidence, 'rule-based'), source: 'rule-based' };
}
