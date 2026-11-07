import { Router } from 'express';
import { pingDatabase } from './db/pool.js';

export function createHealthRouter() {
  const router = Router();
  router.get('/health', async (_req, res) => {
    try {
      await pingDatabase();
      return res.status(200).json({ status: 'ok' });
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  });
  return router;
}
