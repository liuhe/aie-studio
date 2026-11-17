import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

// Route-level coverage for server.RenameDevinSession (auc-139, rule-478): the
// validation / not-live / unknown-project branches. The live path (ACP
// session/rename round-trip) needs a real devin child and is exercised
// manually.
vi.mock('../auth.js', () => ({ getUserId: () => 'u1' }));
vi.mock('../store.js', () => ({
  getProject: async (_uid: string, id: string) =>
    id === 'p1' ? { id: 'p1', name: 'p1', path: '/tmp/p1' } : null,
  getSettings: async () => ({}),
}));

const { registerDevinRoutes } = await import('../devin.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(websocket);
  registerDevinRoutes(app);
  await app.ready();
});

afterAll(async () => { await app.close(); });

const rename = (project: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/projects/${project}/devin-sessions/abc/rename`, payload: body });

describe('rename devin session', () => {
  it('400s on an empty title', async () => {
    const r = await rename('p1', { title: '   ' });
    expect(r.statusCode).toBe(400);
  });
  it('409s when no live process holds the slug (rule-478)', async () => {
    const r = await rename('p1', { title: 'My session' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/not live/);
  });
  it('404s for an unknown project', async () => {
    const r = await rename('nope', { title: 'My session' });
    expect(r.statusCode).toBe(404);
  });
});
