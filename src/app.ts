import express, { type Express } from "express";
import type { Env } from "./config/env.js";
import type { ConversationService } from "./services/conversation-service.js";
import type { MessagingAdapter } from "./adapters/messaging.js";
import type { SchedulerAdapter } from "./adapters/scheduler.js";
import type { ConversationStore } from "./storage/sqlite.js";
import { createGhlWebhookRouter } from "./routes/ghl-webhook.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createConversationsRouter } from "./routes/conversations.js";
import { createUiRouter } from "./routes/ui.js";

export interface AppDeps {
  env: Env;
  service: ConversationService;
  messaging: MessagingAdapter;
  scheduler: SchedulerAdapter;
  store: ConversationStore;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Capture raw body for QStash and GoHighLevel signature verification.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false }));

  app.use(express.static("public"));
  app.use(createGhlWebhookRouter(deps));
  app.use(createJobsRouter(deps));
  app.use(createConversationsRouter(deps));
  app.use(createUiRouter(deps));

  return app;
}
