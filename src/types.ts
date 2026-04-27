export interface Env {
  GEMINI_API_KEY?: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RPC_URL: string;
}

export interface ActorEvent {
  description: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

export interface ActorRecord {
  address?: string;
  score: number;
  firstSeen: number; // Mapping: firstSeen might not be in the table but let's see. 
  // User didn't specify firstSeen in actor_memory columns. 
  // columns: address, score, event_count, confirmed_extractions, total_extracted_usd, last_seen, recent_events (jsonb)
  lastSeen: number; 
  eventCount: number;
  recentEvents: ActorEvent[];
  confirmedExtractions?: number;
  totalExtractedUsd?: number;
}
