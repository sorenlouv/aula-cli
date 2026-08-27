/**
 * `flowValueProof` — the per-authenticator HMAC the MitID server requires
 * alongside M1 to prove the client knows both the SRP session key K *and*
 * the bound flow context (broker security context, eafe hash, reference text).
 *
 * Per `BrowserClient.__create_flow_value_proof`, the message is a comma-
 * separated string of:
 *   authenticator_session_id,
 *   authenticator_session_flow_key,
 *   client_hash,
 *   eafe_hash,
 *   sha256_hex(broker_security_context),
 *   base64(reference_text_header),
 *   base64(reference_text_body),
 *   base64(service_provider_name)
 *
 * The HMAC key prefix and output encoding differ per authenticator — those are
 * passed in by the caller.
 */

import { Buffer } from 'node:buffer';
import { hmacSha256, sha256 } from './crypto.ts';

export interface FlowProofContext {
  authenticatorSessionId: string;
  authenticatorSessionFlowKey: string;
  /** Hex of the base64-decoded `aux.coreClient.checksum`. */
  clientHash: string;
  authenticatorEafeHash: string;
  brokerSecurityContext: string;
  referenceTextHeader: string;
  referenceTextBody: string;
  serviceProviderName: string;
}

/** The unsigned message — exactly the bytes Python feeds into HMAC. */
export function buildFlowProofMessage(ctx: FlowProofContext): Buffer {
  const brokerHash = sha256(ctx.brokerSecurityContext).toString('hex');
  const refHeader = Buffer.from(ctx.referenceTextHeader, 'utf8').toString('base64');
  const refBody = Buffer.from(ctx.referenceTextBody, 'utf8').toString('base64');
  const spName = Buffer.from(ctx.serviceProviderName, 'utf8').toString('base64');
  const joined = [
    ctx.authenticatorSessionId,
    ctx.authenticatorSessionFlowKey,
    ctx.clientHash,
    ctx.authenticatorEafeHash,
    brokerHash,
    refHeader,
    refBody,
    spName,
  ].join(',');
  return Buffer.from(joined, 'utf8');
}

/**
 * Sign the flow-proof message with a key derived from `prefix + hex(K)`,
 * hex-encoded — every live path uses hex. (The removed APP `/complete` path
 * was the one consumer of a base64 proof.)
 *
 * `prefix` is the only reason this is a parameter rather than a constant, and
 * only one caller is left: the APP `/prove` path, which passes 'flowValues'.
 * The removed kodeviser path passed 'OTP' + the six digits, which is why the
 * prefix exists at all — it is where the value being proved enters the key.
 *
 * The Python reference derives the key in two slightly different ways across
 * authenticators (one calls `m.digest()`, the other `hex_to_bytes(m.hexdigest())`)
 * but those produce the same 32 bytes, so we just take the digest.
 */
export function signFlowValueProof(message: Buffer, K: Buffer, prefix: string): string {
  const keyMaterial = Buffer.from(prefix + K.toString('hex'), 'utf8');
  const hmacKey = sha256(keyMaterial);
  return hmacSha256(hmacKey, message).toString('hex');
}
