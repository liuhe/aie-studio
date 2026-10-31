import type { FastifyInstance } from 'fastify';
import { getUserId } from './auth.js';
import { getProject } from './store.js';
import { renderExport } from './export.js';

type Body = {
  html: string;
  theme: 'dark' | 'light' | 'dim';
  fontScale?: string;
  format: 'pdf' | 'png';
  filename?: string;
};

// Big sessions inline base64 images; the serialised ExportView outerHTML can
// run tens of MB. Default Fastify cap (1MB) is far too small.
const EXPORT_BODY_LIMIT = 64 * 1024 * 1024;

export function registerExportRoutes(app: FastifyInstance, webDist: string) {
  app.post<{ Params: { id: string }; Body: Body }>(
    '/api/projects/:id/export',
    { bodyLimit: EXPORT_BODY_LIMIT },
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const body = req.body ?? ({} as Body);
      if (!body.html || !body.format) {
        return reply.code(400).send({ error: 'html and format required' });
      }
      if (body.format !== 'pdf' && body.format !== 'png') {
        return reply.code(400).send({ error: 'format must be pdf or png' });
      }
      try {
        const buf = await renderExport({
          html: body.html,
          theme: body.theme ?? 'dark',
          fontScale: body.fontScale,
          format: body.format,
          webDist,
        });
        const mime = body.format === 'pdf' ? 'application/pdf' : 'image/png';
        reply.header('Content-Type', mime);
        if (body.filename) {
          reply.header(
            'Content-Disposition',
            `attachment; filename="${body.filename}.${body.format}"`,
          );
        }
        return reply.send(buf);
      } catch (e: any) {
        req.log.error({ err: e }, 'export render failed');
        return reply.code(500).send({ error: e?.message ?? 'render failed' });
      }
    },
  );
}
