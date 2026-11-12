import { PrismaClient } from "@prisma/client";

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  return databaseUrl
    ? new PrismaClient({ datasourceUrl: databaseUrl })
    : new PrismaClient();
}

export const prisma = createPrismaClient();
