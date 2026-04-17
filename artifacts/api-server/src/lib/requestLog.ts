import { type Response } from "express";

export interface RequestLog {
  id: number;
  time: string;
  method: string;
  path: string;
  model?: string;
  backend?: string;
  status: number;
  duration: number;
  stream: boolean;
  promptTokens?: number;
  completionTokens?: number;
  level: "info" | "warn" | "error";
  error?: string;
}

const REQUEST_LOG_MAX = 200;
export const requestLogs: RequestLog[] = [];
let logIdCounter = 0;
export const logSSEClients: Set<Response> = new Set();

export function pushRequestLog(entry: Omit<RequestLog, "id" | "time">): void {
  const log: RequestLog = { id: ++logIdCounter, time: new Date().toISOString(), ...entry };
  requestLogs.push(log);
  if (requestLogs.length > REQUEST_LOG_MAX) requestLogs.shift();
  const data = `data: ${JSON.stringify(log)}\n\n`;
  for (const client of logSSEClients) {
    try { client.write(data); } catch { logSSEClients.delete(client); }
  }
}

export interface ReqStats {
  promptTokens: number;
  completionTokens: number;
}

export function makeReqStats(): ReqStats {
  return { promptTokens: 0, completionTokens: 0 };
}

interface ModelStat {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

const modelStatsMap = new Map<string, ModelStat>();

export function recordModelStat(model: string, promptTokens: number, completionTokens: number): void {
  const stat = modelStatsMap.get(model) ?? { calls: 0, promptTokens: 0, completionTokens: 0 };
  stat.calls++;
  stat.promptTokens += promptTokens;
  stat.completionTokens += completionTokens;
  modelStatsMap.set(model, stat);
}

export function getModelStats(): Record<string, ModelStat> {
  return Object.fromEntries(modelStatsMap.entries());
}

export function resetStats(): void {
  modelStatsMap.clear();
}
