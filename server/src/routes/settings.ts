import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnifiedApiKey, regenerateUnifiedKey } from '../db/index.js';

export const settingsRouter = Router();

settingsRouter.get('/api-key', async (_req: Request, res: Response) => {
  res.json({ apiKey: await getUnifiedApiKey() });
});

settingsRouter.post('/api-key/regenerate', async (_req: Request, res: Response) => {
  const newKey = await regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});
