import { constants, createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';

export function redactKnownTokens(text: string, ...auth: unknown[]) {
  const tokens = new Set<string>();
  for (const value of auth) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (record.tokens && typeof record.tokens === 'object') {
      for (const token of Object.values(record.tokens)) {
        if (typeof token === 'string' && token) tokens.add(token);
      }
    }
    if (typeof record.OPENAI_API_KEY === 'string' && record.OPENAI_API_KEY) tokens.add(record.OPENAI_API_KEY);
  }
  for (const token of [...tokens].sort((a, b) => b.length - a.length)) text = text.replaceAll(token, '[REDACTED]');
  return text;
}

export function sealAuth(auth: string, publicKey: string) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('hivemind-phase0-auth-return-v1'));
  const ciphertext = Buffer.concat([cipher.update(auth, 'utf8'), cipher.final()]);
  const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return {
    version: 1 as const,
    wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
