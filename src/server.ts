import "dotenv/config";
import { loadEnv } from "./config/env.js";
import { createApp } from "./app.js";
import { ConversationStore } from "./storage/sqlite.js";
import { LiveGoHighLevelAdapter } from "./adapters/gohighlevel.js";
import { QStashScheduler } from "./adapters/scheduler.js";
import { createTurnDecider } from "./agent/provider.js";
import { ConversationService } from "./services/conversation-service.js";

const env = loadEnv();
const store = new ConversationStore(env.databasePath);
const messaging = new LiveGoHighLevelAdapter(env);
const scheduler = new QStashScheduler(env);
const decider = createTurnDecider(env);
const service = new ConversationService(store, messaging, scheduler, decider, env);

const app = createApp({ env, service, messaging, scheduler });

app.listen(env.PORT, () => {
  console.log(`Secret shopper event service listening on :${env.PORT}`);
  console.log(`Public base URL: ${env.PUBLIC_BASE_URL}`);
  console.log(`Database: ${env.databasePath}`);
});
