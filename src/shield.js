import crypto from 'crypto';

/**
 * Invisible Zero-Width Unicode characters used for cryptographic hashing defense:
 * \u200B : ZERO WIDTH SPACE
 * \u200C : ZERO WIDTH NON-JOINER
 * \u200D : ZERO WIDTH JOINER
 * \uFEFF : ZERO WIDTH NO-BREAK SPACE
 */
const ZERO_WIDTH_CHARS = ['\u200B', '\u200C', '\u200D', '\uFEFF'];

/**
 * Parses spintax strings recursively.
 * Example: "{Bonjour|Salut|Bonsoir} {cher client|cher partenaire}"
 * Randomly picks one variant for each brace group.
 */
export function parseSpintax(text) {
  if (!text) return '';
  const spintaxRegex = /\{([^{}]+)\}/g;

  let current = text;
  while (spintaxRegex.test(current)) {
    current = current.replace(spintaxRegex, (match, choices) => {
      const options = choices.split('|');
      const randomIndex = Math.floor(Math.random() * options.length);
      return options[randomIndex].trim();
    });
  }
  return current;
}

/**
 * Replaces any "Do Not Reply" / "Ne pas répondre" patterns with
 * "Pour confirmer la réception, répondez simplement OK".
 * This triggers organic client engagement, causing Meta's algorithms to classify the SIM as high trust.
 */
export function replaceDoNotReply(text, forceEngagement = false) {
  if (!text) return '';
  const noReplyPatterns = [
    /ne\s+(pas\s+)?r[eé]pondez\s+pas/gi,
    /ne\s+pas\s+r[eé]pondre/gi,
    /do\s+not\s+reply/gi,
    /no\s+reply/gi,
    /pa\s+reponn/gi
  ];

  let modified = text;
  let replaced = false;

  for (const pattern of noReplyPatterns) {
    if (pattern.test(modified)) {
      modified = modified.replace(pattern, 'Pour confirmer la réception, répondez simplement OK');
      replaced = true;
    }
  }

  // If forceEngagement is true and string doesn't already contain OK prompt
  if (forceEngagement && !replaced && !modified.toLowerCase().includes('répondez simplement ok')) {
    modified += '\n\nPour confirmer la réception, répondez simplement OK.';
  }

  return modified;
}

/**
 * Injects randomized zero-width invisible characters between words.
 * Gives each message an entirely unique SHA-256 fingerprint while looking identical to humans.
 */
export function injectZeroWidthHash(text) {
  if (!text) return '';
  const words = text.split(' ');
  let injectedCount = 0;

  const resultWords = words.map((word, index) => {
    // Randomly inject 1 to 3 zero-width characters in between words
    if (index < words.length - 1 && Math.random() > 0.15) {
      const numChars = 1 + Math.floor(Math.random() * 3);
      let stealthSeq = '';
      for (let i = 0; i < numChars; i++) {
        const char = ZERO_WIDTH_CHARS[Math.floor(Math.random() * ZERO_WIDTH_CHARS.length)];
        stealthSeq += char;
        injectedCount++;
      }
      return word + stealthSeq;
    }
    return word;
  });

  // Also append a unique stealth salt at the very end of message
  const endSalt = Array.from({ length: 4 })
    .map(() => ZERO_WIDTH_CHARS[Math.floor(Math.random() * ZERO_WIDTH_CHARS.length)])
    .join('');

  return {
    shieldedText: resultWords.join(' ') + endSalt,
    injectedCount: injectedCount + 4
  };
}

/**
 * Calculates SHA-256 hash of a string
 */
export function computeSha256(text) {
  return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
}

/**
 * Calculates human typing simulation duration in milliseconds (between 2000ms and 4000ms)
 */
export function calculateHumanTypingDuration(text, minMs = 2000, maxMs = 4000) {
  const base = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  // If text is longer, add a slight organic variance
  const lengthFactor = Math.min(1000, Math.floor((text?.length || 0) * 8));
  return Math.min(maxMs + 1000, base + lengthFactor);
}

/**
 * MASTER SHIELD PIPELINE
 * Applies:
 * 1. Spintax resolution
 * 2. Meta Trust CTA ("Pour confirmer la réception, répondez simplement OK")
 * 3. Zero-Width Unicode Hash Shield
 * 
 * Returns both the original and transformed text, along with cryptographic hashes for verification.
 */
export function applySpintaxAndHashShield(rawText, options = {}) {
  const { forceEngagement = false } = options;

  const originalHash = computeSha256(rawText);

  // 1. Spintax parsing
  const spintaxParsed = parseSpintax(rawText);

  // 2. Anti-Spam Engagement CTA
  const engagementText = replaceDoNotReply(spintaxParsed, forceEngagement);

  // 3. Invisible Zero-Width Polymorphic Hash Injection
  const { shieldedText, injectedCount } = injectZeroWidthHash(engagementText);
  const shieldedHash = computeSha256(shieldedText);

  return {
    rawText,
    processedText: shieldedText,
    originalHash,
    shieldedHash,
    injectedCount,
    typingSimulationMs: calculateHumanTypingDuration(rawText)
  };
}
