import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

// Route-level coverage for the three Reset use cases (server.ResetSession
// auc-136 / ResetSdkSession auc-137 / ResetDevinSession auc-138): the
// not-live and unknown-project branches. Killing a real child is exercised
// manually — spawning claude / devin in a unit test is not an option.
vi.mock('../auth.js', () => ({ getUserId: () => 'u1' }));
vi.mock('../store.js', () => ({
  getProject: async (_uid: string, id: string) =>
    id === 'p1' ? { id: 'p1', name: 'p1', path: '/tmp/p1' } : null,
  getSettings: async () => ({}),
}));

const { registerSessionRoutes } = await import('../session.js');
const { registerSdkSessionRoutes } = await import('../sdk-session.js');
const { registerDevinRoutes } = await import('../devin.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(websocket);
  registerSessionRoutes(app);
  registerSdkSessionRoutes(app);
  registerDevinRoutes(app);
  await app.ready();
});

afterAll(async () => { await app.close(); });

const post = (url: string) => app.inject({ method: 'POST', url });

describe.each([
  ['cli', '/api/projects/%s/sessions/abc/reset'],
  ['sdk', '/api/projects/%s/sdk-sessions/abc/reset'],
  ['devin', '/api/projects/%s/devin-sessions/abc/reset'],
])('reset (%s bridge)', (_name, tpl) => {
  it('answers ok live:false when nothing is running for the id (rule-466 / 469 / 473)', async () => {
    const r = await post(tpl.replace('%s', 'p1'));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, live: false });
  });
  it('404s for an unknown project', async () => {
    const r = await post(tpl.replace('%s', 'nope'));
    expect(r.statusCode).toBe(404);
  });
});
