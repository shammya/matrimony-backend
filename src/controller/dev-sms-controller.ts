import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../exception/app-error.js';
import './context.js';

/** Where the code goes in development: the person running the backend reads it. */
export interface DevSmsSink {
  /** A secret only the identity provider's delivery action knows. */
  secret: string;
  /** Shows a line to the developer (the backend's terminal). */
  write: (line: string) => void;
}

const bodySchema = z
  .object({ recipient: z.string().min(1).max(32), text: z.string().min(1).max(500) })
  .strict();

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * DEVELOPMENT ONLY. The identity provider has to hand the one-time code to something that
 * delivers it. In production that is an SMS gateway. In development, where no gateway is paid
 * for, a small action in the provider posts the message here and it is printed in the backend's
 * terminal, so the whole phone sign-in can be tried without sending a text.
 *
 * It is registered only outside production and only when a secret is configured (the
 * configuration refuses to start in production with one). It answers 404 to anyone without the
 * secret, prints a line and keeps nothing: no code or number is stored or logged.
 */
export function registerDevSmsSink(app: FastifyInstance, sink: DevSmsSink) {
  app.post(
    '/api/v1/dev/sms',
    // No agency and no sign-in: the provider calls this, not a browser. The secret is the guard.
    { config: { public: true, tenantRequired: false, rateLimit: { max: 30, timeWindow: 60000 } } },
    async (req, reply) => {
      const given = req.headers['x-dev-sms-secret'];
      if (typeof given !== 'string' || !same(given, sink.secret)) {
        throw new AppError(404, 'NOT_FOUND');
      }
      const { recipient, text } = bodySchema.parse(req.body);
      // Control characters could rewrite the developer's terminal, so they are not printed.
      sink.write(`[dev sms] to ${recipient}: ${text}`.replace(/[\u0000-\u001f\u007f]/g, ' '));
      return reply.code(204).send();
    },
  );
}
