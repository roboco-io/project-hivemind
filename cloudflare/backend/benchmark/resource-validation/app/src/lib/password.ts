import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) {
    return false;
  }
  const keyBuffer = Buffer.from(keyHex, 'hex');
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  if (keyBuffer.length !== derivedKey.length) {
    return false;
  }
  return timingSafeEqual(keyBuffer, derivedKey);
}
