import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';

export type FaultMode =
  | 'pass-through'
  | 'drop-request'
  | 'drop-response-after-forward'
  | 'delay'
  | 'return-500'
  | 'close-mid-body';

export interface ProxyOptions {
  mode?: FaultMode;
  delayMs?: number;
}

export class FaultProxy {
  private server: http.Server | null = null;
  private currentMode: FaultMode = 'pass-through';
  private delayMs: number = 0;
  private targetHost: string;
  private targetPort: number;
  private port: number = 0;

  constructor(targetUrl: string, initialMode: FaultMode = 'pass-through') {
    const parsed = new URL(targetUrl);
    this.targetHost = parsed.hostname;
    this.targetPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    this.currentMode = initialMode;
  }

  public setMode(mode: FaultMode, options?: { delayMs?: number }) {
    this.currentMode = mode;
    this.delayMs = options?.delayMs || 0;
  }

  public getMode(): FaultMode {
    return this.currentMode;
  }

  public async start(listenPort: number = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(listenPort, '127.0.0.1', () => {
        const addr = this.server!.address() as net.AddressInfo;
        this.port = addr.port;
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  public getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private handleRequest(clientReq: IncomingMessage, clientRes: ServerResponse) {
    // Management endpoint for runtime switching
    if (clientReq.url === '/__proxy/mode' && clientReq.method === 'POST') {
      let body = '';
      clientReq.on('data', (chunk) => (body += chunk));
      clientReq.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          this.setMode(parsed.mode, { delayMs: parsed.delayMs });
          clientRes.writeHead(200, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ ok: true, mode: this.currentMode }));
        } catch (e: any) {
          clientRes.writeHead(400, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    const mode = this.currentMode;

    if (mode === 'drop-request') {
      clientReq.destroy();
      return;
    }

    if (mode === 'return-500') {
      clientRes.writeHead(500, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { message: 'FaultProxy simulated 500 error' } }));
      return;
    }

    const dispatchForward = () => {
      const headers = { ...clientReq.headers, host: `${this.targetHost}:${this.targetPort}` };

      const fwd = http.request(
        {
          hostname: this.targetHost,
          port: this.targetPort,
          path: clientReq.url,
          method: clientReq.method,
          headers,
        },
        (targetRes) => {
          if (mode === 'drop-response-after-forward') {
            // Read target response to ensure backend finished processing, then kill client socket!
            targetRes.on('data', () => {});
            targetRes.on('end', () => {
              clientRes.socket?.destroy();
            });
            return;
          }

          if (mode === 'close-mid-body') {
            clientRes.writeHead(targetRes.statusCode || 200, targetRes.headers);
            clientRes.write('{"partial":');
            setTimeout(() => {
              clientRes.socket?.destroy();
            }, 10);
            return;
          }

          clientRes.writeHead(targetRes.statusCode || 200, targetRes.headers);
          targetRes.pipe(clientRes);
        },
      );

      fwd.on('error', (err) => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: err.message }));
        }
      });

      clientReq.pipe(fwd);
    };

    if (mode === 'delay' && this.delayMs > 0) {
      setTimeout(dispatchForward, this.delayMs);
    } else {
      dispatchForward();
    }
  }
}

if (require.main === module) {
  const target = process.env.PROXY_TARGET || 'http://127.0.0.1:4000';
  const proxy = new FaultProxy(target);
  proxy.start(4001).then((port) => {
    console.log(`[FAULT-PROXY] Running on port ${port} -> target ${target}`);
  });
}
