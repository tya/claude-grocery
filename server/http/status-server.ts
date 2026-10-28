/**
 * The bot talks to Slack over Socket Mode and needs no inbound port for that.
 * This server exists only so mealplans.tynet.us has something to answer with —
 * a health check and a one-line status page, nothing more. TLS cert and key
 * come from a cert-manager Secret mounted by the chart; if they're not
 * present (local dev), the server simply doesn't start.
 */

import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { log } from '../utils/logger.js';

export function startStatusServer(): void {
  const port = Number(process.env.STATUS_PORT ?? 8443);
  const certFile = process.env.TLS_CERT_FILE ?? '/etc/tls/tls.crt';
  const keyFile = process.env.TLS_KEY_FILE ?? '/etc/tls/tls.key';

  if (!existsSync(certFile) || !existsSync(keyFile)) {
    log('info', 'Status server not started: no TLS cert at ' + certFile);
    return;
  }

  const startedAt = Date.now();
  const server = createHttpsServer(
    { cert: readFileSync(certFile), key: readFileSync(keyFile) },
    (req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            service: 'meal-planner',
            status: 'ok',
            uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          })
        );
    }
  );

  server.listen(port, () => log('info', `Status server listening on ${port}`));
}
