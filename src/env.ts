import type { QueueMessageBody } from "./services/queue-consumer";

/** Cloudflare bindings and string variables/secrets available to the Worker. */
export interface Env {
  DB: D1Database;
  JOBS: Queue<QueueMessageBody>;

  APP_ENV?: string;
  PUBLIC_BASE_URL?: string;
  OWNER_PHONE_E164?: string;
  OWNER_DISPLAY_NAME?: string;
  OWNER_TIMEZONE?: string;
  ADMIN_BOOTSTRAP_SECRET?: string;
  DATA_ENCRYPTION_KEY?: string;
  DATA_ENCRYPTION_KEY_PREVIOUS?: string;
  SIM_WEBHOOK_SECRET?: string;
  SIMULATOR_ENABLED?: string;

  SMS_PROVIDER?: string;
  VOICE_PROVIDER?: string;
  CALENDAR_PROVIDER?: string;
  AI_PROVIDER?: string;

  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_REASONING_EFFORT?: string;

  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;
  TWILIO_MESSAGING_SERVICE_SID?: string;
  TWILIO_PROVIDER_MANAGED_KEYWORDS?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GOOGLE_EXPECTED_ACCOUNT?: string;

  SMS_LIVE_ENABLED?: string;
  SMS_ELIGIBILITY_CONFIRMED?: string;
  VOICE_LIVE_ENABLED?: string;
  AI_LIVE_ENABLED?: string;
  CALENDAR_WRITES_ENABLED?: string;
  DRY_RUN?: string;

  // ---- Extension (memory, secretary, accountability) ----
  MEDIA?: R2Bucket;
  VECTORS?: VectorizeIndex;
  CAPTURE_ENABLED?: string;
  SEMANTIC_INDEX_ENABLED?: string;
  UPLOADS_ENABLED?: string;
  MMS_INGEST_ENABLED?: string;
  IMAGE_ASSESSMENT_ENABLED?: string;
  BROWSER_TELEMETRY_ENABLED?: string;
  MORNING_ROUTINES_ENABLED?: string;
  TASK_ACCOUNTABILITY_ENABLED?: string;
  EMAIL_READ_ENABLED?: string;
  CURRENT_INFO_ENABLED?: string;
  SUGGESTIONS_ENABLED?: string;
  MEDIA_STORE?: string;
  VISION_PROVIDER?: string;
  EMBEDDING_PROVIDER?: string;
  SEMANTIC_INDEX?: string;
  EMAIL_PROVIDER?: string;
  INFO_PROVIDER?: string;
  OPENAI_VISION_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  GMAIL_REDIRECT_URI?: string;
  NWS_CONTACT?: string;
}
