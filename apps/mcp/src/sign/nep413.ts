// Node-only NEP-413 helpers (digest + ed25519 signing from a seed). Used by tests and the
// e2e/publish "stub wallet"; the browser delegates signing to the wallet. Layout matches Noa's
// verifier: sha256(borsh{tag 2^31+413, message, nonce[32], recipient, callbackUrl: None}).
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
} from "node:crypto";
import { base58Decode } from "./page/noaPublish.js";

export const NEP413_TAG = 2147484061;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(buf: Uint8Array): string {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

const borshString = (value: string) => {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
};

export function nep413Digest(
  message: string,
  nonce: Uint8Array,
  recipient: string,
): Buffer {
  if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  return createHash("sha256")
    .update(
      Buffer.concat([
        tag,
        borshString(message),
        Buffer.from(nonce),
        borshString(recipient),
        Buffer.from([0]),
      ]),
    )
    .digest();
}

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Parse `ed25519:<base58>` (64-byte seed||pub or 32-byte seed). Never log the result. */
export function parseSecretKey(secret: string) {
  if (!secret.startsWith("ed25519:"))
    throw new Error("only ed25519 keys are supported");
  const raw = base58Decode(secret.slice(8));
  if (raw.length !== 64 && raw.length !== 32)
    throw new Error("unexpected secret key length");
  const seed = Buffer.from(raw.subarray(0, 32));
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  return {
    privateKey,
    publicKey: `ed25519:${base58Encode(spki.subarray(SPKI_PREFIX.length))}`,
  };
}

/** A signMessage function for noaPublish backed by an in-memory key. */
export function keySigner(accountId: string, secret: string) {
  const key = parseSecretKey(secret);
  return async (params: {
    message: string;
    recipient: string;
    nonce: Uint8Array;
  }) => ({
    accountId,
    publicKey: key.publicKey,
    signature: edSign(
      null,
      nep413Digest(params.message, params.nonce, params.recipient),
      key.privateKey,
    ).toString("base64"),
  });
}
