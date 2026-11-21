import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth';
import batchRoutes from './routes/batches';
import certificateRoutes from './routes/certificates';
import publicRoutes from './routes/public';
import whatsappRoutes from './routes/whatsapp';
import eventsRoutes from './routes/events';
import { errorHandler } from './middleware/errorHandler';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'certiflow-api', timestamp: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/batches', batchRoutes);
  app.use('/api/certificates', certificateRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/whatsapp', whatsappRoutes);
  app.use('/api/events', eventsRoutes);

  app.use(errorHandler);

  return app;
}
