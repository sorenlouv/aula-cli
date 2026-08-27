import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hmacSha256,
  randomBase64Url,
  randomBytes,
  sha256,
} from './crypto.ts';

describe('sha256', () => {
  // FIPS 180-2 test vector
  test('SHA-256("abc")', () => {
    expect(sha256('abc').toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('SHA-256(empty)', () => {
    expect(sha256('').toString('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('hmacSha256', () => {
  // RFC 4231 test case 1
  test('Key=0x0b×20, Data="Hi There"', () => {
    const key = Buffer.alloc(20, 0x0b);
    expect(hmacSha256(key, 'Hi There').toString('hex')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });
});

describe('aes-256-gcm', () => {
  test('encrypt → decrypt roundtrip', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const plaintext = Buffer.from('hello mitid', 'utf8');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, plaintext);
    expect(aesGcmDecrypt(key, iv, ciphertext, tag).equals(plaintext)).toBe(true);
  });

  test('decrypt fails when tag is tampered', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, Buffer.from('secret'));
    const firstByte = tag[0] ?? 0;
    tag[0] = (firstByte ^ 0x01) & 0xff;
    expect(() => aesGcmDecrypt(key, iv, ciphertext, tag)).toThrow();
  });
});

describe('random helpers', () => {
  test('randomBytes returns the requested length', () => {
    expect(randomBytes(16).length).toBe(16);
    expect(randomBytes(64).length).toBe(64);
  });

  test('randomBase64Url is URL-safe and has no padding', () => {
    const s = randomBase64Url(32);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBe(43);
  });
});
