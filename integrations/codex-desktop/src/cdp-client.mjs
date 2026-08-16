function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isLoopbackWebSocketUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "ws:" || url.protocol === "wss:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => this.#handleMessage(event.data));
    socket.addEventListener("close", () => this.#rejectPending("CDP target closed"));
    socket.addEventListener("error", () => this.#rejectPending("CDP socket failed"));
  }

  static async connect(webSocketUrl, { timeoutMs = 5_000 } = {}) {
    if (!isLoopbackWebSocketUrl(webSocketUrl)) {
      throw new Error("Refusing a non-loopback CDP WebSocket URL");
    }
    if (typeof WebSocket !== "function") {
      throw new Error("Token Meter requires Node.js 22.13 or newer for WebSocket support");
    }

    const socket = new WebSocket(webSocketUrl);
    const opened = new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Unable to connect to the desktop CDP target")),
        { once: true },
      );
    });
    await withTimeout(
      opened,
      timeoutMs,
      "Timed out connecting to the desktop CDP target",
    );
    return new CdpClient(socket);
  }

  async call(method, params = {}, { timeoutMs = 5_000 } = {}) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return withTimeout(
      response,
      timeoutMs,
      `CDP method timed out: ${method}`,
    ).finally(() => this.pending.delete(id));
  }

  async evaluate(expression) {
    const response = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "Desktop renderer evaluation failed",
      );
    }
    return response.result?.value;
  }

  close() {
    this.socket.close();
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id == null) return;
    const pending = this.pending.get(message.id);
    if (pending == null) return;
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "CDP request failed"));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  #rejectPending(message) {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }
}
