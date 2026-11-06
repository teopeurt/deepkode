import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Minimal JSON-RPC 2.0 client over a child's stdio, one JSON object per line (Spec C §4.1). */
export class StdioRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  onNotification: (method: string, params: unknown) => void = () => {};

  constructor(cmd = "deepcode-app-server", args: string[] = []) {
    this.child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (d) => this.onData(String(d)));
    this.child.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("app-server exited"));
      this.pending.clear();
    });
  }
  private onData(s: string) {
    this.buf += s;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!; this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result);
      } else if (msg.method) this.onNotification(msg.method, msg.params);
    }
  }
  call<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  close() { this.child.kill(); }
}
