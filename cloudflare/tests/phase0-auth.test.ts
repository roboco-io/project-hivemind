import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { sealAuth, redactKnownTokens } from '../scripts/phase0/auth-envelope.ts';

test('auth return envelope requires the private key and authenticates its contents', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fixture = JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'fixture-private-token' } });
  const envelope = sealAuth(fixture, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  assert.equal(JSON.stringify(envelope).includes('fixture-private-token'), false);
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from('hivemind-phase0-auth-return-v1'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString();
  assert.equal(plaintext, fixture);
  const corruptedTag = Buffer.from(envelope.tag, 'base64');
  corruptedTag[0] ^= 1;
  const tampered = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  tampered.setAAD(Buffer.from('hivemind-phase0-auth-return-v1'));
  tampered.setAuthTag(corruptedTag);
  tampered.update(Buffer.from(envelope.ciphertext, 'base64'));
  assert.throws(() => tampered.final());
});

test('known original and refreshed tokens are removed from CLI diagnostics', () => {
  const original = { tokens: { access_token: 'fixture-old-token', refresh_token: 'fixture-old-refresh' } };
  const refreshed = { tokens: { access_token: 'fixture-new-token', refresh_token: 'fixture-new-refresh' } };
  const text = 'fixture-old-token fixture-old-refresh fixture-new-token fixture-new-refresh keep-this';
  assert.equal(redactKnownTokens(text, original, refreshed), '[REDACTED] [REDACTED] [REDACTED] [REDACTED] keep-this');
});
