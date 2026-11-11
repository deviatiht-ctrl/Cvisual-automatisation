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

  let current = String(text);
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
 * Replaces "Do Not Reply" / "Ne pas répondre" / "Pa reponn" patterns with
 * an organic engagement prompt ("répondez simplement OK").
 * Meta's anti-spam models reward replies, raising SIM trust score.
 */
export function replaceDoNotReply(text, forceEngagement = false) {
  if (!text) return '';
  const noReplyPatterns = [
    /\*?ne\s+(?:pas\s+)?r[eé]pondez\s+(?:pas\s+)?(?:[àa]\s+ce\s+(?:num[eé]ro|message))?\*?\.?/gi,
    /\*?ne\s+pas\s+r[eé]pondre[^.\n]*\*?\.?/gi,
    /\*?do\s+not\s+reply[^.\n]*\*?\.?/gi,
    /\*?no\s+reply[^.\n]*\*?\.?/gi,
    /\*?pa\s+reponn[^.\n]*\*?\.?/gi
  ];

  let modified = String(text);
  let replaced = false;

  for (const pattern of noReplyPatterns) {
    if (pattern.test(modified)) {
      modified = modified.replace(
        pattern,
        '💡 Pour confirmer la bonne réception, répondez simplement "OK" à ce message.'
      );
      replaced = true;
    }
  }

  if (
    forceEngagement &&
    !replaced &&
    !modified.toLowerCase().includes('répondez simplement') &&
    !modified.toLowerCase().includes('repondez simplement')
  ) {
    modified += '\n\n💡 Pour confirmer la bonne réception, répondez simplement "OK".';
  }

  return modified;
}

/**
 * Injects randomized zero-width invisible characters between plain prose words
 * (NEVER corrupting URLs or links) so every message gets a unique SHA-256 hash.
 */
export function injectZeroWidthHash(text) {
  if (!text) return { shieldedText: '', injectedCount: 0 };
  const words = String(text).split(' ');
  let injectedCount = 0;

  const isUrlToken = (w) => /https?:\/\/|wa\.me\/|www\./i.test(w);

  const resultWords = words.map((word, index) => {
    if (index < words.length - 1 && word.length > 0 && !isUrlToken(word) && Math.random() > 0.15) {
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

  // Append an invisible stealth salt only if trailing token isn't a bare URL
  const lastWord = resultWords[resultWords.length - 1] || '';
  const endSalt = Array.from({ length: 4 })
    .map(() => ZERO_WIDTH_CHARS[Math.floor(Math.random() * ZERO_WIDTH_CHARS.length)])
    .join('');

  const suffix = isUrlToken(lastWord) ? ` ${endSalt}` : endSalt;

  return {
    shieldedText: resultWords.join(' ') + suffix,
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
 * Calculates human typing simulation duration in milliseconds (2000ms - 4000ms)
 */
export function calculateHumanTypingDuration(text, minMs = 2000, maxMs = 4000) {
  const base = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const lengthFactor = Math.min(1000, Math.floor((text?.length || 0) * 8));
  return Math.min(maxMs + 1000, base + lengthFactor);
}

/**
 * MASTER SHIELD PIPELINE
 * Applies:
 * 1. Spintax resolution
 * 2. Optional Meta Trust CTA ("Pour confirmer la réception, répondez simplement OK")
 * 3. Zero-Width Unicode Hash Shield (URL-safe)
 */
export function applySpintaxAndHashShield(rawText, options = {}) {
  const { forceEngagement = false, applyDoNotReply = forceEngagement } = options;

  const originalHash = computeSha256(rawText);

  // 1. Spintax parsing
  const spintaxParsed = parseSpintax(rawText);

  // 2. Anti-Spam Engagement CTA (applied on Slow Lane / reminders / marketing)
  const engagementText = (applyDoNotReply || forceEngagement)
    ? replaceDoNotReply(spintaxParsed, forceEngagement)
    : spintaxParsed;

  // 3. Invisible Zero-Width Polymorphic Hash Injection (safe around URLs)
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
