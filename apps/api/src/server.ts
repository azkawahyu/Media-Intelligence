import { createApp } from "./app.js";
import { ensureStorage } from "./bootstrap.js";
import { parseConfig } from "./config.js";
import { prisma } from "./db.js";
import { SpawnFFprobeAdapter } from "./metadata/ffprobe-adapter.js";
import { createExtractionReprocessor } from "./media/reprocess.js";
import { ExtractionRunner } from "./scan/extractor.js";
import { ScanOrchestrator } from "./scan/orchestrator.js";
import { sweepInterruptedState } from "./scan/startup.js";
import { sweepInterruptedAiState } from "./ai/startup.js";
import { HttpAiProcessorAdapter } from "./ai/adapter.js";
import { createAiReprocessor } from "./ai/reprocess.js";
import { AiRunner } from "./ai/runner.js";
import { createAiRuntime } from "./ai/runtime.js";

async function main(): Promise<void> {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid configuration");
    process.exitCode = 1;
    return;
  }

  try {
    await ensureStorage(prisma, {
      storageName: config.storageName,
      mediaRoot: config.mediaRoot,
    });
    await sweepInterruptedState(prisma);
    // AI restart recovery (ADR-006 §4): PROCESSING -> PENDING, never FAILED.
    // Runs unconditionally so an interrupted row is recovered even if AI is
    // later enabled; it is a no-op when no AI work was in flight.
    await sweepInterruptedAiState(prisma);
  } catch (error) {
    console.error(
      `Storage bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  const adapter = new SpawnFFprobeAdapter({ binaryPath: process.env.FFPROBE_PATH });
  const extractor = new ExtractionRunner({
    prisma,
    adapter,
    storageRoot: config.mediaRoot,
    concurrency: config.metadataWorkerConcurrency,
    maxRetries: config.metadataMaxRetries,
    retryBackoffMs: config.metadataRetryBackoffMs,
  });
  const orchestrator = new ScanOrchestrator({
    prisma,
    config,
    extractor,
    aiEnabled: config.ai.enabled,
  });
  const reprocessor = createExtractionReprocessor(extractor);

  // ── AI subsystem (ADR-006, Plan 006) ─────────────────────────────────────
  // The runner is constructed regardless of the flag so the reprocess endpoint
  // reports a precise "disabled" conflict; the polling loop only starts when
  // AI is explicitly enabled (AI_ENABLED=true).
  const aiAdapter = new HttpAiProcessorAdapter({
    baseUrl: config.ai.processorUrl,
    requestTimeoutMs: config.ai.requestTimeoutMs,
  });
  const aiRunner = new AiRunner({
    prisma,
    adapter: aiAdapter,
    storageRoot: config.mediaRoot,
    concurrency: config.ai.concurrency,
    maxRetries: config.ai.maxRetries,
    retryBackoffMs: config.ai.retryBackoffMs,
    pollIntervalMs: config.ai.pollIntervalMs,
    stageTimeoutMs: config.ai.stageTimeoutMs,
    jobDeadlineMs: config.ai.jobDeadlineMs,
    modelSize: config.ai.modelSize,
    language: config.ai.language,
  });
  const aiReprocessor = createAiReprocessor(prisma);

  const aiRuntime = createAiRuntime({
    runner: aiRunner,
    intervalMs: config.ai.pollIntervalMs,
    onError: (error) => {
      console.error(
        `AI runner drain failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  if (config.ai.enabled) {
    aiRuntime.start();
    console.log(
      `AI processing enabled (processor=${config.ai.processorUrl}, concurrency=${config.ai.concurrency})`,
    );
  } else {
    console.log("AI processing disabled (set AI_ENABLED=true to enable)");
  }

  const app = createApp({
    prisma,
    config: {
      mediaRoot: config.mediaRoot,
      storageName: config.storageName,
      supportedMediaExtensions: config.supportedMediaExtensions,
      webOrigin: config.webOrigin,
      aiEnabled: config.ai.enabled,
    },
    orchestrator,
    reprocessor,
    aiReprocessor,
    aiCanceller: aiRunner,
  });
  const server = app.listen(config.port, () => {
    console.log(`TMIP API listening on port ${config.port}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}, shutting down`);
    aiRuntime.stop();
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    // Do not hang forever if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main();
