export interface Env {
  GEMINI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  RPC_URL: string;
  DEFI_WATCH_KV: KVNamespace;
}

export interface ActorEvent {
  description: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

export interface ActorRecord {
  score: number;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  recentEvents: ActorEvent[];
  confirmedExtractions?: number;
  totalExtractedUsd?: number;
}
