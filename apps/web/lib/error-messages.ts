/**
 * Map raw provider/backend error strings to user-actionable messages.
 *
 * Stack traces and provider URLs never belong in the UI — they leak
 * implementation detail and overwhelm the user. This util collapses the
 * common cases into a one-liner and keeps the original around in `cause`
 * for the developer console.
 */

export interface FriendlyError {
  text: string;
  hint?: string;
  cause?: string;
}

export function friendlyError(raw: string | null | undefined): FriendlyError {
  const cause = raw?.trim() ?? '';
  if (!cause) {
    return { text: 'Something went wrong.' };
  }

  const lower = cause.toLowerCase();

  // Quota / rate limits
  if (/insufficient_quota|insufficient quota/.test(lower)) {
    return {
      text: 'OpenAI account has no credits.',
      hint: 'Add a payment method at platform.openai.com/account/billing.',
      cause,
    };
  }
  if (/resource_exhausted|429.*quota|generate_content_free_tier_requests/.test(lower)) {
    return {
      text: 'Gemini quota exhausted.',
      hint: 'Wait for the daily reset, switch model, or add billing in AI Studio.',
      cause,
    };
  }
  if (/rate.?limit|429/.test(lower)) {
    return {
      text: 'Rate limit hit.',
      hint: 'Wait ~60s and retry, or switch provider.',
      cause,
    };
  }

  // Auth
  if (/invalid api key|invalid_api_key|unauthorized|401/.test(lower)) {
    if (/deepgram/.test(lower)) {
      return {
        text: 'Deepgram API key invalid.',
        hint: 'Check DEEPGRAM_API_KEY in your backend .env.',
        cause,
      };
    }
    if (/gemini|google/.test(lower)) {
      return {
        text: 'Gemini API key invalid.',
        hint: 'Check GEMINI_API_KEY in your backend .env.',
        cause,
      };
    }
    if (/openai/.test(lower)) {
      return {
        text: 'OpenAI API key invalid.',
        hint: 'Check OPENAI_API_KEY in your backend .env.',
        cause,
      };
    }
    return {
      text: 'API key rejected.',
      hint: 'Check the corresponding *_API_KEY in your backend .env.',
      cause,
    };
  }

  // Connectivity
  if (/econnrefused|connection refused|fetch failed|networkerror/.test(lower)) {
    return {
      text: "Can't reach the backend.",
      hint: 'Is `pnpm dev` running? The backend should be on :8000.',
      cause,
    };
  }
  if (/websocket error/.test(lower)) {
    return {
      text: 'WebSocket dropped.',
      hint: 'Auto-reconnects on next user action; try clicking Start again.',
      cause,
    };
  }

  // Audio
  if (/no display|screen recording|capturesaudio|sckit|sccontentfilter/.test(lower)) {
    return {
      text: 'Screen / system-audio capture failed.',
      hint: 'System Settings → Privacy & Security → Screen & System Audio Recording, enable Friday, then restart.',
      cause,
    };
  }
  if (/no audio|empty audio|audio_seconds=0|silent/.test(lower)) {
    return {
      text: 'No system audio detected.',
      hint: 'Make sure something is actually playing (Mac mute / app volume).',
      cause,
    };
  }

  // Limits we ourselves emit
  if (/session token limit|session audio limit/.test(lower)) {
    return {
      text: cause,
      hint: 'Bump the limit in your .env (SESSION_TOKEN_LIMIT / SESSION_AUDIO_MINUTE_LIMIT).',
    };
  }

  // Default — surface the raw text but mark it as the cause so the UI can
  // dim it. Clamp length so giant provider tracebacks don't blow out layout.
  return { text: cause.length > 240 ? cause.slice(0, 240) + '…' : cause, cause };
}
