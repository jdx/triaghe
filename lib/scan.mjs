/**
 * Heuristic flags for content that is trying to talk to an agent rather than to
 * a maintainer.
 *
 * This is a display aid and a hint to the drafting agent. It is NOT a security
 * boundary — the actual protections are that ingest runs no model, the drafter
 * has no write or exec tools, and nothing reaches GitHub without a human
 * approving the exact text. Assume a determined attacker evades every pattern
 * below and make sure that still doesn't matter.
 */

const PATTERNS = [
  [/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i, 'instruction-override'],
  [/disregard\s+(all\s+)?(previous|prior|the\s+above)/i, 'instruction-override'],
  [/\b(system|developer)\s*(prompt|message)\b/i, 'prompt-probe'],
  [/you\s+are\s+(now\s+)?(an?\s+)?(ai|assistant|agent|chatbot)\b/i, 'role-reassignment'],
  [/\b(as|act)\s+an?\s+(ai|agent|assistant)\b.{0,40}\b(you\s+must|instead)\b/i, 'role-reassignment'],
  [/<\s*\/?\s*(system|assistant|user|im_start|im_end)\b/i, 'fake-chat-delimiter'],
  [/\[\s*(system|assistant|instructions?)\s*\]/i, 'fake-chat-delimiter'],
  [/\b(api[_\s-]?key|access[_\s-]?token|secret[_\s-]?key|password|credential)s?\b/i, 'credential-mention'],
  [/\b(GITHUB_TOKEN|GH_TOKEN|AWS_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b/, 'credential-mention'],
  [/\bcurl\b[^\n]{0,120}\|\s*(ba)?sh\b/i, 'pipe-to-shell'],
  [/\b(rm\s+-rf|chmod\s+\+x|nc\s+-e|base64\s+-d\s*\|)/i, 'dangerous-shell'],
  [/\b(exfiltrat|send\s+(me\s+)?(the|your)\s+(token|key|secret|env))/i, 'exfiltration-language'],
  [/\bcat\s+(~\/)?\.(env|ssh|aws|netrc|npmrc)\b/i, 'local-secret-read'],
  [/\b(process\.env|os\.environ)\b/, 'env-access'],
  [/\bopen\s+a\s+(pull\s+request|pr)\b.{0,60}\b(without|do\s+not)\s+(asking|review)/i, 'autonomy-push'],
];

/** Zero-width and bidi characters used to hide text from a human reader. */
const HIDDEN = /[​-‏‪-‮⁠-⁤﻿]/;

export function scanUntrusted(...texts) {
  const flags = new Set();
  for (const text of texts) {
    if (!text) continue;
    for (const [re, flag] of PATTERNS) if (re.test(text)) flags.add(flag);
    if (HIDDEN.test(text)) flags.add('hidden-characters');
  }
  return [...flags];
}
