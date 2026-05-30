import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { getDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import healthRouter from './routes/health.js';
import repositoriesRouter from './routes/repositories.js';
import releasesRouter from './routes/releases.js';
import categoriesRouter from './routes/categories.js';
import configsRouter from './routes/configs.js';
import syncRouter from './routes/sync.js';
import proxyRouter from './routes/proxy.js';
import analysisRouter from './routes/analysis.js';
import backupRouter from './routes/backup.js';
import forksRouter from './routes/forks.js';
import autoSyncRouter from './routes/autoSyncRoutes.js';
import logsRouter from './routes/logs.js';
import { startBackupScheduler, stopBackupScheduler } from './services/backupService.js';
import { startAutoSyncScheduler, stopAutoSyncScheduler } from './services/autoSyncService.js';
import { logger, morganLoggerStream } from './services/logger.js';

export function createApp(): express.Express {
  const app = express();

  // Middleware
  app.use(helmet());
  app.use(cors());
  app.use(morgan('combined', { stream: morganLoggerStream }));
  app.use(express.json({ limit: '50mb' }));

  // Auth middleware for all /api/* except /api/health
  app.use('/api', authMiddleware);

  // Routes
  app.use(healthRouter);

  // Wave 2: Data CRUD routes
  app.use(repositoriesRouter);
  app.use(releasesRouter);
  app.use(categoriesRouter);
  app.use(configsRouter);
  app.use(syncRouter);

  // Wave 3: Proxy routes
  app.use(proxyRouter);

  app.use(analysisRouter);
  app.use(backupRouter);
  app.use(forksRouter);
  app.use(autoSyncRouter);
  app.use(logsRouter);

  // Global error handler
  app.use(errorHandler);

  return app;
}

function startServer(): void {
  // Initialize database
  const db = getDb();
  runMigrations(db);
  logger.info('server.startup', 'Database initialized');
  console.log('✅ Database initialized');

  // Start auto-backup scheduler
  startBackupScheduler();
  logger.info('server.startup', 'Backup scheduler started');
  console.log('✅ Backup scheduler started');

  // Start auto-sync scheduler
  startAutoSyncScheduler();
  logger.info('server.startup', 'Auto-sync scheduler started');
  console.log('✅ Auto-sync scheduler started');

  const app = createApp();

  const server = app.listen(config.port, () => {
    logger.info('server.startup', 'Server started', { port: config.port, authEnabled: Boolean(config.apiSecret) });
    console.log(`🚀 Server running on port ${config.port}`);
    if (!config.apiSecret) {
      logger.warn('server.auth', 'Running without API_SECRET; auth is disabled');
      console.warn('⚠️  Running without API_SECRET — auth is disabled');
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('server.shutdown', 'Shutdown requested');
    console.log('\n🛑 Shutting down...');
    server.close(() => {
      stopBackupScheduler();
      stopAutoSyncScheduler();
      closeDb();
      console.log('👋 Server stopped');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only start server when run directly (not imported for tests)
const isMainModule = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isMainModule) {
  startServer();
}
