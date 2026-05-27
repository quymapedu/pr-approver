import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../lib/crypto";

const key = randomBytes(32);

describe("crypto", () => {
  it("round-trips plaintext", () => {
    const out = decrypt(encrypt("ghp_secret", key), key);
    expect(out).toBe("ghp_secret");
  });

  it("produces different ciphertext each call (random IV)", () => {
    expect(encrypt("x", key)).not.toBe(encrypt("x", key));
  });

  it("rejects tampered ciphertext", () => {
    const enc = encrypt("ghp_secret", key);
    const bytes = Buffer.from(enc, "base64");
    bytes[bytes.length - 1] ^= 0xff; // flip a byte in the ciphertext
    expect(() => decrypt(bytes.toString("base64"), key)).toThrow();
  });

  it("rejects a wrong-length key", () => {
    expect(() => encrypt("x", Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});
