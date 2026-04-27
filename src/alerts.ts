export function normalizeAlert(a: any) {
  if (!a || typeof a !== 'object') return null;

  // Strict requirement check
  if (!a.type || !a.title || !a.severity) {
    return null;
  }

  const type = String(a.type);
  const title = String(a.title);
  const severity = String(a.severity);
  const blockNumber = a.blockNumber || 0;
  const txHash = a.txHash || "N/A";
  
  // Ensure timestamp is ISO string
  let timestampISO: string;
  try {
    const ts = a.timestamp || Date.now();
    timestampISO = new Date(ts).toISOString();
  } catch (e) {
    timestampISO = new Date().toISOString();
  }
  
  // Data contains all other fields
  const { 
    type: _t, title: _ti, severity: _s, blockNumber: _bn, txHash: _tx, timestamp: _ts,
    ...rest 
  } = a;

  return {
    type,
    title,
    severity,
    data: rest || {},
    blockNumber,
    txHash,
    timestamp: timestampISO,
    created_at: new Date().toISOString()
  };
}
