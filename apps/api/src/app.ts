import express, { type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db.js";
import { parseWebOrigin, type AppConfig } from "./config.js";
import { createScanRouter } from "./scan/routes.js";
import { createMediaRouter } from "./media/routes.js";
import { createAiRouter } from "./ai/routes.js";
import type { MediaReprocessor } from "./media/reprocess.js";
import type { AiCanceller, AiReprocessor } from "./ai/reprocess.js";
import type { ScanOrchestrator } from "./scan/orchestrator.js";

type HealthDatabase = Pick<PrismaClient, "$queryRaw">;
type AppDatabase = Pick<PrismaClient, "$queryRaw" | "storage" | "scanJob" | "mediaFile" | "$transaction">;

type AppConfigInput = Pick<AppConfig, "mediaRoot" | "storageName" | "supportedMediaExtensions"> & {
  webOrigin?: string;
  /** AI master switch (ADR-006 §5/§16). Defaults to false when not provided. */
  aiEnabled?: boolean;
};

export interface AppDependencies {
  prisma?: AppDatabase;
  config?: AppConfigInput;
  orchestrator?: ScanOrchestrator;
  reprocessor?: MediaReprocessor;
  aiReprocessor?: AiReprocessor;
  aiCanceller?: AiCanceller;
}

const defaultConfig = {
  mediaRoot: process.env.MEDIA_ROOT ?? "",
  storageName: process.env.STORAGE_NAME ?? "",
  supportedMediaExtensions: [],
  aiEnabled: false,
} as const;

function isAppDependencies(
  value: HealthDatabase | AppDependencies,
): value is AppDependencies {
  return "prisma" in value || "config" in value;
}

function resolveDependencies(
  databaseOrDependencies: HealthDatabase | AppDependencies,
  config?: AppConfigInput,
): {
  prisma: AppDatabase;
  config: AppConfigInput;
  orchestrator?: ScanOrchestrator;
  reprocessor?: MediaReprocessor;
  aiReprocessor?: AiReprocessor;
  aiCanceller?: AiCanceller;
} {
  if (isAppDependencies(databaseOrDependencies)) {
    return {
      prisma: (databaseOrDependencies.prisma ?? defaultPrisma) as AppDatabase,
      config: databaseOrDependencies.config ?? defaultConfig,
      orchestrator: databaseOrDependencies.orchestrator,
      reprocessor: databaseOrDependencies.reprocessor,
      aiReprocessor: databaseOrDependencies.aiReprocessor,
      aiCanceller: databaseOrDependencies.aiCanceller,
    };
  }
  return {
    prisma: databaseOrDependencies as AppDatabase,
    config: config ?? defaultConfig,
  };
}

export type { HealthDatabase };

export interface CreateAppOptions {
  prisma: AppDatabase;
  config: AppConfigInput;
  orchestrator?: ScanOrchestrator;
  reprocessor?: MediaReprocessor;
  aiReprocessor?: AiReprocessor;
  aiCanceller?: AiCanceller;
}

export function createApp(options: CreateAppOptions): express.Express;
export function createApp(database?: HealthDatabase): express.Express;
export function createApp(
  databaseOrDependencies: HealthDatabase | AppDependencies = defaultPrisma,
  config?: AppConfigInput,
): express.Express {
  const dependencies = resolveDependencies(databaseOrDependencies, config);
  const app = express();
  app.use(express.json());
  // Browser-origin CORS: the web app (different port) calls this API directly.
  // WEB_ORIGIN may list several origins (e.g. localhost + LAN IP); the
  // request's own Origin is echoed back when it is allow-listed.
  const allowedOrigins = new Set(parseWebOrigin(dependencies.config.webOrigin).split(","));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.status(204).end();
      return;
    }
    next();
  });
  app.get("/health", (req, res) => healthHandler(req, res, dependencies.prisma));
  app.use(createScanRouter({ prisma: dependencies.prisma, config: dependencies.config, orchestrator: dependencies.orchestrator }));
  app.use(createMediaRouter({ prisma: dependencies.prisma, reprocessor: dependencies.reprocessor }));
  app.use(createAiRouter({
    reprocessor: dependencies.aiReprocessor,
    canceller: dependencies.aiCanceller,
    enabled: dependencies.config.aiEnabled ?? false,
  }));
  return app;
}

/*
 * Keep the old handler export and database-only createApp overload for Phase 3
 * callers; Phase 4 production wiring uses the injected config and Prisma client.
 */

export async function healthHandler(
  _req: Request,
  res: Response,
  database: HealthDatabase = defaultPrisma,
): Promise<void> {
  try {
    await database.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "ok", database: "reachable" });
  } catch {
    res.status(503).json({ status: "degraded", database: "unreachable" });
  }
}
