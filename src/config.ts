import type { Env } from "./env";

export type AppEnv = "development" | "test" | "staging" | "production";
export type SmsProviderName = "simulated" | "twilio";
export type VoiceProviderName = "simulated" | "twilio";
export type CalendarProviderName = "simulated" | "google";
export type AiProviderName = "simulated" | "openai";

export interface ConfigIssue {
  severity: "error" | "warning";
  code: string;
  integration: "core" | "sms" | "voice" | "calendar" | "ai" | "admin" | "extension";
  message: string;
}

export interface EncryptionKey {
  id: string;
  raw: Uint8Array;
}

export interface AppConfig {
  appEnv: AppEnv;
  publicBaseUrl: string | null;
  ownerPhone: string | null;
  ownerDisplayName: string;
  ownerTimezone: string;
  adminSecret: string | null;
  encryptionKey: EncryptionKey;
  previousEncryptionKeys: EncryptionKey[];
  usingDevEncryptionKey: boolean;
  simWebhookSecret: string;
  simulatorEnabled: boolean;
  providers: {
    sms: SmsProviderName;
    voice: VoiceProviderName;
    calendar: CalendarProviderName;
    ai: AiProviderName;
  };
  openai: { apiKey: string | null; model: string; reasoningEffort: "none" | "low" | "medium" };
  twilio: {
    accountSid: string | null;
    authToken: string | null;
    phoneNumber: string | null;
    messagingServiceSid: string | null;
    providerManagedKeywords: boolean;
  };
  google: {
    clientId: string | null;
    clientSecret: string | null;
    redirectUri: string | null;
    expectedAccount: string | null;
  };
  /** Environment flags. An environment "off" always overrides any D1 setting. */
  flags: {
    smsLive: boolean;
    smsEligibilityConfirmed: boolean;
    voiceLive: boolean;
    aiLive: boolean;
    calendarWrites: boolean;
    dryRun: boolean;
  };
  /** Extension: deployment-level feature flags (false always overrides owner settings) and providers. */
  ext: {
    flags: {
      capture: boolean;
      semanticIndex: boolean;
      uploads: boolean;
      mmsIngest: boolean;
      imageAssessment: boolean;
      browserTelemetry: boolean;
      morningRoutines: boolean;
      taskAccountability: boolean;
      emailRead: boolean;
      currentInfo: boolean;
      suggestions: boolean;
    };
    mediaStore: "local" | "r2";
    vision: "simulated" | "openai";
    embeddings: "simulated" | "openai";
    semanticIndex: "d1" | "vectorize";
    email: "simulated" | "gmail";
    info: "simulated" | "nws";
    visionModel: string;
    embeddingModel: string;
    gmailRedirectUri: string | null;
    nwsContact: string | null;
  };
  issues: ConfigIssue[];
}

/** Supported inexpensive default: GPT-6 Luna (structured outputs + function calling, Responses API). */
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";

// Development-only key. Never valid outside development/test (enforced below).
const DEV_ENCRYPTION_KEY_B64 = "ZGVsbGEtZGV2LW9ubHktaW5zZWN1cmUta2V5LTMyYnk=";
const DEV_SIM_SECRET = "della-dev-sim-webhook-secret";

const PLACEHOLDER_PATTERN = /(replace|changeme|change_me|placeholder|example|dummy|your[_-]|xxxx|todo)/i;
// NANP fictional (555-01xx) and Twilio magic test numbers must never be a live destination.
const FAKE_NUMBER_PATTERN = /^\+1\d{3}555(01\d\d)$|^\+15005550\d{3}$|^\+1555/;

