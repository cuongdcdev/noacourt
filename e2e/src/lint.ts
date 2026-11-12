import { spawn } from "node:child_process";
import { resolve } from "node:path";

export async function lintSpec(specJson: string): Promise<any> {
  const wasm = resolve(
    import.meta.dirname,
    "../../target/wasm32-wasip2/release/resolver.wasm",
  );
  const command = process.env.WASMTIME_BIN || "/root/.wasmtime/bin/wasmtime";
  return new Promise((accept, reject) => {
    const child = spawn(command, ["run", "-S", "http", wasm], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        return reject(
          new Error(
            `wasmtime lint exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        const report = result.lint ?? result;
        if (report.ok !== true)
          return reject(
            new Error(`Spec lint failed: ${JSON.stringify(report.errors)}`),
          );
        accept(report);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(
      JSON.stringify({
        mode: "lint",
        spec_json: specJson,
        context: { request_id: "req:0", attempt: 1, now: null },
      }),
    );
  });
}
