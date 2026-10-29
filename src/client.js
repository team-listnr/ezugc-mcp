import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL =
  process.env.EZUGC_API_BASE_URL || "https://api.ezugc.ai";
const CONFIG_PATH = path.join(os.homedir(), ".ezugc", "config.json");

// Single source of truth for the in-app page where users sign in and generate
// an API key. Sourced from the production app origin (https://app.ezugc.ai,
// used across backend auth callbacks and the marketing site) + the dashboard
// key-generation route.
export const DASHBOARD_KEY_URL = "https://app.ezugc.ai/dashboard/apps/mcp";

// User-facing guidance when no key is configured at all.
export const MISSING_KEY_MESSAGE = `No EzUGC API key found. Sign in at your EzUGC dashboard and generate an API key, then set EZUGC_API_KEY in your MCP client config. Get a key at ${DASHBOARD_KEY_URL}`;

// User-facing guidance when the API rejects the key (401/403). Keys are
// paid-only, so we hint that an active paid subscription is required.
export const INVALID_KEY_MESSAGE = `Your EzUGC API key is missing, invalid, or doesn't have an active subscription. EzUGC's API requires an active paid subscription — get a valid key at ${DASHBOARD_KEY_URL}`;

const readConfig = async () => {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
};

/** Resolve the configured API key from env or config, or null if unset. */
export const getApiKey = async () => {
  if (process.env.EZUGC_API_KEY?.trim()) {
    return process.env.EZUGC_API_KEY.trim();
  }
  const config = await readConfig();
  if (typeof config.apiKey === "string" && config.apiKey.trim()) {
    return config.apiKey.trim();
  }
  return null;
};

/** True when an API key is configured (used for the startup notice). */
export const hasApiKey = async () => (await getApiKey()) !== null;

/** Build the friendly "no key configured" error thrown by callApi. */
const noKeyError = () => {
  const error = new Error(MISSING_KEY_MESSAGE);
  error.friendly = true;
  error.userMessage = MISSING_KEY_MESSAGE;
  return error;
};

export const resolveApiKey = async () => {
  const key = await getApiKey();
  if (!key) throw noKeyError();
  return key;
};

const resolveBaseUrl = async () => {
  const config = await readConfig();
  const base =
    (typeof config.baseUrl === "string" && config.baseUrl.trim()) ||
    DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
};

/**
 * Call the EzUGC public API with the configured key. Throws an Error with a
 * `.payload` property for non-2xx responses.
 */
export const callApi = async (pathname, options = {}) => {
  const [baseUrl, apiKey] = await Promise.all([resolveBaseUrl(), getApiKey()]);

  // No key configured: short-circuit with friendly setup guidance instead of
  // firing a guaranteed-to-fail request.
  if (!apiKey) throw noKeyError();

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 320_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-EzUGC-Agent-Channel": "mcp",
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    // Auth failures (invalid/expired key, no active subscription): return the
    // same friendly setup guidance and never leak the raw upstream body.
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      const error = new Error(INVALID_KEY_MESSAGE);
      error.status = response.status;
      error.friendly = true;
      error.userMessage = INVALID_KEY_MESSAGE;
      throw error;
    }

    const err = payload?.error;
    let rawMessage = `Request failed (${response.status})`;
    if (typeof err === "string" && err.trim()) {
      rawMessage = err.trim();
    } else if (
      err &&
      typeof err === "object" &&
      typeof err.message === "string" &&
      err.message.trim()
    ) {
      rawMessage = err.message.trim();
    } else if (typeof payload?.message === "string" && payload.message.trim()) {
      rawMessage = payload.message.trim();
    }

    // Strip env/provider/config internals before they reach the MCP host (Grok).
    const INFRA_LEAK_RE =
      /\b(?:OPENROUTER|OPENAI_API_KEY|RUNWARE_API_KEY|XAI_API_KEY|SEEDANCE2_API_KEY|GEMINI_API_KEY|FAL_KEY|SUPABASE_|STRIPE_|TELEGRAM_|environment variables|is not configured|OpenRouter|Runware|taskUUID)\b/i;
    const message = INFRA_LEAK_RE.test(rawMessage)
      ? "Generation failed. Please try again. If the issue continues, contact support."
      : rawMessage;

    const error = new Error(message);
    error.status = response.status;
    error.code =
      (typeof err?.code === "string" && err.code) ||
      (typeof payload?.code === "string" && payload.code) ||
      undefined;
    // Do not attach raw payload — tool error reporting must never dump infra.
    throw error;
  }

  return payload;
};
