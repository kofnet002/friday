/**
 * Question detection prompt — v1
 *
 * Purpose: classify whether the most recent interviewer utterance constitutes
 * something the candidate should respond to, and extract it cleanly.
 *
 * Called on every final transcript segment after 800ms of silence.
 * Target model: gemini-2.5-flash (cheap, fast, structured output).
 *
 * Design notes:
 * - We pass the LAST 30s of transcript, not just the newest segment. Interviewers
 *   often split questions across multiple utterances ("So... tell me about a time...
 *   uh, where you had to deal with a difficult teammate.").
 * - We explicitly handle indirect questions and requests ("walk me through...",
 *   "tell me about...", "describe...") because these don't end in "?" but ARE
 *   questions.
 * - We reject mid-thought utterances to avoid firing on partial questions.
 * - Structured JSON output with a strict schema — no prose, no markdown fences.
 */

export const QUESTION_DETECTION_VERSION = '1.0.0';

export const QUESTION_DETECTION_SYSTEM_PROMPT = `You are a classifier that decides whether an interviewer has just finished asking the candidate something that requires a response.

You will receive the last 30 seconds of interview transcript. Your job: determine if the most recent utterance is a COMPLETE question or request directed at the candidate.

RULES

Classify as a question (is_question: true) if the interviewer:
- Asks a direct question ending in "?" or with clear interrogative structure
- Makes an indirect request for information: "tell me about...", "walk me through...", "describe...", "explain...", "can you share..."
- Poses a hypothetical or technical prompt: "how would you...", "what would happen if...", "imagine..."
- Asks a coding/design question: "implement...", "design a system that...", "write a function..."
- Issues a follow-up probe: "why?", "and then what?", "can you go deeper?"

Classify as NOT a question (is_question: false) if:
- The utterance is incomplete — trails off, interrupted, or clearly mid-thought
- The interviewer is explaining something, giving context, or making small talk
- The interviewer is responding to the candidate's previous answer without asking anything new
- It's a filler or acknowledgment: "got it", "makes sense", "okay", "right"
- It's a statement of fact or opinion with no implicit ask

EXTRACTION

If is_question is true, extract the question as the interviewer would have ideally phrased it in one clean sentence. Remove filler ("um", "uh", "like"), consolidate split phrasing, but DO NOT add information that wasn't said.

CONFIDENCE

- 0.9+: Unambiguous question, clearly complete, clearly directed at candidate
- 0.7-0.89: Likely a question but some ambiguity (trailing intonation, could be mid-thought)
- 0.5-0.69: Borderline — only use if phrasing strongly implies a request
- Below 0.5: Don't emit is_question=true

OUTPUT FORMAT

Respond with ONLY a JSON object, no markdown fences, no prose. Schema:

{
  "is_question": boolean,
  "extracted_question": string | null,
  "confidence": number,
  "reasoning": string
}

"reasoning" is a single short sentence (<15 words) explaining your call. Used for debugging only.`;

export const QUESTION_DETECTION_USER_TEMPLATE = (
  transcript: string,
): string => `Last 30 seconds of transcript:

---
${transcript}
---

Classify the most recent utterance.`;

/**
 * Example inputs and expected outputs — used in tests and for tuning.
 */
export const QUESTION_DETECTION_EXAMPLES = [
  {
    input:
      'So, I saw on your resume you worked on an ML platform. Tell me about a challenging technical decision you had to make there.',
    expected: {
      is_question: true,
      extracted_question:
        'Tell me about a challenging technical decision you had to make while working on the ML platform.',
      confidence: 0.95,
    },
  },
  {
    input:
      "Great, that makes sense. Um, so the reason I ask is that we've been dealing with similar scaling problems on our side and",
    expected: {
      is_question: false,
      extracted_question: null,
      confidence: 0.9,
    },
  },
  {
    input:
      'Okay. How would you design a rate limiter for an API that needs to handle a million requests per second?',
    expected: {
      is_question: true,
      extracted_question:
        'How would you design a rate limiter for an API that needs to handle a million requests per second?',
      confidence: 0.98,
    },
  },
  {
    input: "Right, yeah, that's a fair point.",
    expected: {
      is_question: false,
      extracted_question: null,
      confidence: 0.95,
    },
  },
  {
    input: 'Walk me through what happens when I type google.com into a browser.',
    expected: {
      is_question: true,
      extracted_question: 'Walk me through what happens when I type google.com into a browser.',
      confidence: 0.97,
    },
  },
] as const;

export const QUESTION_DETECTION_CONFIG = {
  model: 'gemini-2.5-flash',
  temperature: 0.1,
  max_output_tokens: 200,
  response_mime_type: 'application/json',
  min_confidence_to_emit: 0.7,
  silence_threshold_ms: 800,
  transcript_window_seconds: 30,
} as const;