function str(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  const v = str(value)?.toLowerCase();
  if (v === undefined || v === null) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

export function isPlaceholder(value: string | null): boolean {
  return value === null || PLACEHOLDER_PATTERN.test(value);
}

export function isE164(value: string | null): value is string {
  return value !== null && /^\+[1-9]\d{7,14}$/.test(value);
}

export function isFakeNumber(value: string): boolean {
  return FAKE_NUMBER_PATTERN.test(value);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Accepts `BASE64` or `keyId:BASE64`; key material must be exactly 32 bytes. */
export function parseEncryptionKey(value: string, defaultId: string): EncryptionKey | null {
  const idx = value.indexOf(":");
  const id = idx > 0 ? value.slice(0, idx) : defaultId;
  const material = idx > 0 ? value.slice(idx + 1) : value;
  if (!/^[a-z0-9]{1,8}$/i.test(id)) return null;
  const raw = decodeBase64(material);
  if (!raw || raw.length !== 32) return null;
  return { id, raw };
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function loadConfig(env: Env): AppConfig {
  const issues: ConfigIssue[] = [];
  const appEnv = oneOf(str(env.APP_ENV), ["development", "test", "staging", "production"] as const, "development");
  const isLocal = appEnv === "development" || appEnv === "test";

  const rawEnv = str(env.APP_ENV);
  if (rawEnv !== null && rawEnv !== appEnv) {
    issues.push({ severity: "error", code: "app_env_invalid", integration: "core", message: "APP_ENV is not one of development|test|staging|production." });
  }

  const ownerTimezoneRaw = str(env.OWNER_TIMEZONE) ?? "America/Los_Angeles";
  const ownerTimezone = isValidTimeZone(ownerTimezoneRaw) ? ownerTimezoneRaw : "America/Los_Angeles";
  if (ownerTimezone !== ownerTimezoneRaw) {
    issues.push({ severity: "error", code: "owner_timezone_invalid", integration: "core", message: "OWNER_TIMEZONE is not a valid IANA timezone; using America/Los_Angeles." });
  }

  const ownerPhoneRaw = str(env.OWNER_PHONE_E164);
  let ownerPhone: string | null = null;
  if (ownerPhoneRaw === null) {
    issues.push({
      severity: isLocal ? "warning" : "error",
      code: "owner_phone_missing",
      integration: "core",
      message: "OWNER_PHONE_E164 is not configured. Inbound SMS cannot be attributed to the owner.",
    });
  } else if (!isE164(ownerPhoneRaw)) {
    issues.push({ severity: "error", code: "owner_phone_invalid", integration: "core", message: "OWNER_PHONE_E164 must be in E.164 format (for example +1XXXXXXXXXX)." });
  } else {
    ownerPhone = ownerPhoneRaw;
  }

  const publicBaseUrlRaw = str(env.PUBLIC_BASE_URL);
  let publicBaseUrl: string | null = null;
  if (publicBaseUrlRaw) {
    try {
      const u = new URL(publicBaseUrlRaw);
      if (!isLocal && u.protocol !== "https:") {
        issues.push({ severity: "error", code: "public_base_url_not_https", integration: "core", message: "PUBLIC_BASE_URL must use HTTPS outside local development." });
      }
      publicBaseUrl = `${u.protocol}//${u.host}`;
    } catch {
      issues.push({ severity: "error", code: "public_base_url_invalid", integration: "core", message: "PUBLIC_BASE_URL is not a valid URL." });
    }
  } else if (!isLocal) {
    issues.push({
      severity: "error",
      code: "public_base_url_missing",
      integration: "core",
      message: "PUBLIC_BASE_URL is required for webhook signature validation and callbacks.",
    });
  }

  const adminSecret = str(env.ADMIN_BOOTSTRAP_SECRET);
  if (adminSecret === null) {
    issues.push({
      severity: isLocal ? "warning" : "error",
      code: "admin_secret_missing",
      integration: "admin",
      message: "ADMIN_BOOTSTRAP_SECRET is not set; admin login is disabled.",
    });
  } else if (adminSecret.length < 24 || (!isLocal && isPlaceholder(adminSecret))) {
    issues.push({
      severity: isLocal ? "warning" : "error",
      code: "admin_secret_weak",
      integration: "admin",
      message: "ADMIN_BOOTSTRAP_SECRET should be at least 24 random characters.",
    });
  }

  let usingDevEncryptionKey = false;
  let encryptionKey: EncryptionKey | null = null;
  const keyRaw = str(env.DATA_ENCRYPTION_KEY);
  if (keyRaw) {
    encryptionKey = parseEncryptionKey(keyRaw, "k1");
    if (!encryptionKey) {
      issues.push({
        severity: "error",
        code: "encryption_key_invalid",
        integration: "core",
        message: "DATA_ENCRYPTION_KEY must be base64 for exactly 32 bytes, optionally prefixed with `keyId:`.",
      });
    }
  }
  if (!encryptionKey) {
    if (!keyRaw) {
      issues.push({ severity: isLocal ? "warning" : "error", code: "encryption_key_missing", integration: "core", message: "DATA_ENCRYPTION_KEY is not set." });
    }
    // A development key keeps local demos working; it is rejected for staging/production via the error above.
    encryptionKey = parseEncryptionKey(`dev:${DEV_ENCRYPTION_KEY_B64}`, "dev");
    usingDevEncryptionKey = true;
  }
  const previousEncryptionKeys: EncryptionKey[] = [];
  const prevRaw = str(env.DATA_ENCRYPTION_KEY_PREVIOUS);
  if (prevRaw) {
    for (const part of prevRaw.split(",")) {
      const k = parseEncryptionKey(part.trim(), "k0");
      if (k) previousEncryptionKeys.push(k);
      else issues.push({ severity: "error", code: "previous_key_invalid", integration: "core", message: "DATA_ENCRYPTION_KEY_PREVIOUS contains an invalid key." });
    }
  }
  if (usingDevEncryptionKey) {
    // Allows reading data written with the dev key after a real key is configured locally.
    const dev = parseEncryptionKey(`dev:${DEV_ENCRYPTION_KEY_B64}`, "dev");
    if (dev) previousEncryptionKeys.push(dev);
  }

  const simulatorEnabled = appEnv !== "production" && bool(env.SIMULATOR_ENABLED, isLocal);
  let simWebhookSecret = str(env.SIM_WEBHOOK_SECRET);
  if (!simWebhookSecret) {
    simWebhookSecret = DEV_SIM_SECRET;
    if (!isLocal && simulatorEnabled) {
      issues.push({
        severity: "warning",
        code: "sim_secret_default",
        integration: "core",
        message: "SIM_WEBHOOK_SECRET uses the development default while the simulator is enabled.",
      });
    }
  }

  const providers = {
    sms: oneOf(str(env.SMS_PROVIDER), ["simulated", "twilio"] as const, "simulated"),
    voice: oneOf(str(env.VOICE_PROVIDER), ["simulated", "twilio"] as const, "simulated"),
    calendar: oneOf(str(env.CALENDAR_PROVIDER), ["simulated", "google"] as const, "simulated"),
    ai: oneOf(str(env.AI_PROVIDER), ["simulated", "openai"] as const, "simulated"),
  };

  const flags = {
    smsLive: bool(env.SMS_LIVE_ENABLED, false),
    smsEligibilityConfirmed: bool(env.SMS_ELIGIBILITY_CONFIRMED, false),
    voiceLive: bool(env.VOICE_LIVE_ENABLED, false),
    aiLive: bool(env.AI_LIVE_ENABLED, false),
    calendarWrites: bool(env.CALENDAR_WRITES_ENABLED, false),
    dryRun: bool(env.DRY_RUN, true),
  };

  const twilio = {
    accountSid: str(env.TWILIO_ACCOUNT_SID),
    authToken: str(env.TWILIO_AUTH_TOKEN),
    phoneNumber: str(env.TWILIO_PHONE_NUMBER),
    messagingServiceSid: str(env.TWILIO_MESSAGING_SERVICE_SID),
    providerManagedKeywords: bool(env.TWILIO_PROVIDER_MANAGED_KEYWORDS, true),
  };
  const usesTwilio = providers.sms === "twilio" || providers.voice === "twilio";
  if (usesTwilio) {
    if (!twilio.accountSid || !/^AC[0-9a-fA-F]{32}$/.test(twilio.accountSid) || /^AC0{32}$/.test(twilio.accountSid)) {
      issues.push({
        severity: "error",
        code: "twilio_account_sid_invalid",
        integration: providers.sms === "twilio" ? "sms" : "voice",
        message: "TWILIO_ACCOUNT_SID is missing or not a valid AC… SID.",
      });
    }
    if (!twilio.authToken || isPlaceholder(twilio.authToken) || twilio.authToken.length < 32) {
      issues.push({
        severity: "error",
        code: "twilio_auth_token_invalid",
        integration: providers.sms === "twilio" ? "sms" : "voice",
        message: "TWILIO_AUTH_TOKEN is missing or looks like a placeholder.",
      });
    }
    if (!isE164(twilio.phoneNumber)) {
      issues.push({
        severity: "error",
        code: "twilio_number_invalid",
        integration: providers.sms === "twilio" ? "sms" : "voice",
        message: "TWILIO_PHONE_NUMBER must be an E.164 number owned by the Twilio account.",
      });
    }
    if (twilio.messagingServiceSid && !/^MG[0-9a-fA-F]{32}$/.test(twilio.messagingServiceSid)) {
      issues.push({ severity: "error", code: "twilio_mg_invalid", integration: "sms", message: "TWILIO_MESSAGING_SERVICE_SID must be an MG… SID when set." });
    }
    if (!publicBaseUrl) {
      issues.push({
        severity: "error",
        code: "twilio_needs_base_url",
        integration: "sms",
        message: "Twilio adapters need PUBLIC_BASE_URL to validate signatures and build callback URLs.",
      });
    }
  }

  const google = {
    clientId: str(env.GOOGLE_CLIENT_ID),
    clientSecret: str(env.GOOGLE_CLIENT_SECRET),
    redirectUri: str(env.GOOGLE_REDIRECT_URI),
    expectedAccount: str(env.GOOGLE_EXPECTED_ACCOUNT),
  };
  if (providers.calendar === "google") {
    if (!google.clientId || isPlaceholder(google.clientId)) {
      issues.push({ severity: "error", code: "google_client_id_missing", integration: "calendar", message: "GOOGLE_CLIENT_ID is missing." });
    }
    if (!google.clientSecret || isPlaceholder(google.clientSecret)) {
      issues.push({ severity: "error", code: "google_client_secret_missing", integration: "calendar", message: "GOOGLE_CLIENT_SECRET is missing." });
    }
    if (!google.redirectUri) {
      issues.push({ severity: "error", code: "google_redirect_missing", integration: "calendar", message: "GOOGLE_REDIRECT_URI is missing." });
    } else if (publicBaseUrl && !google.redirectUri.startsWith(`${publicBaseUrl}/`)) {
      issues.push({
        severity: "error",
        code: "google_redirect_mismatch",
        integration: "calendar",
        message: "GOOGLE_REDIRECT_URI must be on PUBLIC_BASE_URL (exact registered callback).",
      });
    }
  }

  const openaiModel = str(env.OPENAI_MODEL) ?? DEFAULT_OPENAI_MODEL;
  const openai = {
    apiKey: str(env.OPENAI_API_KEY),
    model: openaiModel,
    reasoningEffort: oneOf(str(env.OPENAI_REASONING_EFFORT), ["none", "low", "medium"] as const, "low"),
  };
  if (providers.ai === "openai" && (!openai.apiKey || isPlaceholder(openai.apiKey))) {
    issues.push({ severity: "error", code: "openai_key_missing", integration: "ai", message: "OPENAI_API_KEY is missing." });
  }

  // Production live-send safety: live flags never take effect with unsafe configuration.
  if (flags.smsLive && providers.sms === "twilio") {
    if (!flags.smsEligibilityConfirmed) {
      issues.push({
        severity: "error",
        code: "sms_eligibility_unconfirmed",
        integration: "sms",
        message: "SMS_LIVE_ENABLED is set but SMS_ELIGIBILITY_CONFIRMED is false. Live SMS stays off.",
      });
    }
    if (ownerPhone && isFakeNumber(ownerPhone)) {
      issues.push({ severity: "error", code: "owner_phone_fake", integration: "sms", message: "OWNER_PHONE_E164 is a fictional/test number; live SMS stays off." });
    }
  }
  if (flags.voiceLive && providers.voice === "twilio" && ownerPhone && isFakeNumber(ownerPhone)) {
    issues.push({ severity: "error", code: "owner_phone_fake_voice", integration: "voice", message: "OWNER_PHONE_E164 is a fictional/test number; live calls stay off." });
  }
  if (appEnv === "production" && bool(env.SIMULATOR_ENABLED, false)) {
    issues.push({ severity: "warning", code: "simulator_forced_off", integration: "core", message: "SIMULATOR_ENABLED is ignored in production." });
  }

  const ext: AppConfig["ext"] = {
    flags: {
      capture: bool(env.CAPTURE_ENABLED, true),
      semanticIndex: bool(env.SEMANTIC_INDEX_ENABLED, true),
      uploads: bool(env.UPLOADS_ENABLED, true),
      mmsIngest: bool(env.MMS_INGEST_ENABLED, true),
      imageAssessment: bool(env.IMAGE_ASSESSMENT_ENABLED, true),
      browserTelemetry: bool(env.BROWSER_TELEMETRY_ENABLED, true),
      morningRoutines: bool(env.MORNING_ROUTINES_ENABLED, true),
      taskAccountability: bool(env.TASK_ACCOUNTABILITY_ENABLED, true),
      emailRead: bool(env.EMAIL_READ_ENABLED, true),
      currentInfo: bool(env.CURRENT_INFO_ENABLED, true),
      suggestions: bool(env.SUGGESTIONS_ENABLED, true),
    },
    mediaStore: oneOf(str(env.MEDIA_STORE), ["local", "r2"] as const, "local"),
    vision: oneOf(str(env.VISION_PROVIDER), ["simulated", "openai"] as const, "simulated"),
    embeddings: oneOf(str(env.EMBEDDING_PROVIDER), ["simulated", "openai"] as const, "simulated"),
    semanticIndex: oneOf(str(env.SEMANTIC_INDEX), ["d1", "vectorize"] as const, "d1"),
    email: oneOf(str(env.EMAIL_PROVIDER), ["simulated", "gmail"] as const, "simulated"),
    info: oneOf(str(env.INFO_PROVIDER), ["simulated", "nws"] as const, "simulated"),
    visionModel: str(env.OPENAI_VISION_MODEL) ?? DEFAULT_OPENAI_MODEL,
    embeddingModel: str(env.OPENAI_EMBEDDING_MODEL) ?? "text-embedding-3-small",
    gmailRedirectUri: str(env.GMAIL_REDIRECT_URI),
    nwsContact: str(env.NWS_CONTACT),
  };
  if ((ext.vision === "openai" || ext.embeddings === "openai") && (!openai.apiKey || isPlaceholder(openai.apiKey))) {
    issues.push({ severity: "error", code: "openai_key_missing_ext", integration: "extension", message: "VISION_PROVIDER/EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY." });
  }
  if (ext.mediaStore === "r2" && !env.MEDIA)
    issues.push({ severity: "error", code: "r2_binding_missing", integration: "extension", message: "MEDIA_STORE=r2 requires the MEDIA R2 binding." });
  if (ext.semanticIndex === "vectorize" && !env.VECTORS)
    issues.push({ severity: "error", code: "vectorize_binding_missing", integration: "extension", message: "SEMANTIC_INDEX=vectorize requires the VECTORS binding." });
  if (ext.email === "gmail" && (!google.clientId || !google.clientSecret || !ext.gmailRedirectUri)) {
    issues.push({
      severity: "error",
      code: "gmail_oauth_missing",
      integration: "extension",
      message: "EMAIL_PROVIDER=gmail requires GOOGLE_CLIENT_ID/SECRET and GMAIL_REDIRECT_URI.",
    });
  }
  if (ext.info === "nws" && !ext.nwsContact)
    issues.push({
      severity: "error",
      code: "nws_contact_missing",
      integration: "extension",
      message: "INFO_PROVIDER=nws requires NWS_CONTACT (sent in the User-Agent, per NWS API policy).",
    });

  return {
    appEnv,
    publicBaseUrl,
    ext,
    ownerPhone,
    ownerDisplayName: str(env.OWNER_DISPLAY_NAME) ?? "Dhruv",
    ownerTimezone,
    adminSecret,
    encryptionKey: encryptionKey!,
    previousEncryptionKeys,
    usingDevEncryptionKey,
    simWebhookSecret,
    simulatorEnabled,
    providers,
    openai,
    twilio,
    google,
    flags,
    issues,
  };
}

export function configErrors(config: AppConfig, integration?: ConfigIssue["integration"]): ConfigIssue[] {
  return config.issues.filter((i) => i.severity === "error" && (integration === undefined || i.integration === integration));
}

/** True when core configuration is unsafe for a deployed environment (encryption/admin/base URL). */
export function hasFatalCoreIssue(config: AppConfig): boolean {
  if (config.appEnv === "development" || config.appEnv === "test") return false;
  return config.issues.some((i) => i.severity === "error" && (i.integration === "core" || i.integration === "admin"));
}
