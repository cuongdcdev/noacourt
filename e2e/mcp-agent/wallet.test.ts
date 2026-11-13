import assert from "node:assert/strict";
import test from "node:test";
import {
  actionArgsBytes,
  decimalToBaseUnits,
  extractSignId,
} from "./wallet.js";

test("extracts a sign ID from a URL or bare ID", () => {
  assert.equal(extractSignId("abc_123"), "abc_123");
  assert.equal(
    extractSignId("https://example.test/sign/abc_123?x=1"),
    "abc_123",
  );
  assert.throws(() => extractSignId("https://example.test/other/abc_123"));
});

test("converts decimal NPOINT exactly", () => {
  assert.equal(
    decimalToBaseUnits("1.000000000000000001"),
    1000000000000000001n,
  );
  assert.equal(decimalToBaseUnits("0.01"), 10000000000000000n);
  assert.throws(() => decimalToBaseUnits("0.0000000000000000001"));
  assert.throws(() => decimalToBaseUnits("1e2"));
});

test("converts wallet-selector FunctionCall args without changing bytes", () => {
  const json = { spec_json: "hello", count: 2 };
  assert.deepEqual(actionArgsBytes(json), Buffer.from(JSON.stringify(json)));
  const bytes = Uint8Array.from([0, 1, 255]);
  assert.equal(actionArgsBytes(bytes), bytes);
  assert.deepEqual(
    actionArgsBytes(Buffer.from(bytes).toString("base64")),
    Buffer.from(bytes),
  );
  assert.throws(() => actionArgsBytes("not base64!"));
});
