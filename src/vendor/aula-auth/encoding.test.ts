import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
  base64url,
  bigIntToBytesBE,
  bytesToBigIntBE,
  hexToBigInt,
  hexToBytes,
} from './encoding.ts';

describe('base64url', () => {
  test('encodes "Man" → "TWFu" (RFC 4648 §10)', () => {
    expect(base64url.encode('Man')).toBe('TWFu');
  });

  test('uses - and _ instead of + and /', () => {
    // bytes 0x03 0xec 0xff 0xe0 0xc1 → standard base64 "A+z/4ME=" → url-safe "A-z_4ME"
    const buf = Buffer.from([0x03, 0xec, 0xff, 0xe0, 0xc1]);
    expect(base64url.encode(buf)).toBe('A-z_4ME');
  });

  test('strips padding on encode', () => {
    expect(base64url.encode('any carnal pleasure.')).toBe('YW55IGNhcm5hbCBwbGVhc3VyZS4');
  });
});

describe('hex helpers', () => {
  test('hexToBytes decodes', () => {
    expect(hexToBytes('deadbeef').equals(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe(true);
  });

  test('hexToBytes throws on odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow();
  });
});

describe('bigInt helpers', () => {
  test('bigIntToBytesBE pads to fixed length', () => {
    expect(bigIntToBytesBE(0x1234n, 4)).toEqual(Buffer.from([0x00, 0x00, 0x12, 0x34]));
  });

  test('bigIntToBytesBE throws when value overflows', () => {
    expect(() => bigIntToBytesBE(0x100n, 1)).toThrow();
  });

  test('bytesToBigIntBE inverts bigIntToBytesBE', () => {
    const original = (1n << 200n) + 12345n;
    const bytes = bigIntToBytesBE(original, 32);
    expect(bytesToBigIntBE(bytes)).toBe(original);
  });

  test('hexToBigInt parses hex', () => {
    expect(hexToBigInt('deadbeefcafebabe1234567890')).toBe(0xdeadbeefcafebabe1234567890n);
    expect(hexToBigInt('')).toBe(0n);
  });
});
