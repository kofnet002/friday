/**
 * Question detection prompt — v1.1
 *
 * Called on every final transcript segment after ~1.2s of silence.
 * Target model: gemini-2.5-flash (cheap, fast, structured output).
 *
 * v1.1 — reframed around multi-utterance question reconstruction. The v1.0
 * prompt leaned on "classify the most recent utterance", which caused Gemini
 * Flash to extract only the tail when a question was split across multiple
 * Deepgram finals (e.g. "Question number two." + "Please describe a
 * situation…" + "from how you usually did things."). v1.1 passes the transcript
 * as a numbered list and instructs the model to walk backward and combine
 * utterances into one sentence.
 *
 * Kept in sync with apps/backend/app/prompts/question_detection.py.
 */

export const QUESTION_DETECTION_VERSION = '1.1.0';

export const QUESTION_DETECTION_SYSTEM_PROMPT = `You classify whether an interviewer has just finished asking the candidate a question that requires a response, and — when they have — reconstruct it.

You will receive the last 30 seconds of transcript as a numbered list of utterances in chronological order (oldest first, newest last). Deepgram splits on pauses, so ONE question often spans MULTIPLE utterances. Your job:

1. Decide whether the interviewer's most recent question is COMPLETE.
2. If yes, reconstruct the FULL question as one clean sentence by combining however many trailing utterances belong to it.

COMPLETENESS

A question IS complete (is_question: true) when the final utterance ends with:
- Clear terminal punctuation ("?", ".", "!") after an interrogative phrase
- A well-formed request: "tell me about...", "walk me through...", "describe...", "explain...", "can you share...", "how would you...", "what would happen if...", "design a...", "implement...", "walk me through...", etc.

A question IS NOT complete (is_question: false) when:
- The final utterance trails off with no terminal punctuation, a conjunction/preposition ("and", "or", "but", "with", "for", "to"), or a dangling modifier — the interviewer is mid-sentence
- The interviewer is explaining, giving context, or making small talk
- It's acknowledgment / filler: "okay", "right", "got it", "makes sense"
- The utterance is a statement with no implicit ask

RECONSTRUCTION

When is_question is true, \`extracted_question\` MUST be the FULL question, combining however many trailing utterances belong to the most recent question. Walk backward from the newest utterance and keep including utterances until you hit a clear topical boundary with older, unrelated content.

DO NOT output just the final utterance — this is the #1 failure mode. The candidate needs the complete question, not its tail.

Remove filler ("um", "uh", "like", "you know"), collapse split phrasing, but DO NOT add information that wasn't spoken.

EXAMPLE (multi-utterance reconstruction — follow this pattern)

Input transcript:
[1] Question number two.
[2] Please describe a situation where you needed to adapt a process, procedure, or technology differently
[3] from how you usually did things.

Correct output:
{
  "is_question": true,
  "extracted_question": "Please describe a situation where you needed to adapt a process, procedure, or technology differently from how you usually did things.",
  "confidence": 0.95,
  "reasoning": "Three utterances reconstructed; 'Question number two' is a prefix label"
}

Incorrect (the failure mode to avoid):
"extracted_question": "from how you usually did things"

EXAMPLE (incomplete — do not fire)

Input transcript:
[1] So I saw on your resume that you worked on an ML platform and
[2] I'm curious about

Correct output:
{
  "is_question": false,
  "extracted_question": null,
  "confidence": 0.9,
  "reasoning": "Trails off mid-phrase after 'curious about'"
}

CONFIDENCE SCALE

- 0.9+: Clearly complete, clearly directed at the candidate, terminal punctuation present
- 0.7-0.89: Likely complete question but minor ambiguity
- below 0.7: Do not emit is_question=true

OUTPUT

Return ONLY a JSON object, no markdown fences, no prose:

{
  "is_question": boolean,
  "extracted_question": string | null,
  "confidence": number,
  "reasoning": string
}

Keep \`reasoning\` under 15 words. It is used only for debugging.`;

export const QUESTION_DETECTION_USER_TEMPLATE = (utterances: readonly string[]): string => {
  if (utterances.length === 0) {
    return "Last 30 seconds of transcript: (empty)\n\nClassify the interviewer's most recent question.";
  }
  const listing = utterances.map((text, i) => `[${i + 1}] ${text}`).join('\n');
  return `Last 30 seconds of transcript (numbered utterances, oldest first):

${listing}

Classify the interviewer's most recent question and reconstruct it if complete.`;
};

/**
 * Example inputs and expected outputs — used in tests and for tuning.
 */
export const QUESTION_DETECTION_EXAMPLES = [
  {
    input: [
      'Question number two.',
      'Please describe a situation where you needed to adapt a process, procedure, or technology differently',
      'from how you usually did things.',
    ],
    expected: {
      is_question: true,
      extracted_question:
        'Please describe a situation where you needed to adapt a process, procedure, or technology differently from how you usually did things.',
      confidence: 0.95,
    },
  },
  {
    input: ['So I saw on your resume that you worked on an ML platform and', "I'm curious about"],
    expected: {
      is_question: false,
      extracted_question: null,
      confidence: 0.9,
    },
  },
  {
    input: [
      'Okay. How would you design a rate limiter for an API that needs to handle a million requests per second?',
    ],
    expected: {
      is_question: true,
      extracted_question:
        'How would you design a rate limiter for an API that needs to handle a million requests per second?',
      confidence: 0.98,
    },
  },
  {
    input: ['Walk me through', 'what happens when I type google.com into a browser.'],
    expected: {
      is_question: true,
      extracted_question: 'Walk me through what happens when I type google.com into a browser.',
      confidence: 0.97,
    },
  },
  {
    input: ["Right, yeah, that's a fair point."],
    expected: {
      is_question: false,
      extracted_question: null,
      confidence: 0.95,
    },
  },
] as const;

export const QUESTION_DETECTION_CONFIG = {
  model: 'gemini-2.5-flash',
  temperature: 0.1,
  max_output_tokens: 256,
  response_mime_type: 'application/json',
  min_confidence_to_emit: 0.7,
  silence_threshold_ms: 1200,
  transcript_window_seconds: 30,
} as const;
