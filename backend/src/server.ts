import { createApp } from './app';
import { env } from './config/env';
import { initSseSubscriber } from './services/sse';
import { seedDatabase } from '../prisma/seed';

async function main() {
  if (process.env.AUTO_SEED === 'true') {
    await seedDatabase();
  }

  initSseSubscriber();
  const app = createApp();

  app.listen(env.port, () => {
    console.log(`CertiFlow API listening on port ${env.port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start CertiFlow API:', err);
  process.exit(1);
});
