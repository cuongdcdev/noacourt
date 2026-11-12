import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { Config } from "../config.js";

export type ResolverMode = "lint" | "simulate" | "resolve";
export type Runner = (
  input: string,
  mode: ResolverMode,
  textJudge: boolean,
) => Promise<unknown>;

export class WasmRunner {
  private cached?: { mtimeMs: number; size: number; hash: string };
  private sequence = 0;
  constructor(
    private config: Config,
    private injected?: Runner,
  ) {}

  async hash(): Promise<string | null> {
    try {
      const info = await stat(this.config.resolverWasm);
      if (
        this.cached?.mtimeMs !== info.mtimeMs ||
        this.cached.size !== info.size
      ) {
        this.cached = {
          mtimeMs: info.mtimeMs,
          size: info.size,
          hash: `sha256:${createHash("sha256")
            .update(await readFile(this.config.resolverWasm))
            .digest("hex")}`,
        };
      }
      return this.cached.hash;
    } catch {
      return null;
    }
  }

  async publishedHash(): Promise<string | null> {
    try {
      const value = (
        await readFile(this.config.publishedWasmHashFile, "utf8")
      ).trim();
      return /^(?:sha256:)?[a-f0-9]{64}$/i.test(value)
        ? `sha256:${value.replace(/^sha256:/i, "").toLowerCase()}`
        : null;
    } catch {
      return null;
    }
  }

  async run(
    mode: ResolverMode,
    specJson: string,
    textJudge = false,
    context?: { request_id: string; attempt: number; now: null },
  ): Promise<unknown> {
    if (!this.injected && !(await this.hash()))
      throw new Error("resolver.wasm not available yet");
    const input = JSON.stringify({
      mode,
      spec_json: specJson,
      context: context ?? {
        request_id: `sim:${++this.sequence}`,
        attempt: 1,
        now: null,
      },
    });
    if (this.injected) return this.injected(input, mode, textJudge);
    return this.spawnRunner(input, mode, textJudge);
  }

  private spawnRunner(
    input: string,
    mode: ResolverMode,
    textJudge: boolean,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const args = ["run", "-S", "http", "-S", "inherit-network"];
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH || "/usr/bin:/bin",
      };
      if ((mode === "simulate" || mode === "resolve") && textJudge) {
        env.NEAR_AI_API = this.config.nearAiApi;
        args.push("--env", "NEAR_AI_API");
      }
      args.push(this.config.resolverWasm);
      const child = spawn(this.config.wasmtimeBin, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(`resolver timed out after ${this.config.wasmTimeoutMs} ms`),
        );
      }, this.config.wasmTimeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 2_000_000) child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(
            new Error(
              `resolver exited ${code}: ${stderr.replaceAll(this.config.nearAiApi || "\0", "[redacted]")}`,
            ),
          );
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("resolver emitted invalid JSON"));
        }
      });
      child.stdin.end(input);
    });
  }
}
