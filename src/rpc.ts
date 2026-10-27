export class RpcError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type RpcInit = { method?: string; body?: unknown; timeoutMs?: number };

const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

/** A pooled keep-alive socket to a peer that restarted fails once with a reset; that is safe to retry. */
function isStaleConnection(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } })?.cause;
  return err instanceof TypeError && RESET_CODES.has(cause?.code ?? "");
}

/** JSON-over-HTTP call with a hard deadline. Node's fetch reuses keep-alive connections. */
export async function rpc<T>(url: string, init: RpcInit = {}): Promise<T | undefined> {
  try {
    return await call<T>(url, init);
  } catch (err) {
    if (!isStaleConnection(err)) throw err;
    return call<T>(url, init);
  }
}

async function call<T>(url: string, init: RpcInit): Promise<T | undefined> {
  const res = await fetch(url, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 1000),
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return undefined;
  }
  if (!res.ok) throw new RpcError(`${url} -> HTTP ${res.status}`, res.status);
  return (await res.json()) as T;
}

/**
 * Resolves as soon as `needed` promises have fulfilled, or once every promise has
 * settled. Callers get a quorum answer without waiting on the slowest replica.
 */
export function quorum<T>(promises: Array<Promise<T>>, needed: number): Promise<{ ok: Array<{ index: number; value: T }>; failed: number[] }> {
  return new Promise((resolve) => {
    const ok: Array<{ index: number; value: T }> = [];
    const failed: number[] = [];
    let done = false;
    const check = () => {
      if (done) return;
      if (ok.length >= needed || ok.length + failed.length === promises.length) {
        done = true;
        resolve({ ok: [...ok], failed: [...failed] });
      }
    };
    if (promises.length === 0) check();
    promises.forEach((p, index) =>
      p.then(
        (value) => {
          ok.push({ index, value });
          check();
        },
        () => {
          failed.push(index);
          check();
        },
      ),
    );
  });
}
