import { describe, it, expect } from "vitest";
import { renderRules } from "../src/spec/render.js";
import { prelint } from "../src/spec/prelint.js";
import { examples } from "../src/guide.js";
import { sha256 } from "../src/spec/canonical.js";

describe("canonical rules and prelint", () => {
  it("produces identical bytes and hashes regardless of key order", () => {
    const a = renderRules(examples.A1);
    const reversed = Object.fromEntries(Object.entries(examples.A1).reverse());
    const b = renderRules(reversed);
    expect(a).toEqual(b);
    expect(a.rules_text_hash).toBe(sha256(a.rules_markdown));
    expect(a.spec_hash).toBe(sha256(a.spec_json));
    expect(a.spec_json).toContain('"rules_text_hash"');
  });
  it("renders source labels, operators, buckets, and URL-only identity", () => {
    const rules = renderRules({
      ...examples.A6,
      sources: [
        {
          ...(examples.A6.sources[0] as object),
          identity: "url_only",
          expect: { status: 200, assert: [] },
        },
      ],
    }).rules_markdown;
    expect(rules).toContain("self-declared, may be controlled by the creator");
    expect(rules).toContain("identity is based on the URL only");
    expect(rules).toContain("greater than or equal");
    expect(renderRules(examples.A1).rules_markdown).toContain("verified");
    expect(renderRules(examples.A2).rules_markdown).toContain(
      "half-open intervals [lower, upper)",
    );
  });
  it("rejects malformed specs and invalid outcomes", () => {
    expect(prelint("{")).toMatchObject({ ok: false });
    expect(prelint({ ...examples.A1, outcomes: ["Only"] }).errors[0]).toContain(
      "outcomes",
    );
    expect(prelint(examples.A1).ok).toBe(true);
  });
});
