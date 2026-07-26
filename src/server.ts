import "dotenv/config";
import { loadEnv } from "./config/env.js";
import { createApp } from "./app.js";
import { ConversationStore } from "./storage/sqlite.js";
import { LiveGoHighLevelAdapter } from "./adapters/gohighlevel.js";
import { FakeScheduler, QStashScheduler, type SchedulerAdapter } from "./adapters/scheduler.js";
import { createTurnDecider } from "./agent/provider.js";
import { ConversationService } from "./services/conversation-service.js";

/**
 * QStash is a cloud scheduler: it calls back to PUBLIC_BASE_URL, so a laptop needs both a
 * token and a public tunnel before the first message can even be queued. With neither, run
 * the timers in this process instead — FakeScheduler already fires them via setTimeout, so
 * the delays and the job payloads stay exactly what the deployed path uses.
 *
 * Deployed behaviour is untouched: a QSTASH_TOKEN takes this branch out.
 */
function buildScheduler(env: ReturnType<typeof loadEnv>, run: (type: string, body: unknown) => Promise<void>): SchedulerAdapter {
  if (env.QSTASH_TOKEN) return new QStashScheduler(env);

  const local = new FakeScheduler();
  local.onSchedule = async (input) => {
    await run(input.type, {
      jobId: input.jobId,
      conversationId: input.conversationId,
      type: input.type,
      ...(input.payload ?? {}),
    });
  };
  console.warn("QSTASH_TOKEN unset - running scheduled jobs in-process (local mode)");
  return local;
}

function main(): void {
  const env = loadEnv();
  const store = new ConversationStore(env.databasePath);
  const messaging = new LiveGoHighLevelAdapter(env);
  const decider = createTurnDecider(env);

  /**
   * Jobs go back through the HTTP route rather than straight into the service, so local mode
   * exercises the same handler the deployed webhook does. Signature checking is already
   * skipped for these by QSTASH_VALIDATE_SIGNATURE=false.
   */
  const scheduler = buildScheduler(env, async (type, body) => {
    try {
      const res = await fetch(`http://127.0.0.1:${env.PORT}/jobs/${type}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.error(`[local-scheduler] ${type} -> HTTP ${res.status}`, await res.text());
    } catch (error) {
      console.error(`[local-scheduler] ${type} failed`, error);
    }
  });

  const service = new ConversationService(store, messaging, scheduler, decider, env);

  const app = createApp({ env, service, messaging, scheduler, store });

  app.listen(env.PORT, () => {
    console.log(`Secret shopper event service listening on :${env.PORT}`);
    console.log(`Public base URL: ${env.PUBLIC_BASE_URL}`);
    console.log(`Database: ${env.databasePath}`);
  });
}

try {
  main();
} catch (error) {
  console.error("Fatal startup error:", error);
  process.exit(1);
}
