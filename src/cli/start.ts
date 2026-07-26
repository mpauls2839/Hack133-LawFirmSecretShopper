import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "../config/env.js";
import { personaConfigSchema } from "../config/persona.js";
import { ConversationStore } from "../storage/sqlite.js";
import { LiveGoHighLevelAdapter } from "../adapters/gohighlevel.js";
import { QStashScheduler } from "../adapters/scheduler.js";
import { createTurnDecider } from "../agent/provider.js";
import { ConversationService } from "../services/conversation-service.js";

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "config/persona.json";
  const absolutePath = path.resolve(configPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(
      `Persona config not found at ${absolutePath}. Copy config/persona.example.json to config/persona.json and edit it.`,
    );
  }

  const raw = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const config = personaConfigSchema.parse(raw);

  if (config.replyDelaySeconds !== undefined) {
    process.env.REPLY_DELAY_SECONDS = String(config.replyDelaySeconds);
  }
  const effectiveEnv = loadEnv();

  const store = new ConversationStore(effectiveEnv.databasePath);
  const messaging = new LiveGoHighLevelAdapter(effectiveEnv);
  const scheduler = new QStashScheduler(effectiveEnv);
  const decider = createTurnDecider(effectiveEnv);
  const service = new ConversationService(store, messaging, scheduler, decider, effectiveEnv);

  const result = await service.startConversation(config);
  console.log(
    JSON.stringify(
      {
        ok: true,
        conversationId: result.conversationId,
        initialMessageSid: result.initialMessageSid,
        expiresAt: result.expiresAt,
        firmPhone: config.firmPhone,
        publicBaseUrl: effectiveEnv.PUBLIC_BASE_URL,
      },
      null,
      2,
    ),
  );

  store.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
