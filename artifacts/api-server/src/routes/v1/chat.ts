import { Router, type IRouter, type Request, type Response } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, Modality, type Content, type Part } from "@google/genai";
import { authMiddleware } from "../../middlewares/auth";
import { isModelEnabled } from "../../lib/modelGroups";
import { pushRequestLog, recordModelStat, makeReqStats, type ReqStats } from "../../lib/requestLog";
import { hashRequest, cacheGet, cacheSet } from "../../lib/responseCache";

// Fetch a remote image URL and return a base64 data URI
async function fetchImageAsBase64(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AI-Proxy/1.0)",
      "Accept": "image/*,*/*;q=0.8",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${url}`);
  const contentType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0]!;
  const buf = await res.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  return `data:${contentType};base64,${b64}`;
}

// Convert image_url parts: replace remote URLs with base64 data URIs
// so the Replit AI Integrations proxy doesn't need to fetch external URLs itself
async function resolveImageUrls(messages: OAIMessage[]): Promise<OAIMessage[]> {
  return Promise.all(
    messages.map(async (msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const resolvedContent = await Promise.all(
        msg.content.map(async (part) => {
          if (
            part.type === "image_url" &&
            typeof (part as { image_url?: { url: string } }).image_url?.url === "string"
          ) {
            const { url } = (part as { type: "image_url"; image_url: { url: string } }).image_url;
            if (!url.startsWith("data:")) {
              try {
                const dataUri = await fetchImageAsBase64(url);
                return { ...part, image_url: { ...(part as { image_url: object }).image_url, url: dataUri } };
              } catch {
                // keep original if fetch fails
              }
            }
          }
          return part;
        })
      );
      return { ...msg, content: resolvedContent };
    })
  );
}

const router: IRouter = Router();

const openai = new OpenAI({
  apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "dummy",
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
});

const anthropic = new Anthropic({
  apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] ?? "dummy",
  baseURL: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"],
});

const gemini = new GoogleGenAI({
  apiKey: process.env["AI_INTEGRATIONS_GEMINI_API_KEY"] ?? "dummy",
  httpOptions: { apiVersion: "", baseUrl: process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"] },
});

const openrouter = new OpenAI({
  apiKey: process.env["AI_INTEGRATIONS_OPENROUTER_API_KEY"] ?? "dummy",
  baseURL: process.env["AI_INTEGRATIONS_OPENROUTER_BASE_URL"],
});

// ----------------------------------------------------------------------
// Model aliases: friendly model ID -> actual backend model ID
// Models with a "/" in the resolved ID are routed to OpenRouter.
// ----------------------------------------------------------------------
const MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4.6-fast": "anthropic/claude-opus-4.6-fast",
};

// ----------------------------------------------------------------------
// Claude model config (max_tokens per spec - must not change)
// ----------------------------------------------------------------------
const CLAUDE_MAX_TOKENS: Record<string, number> = {
  "claude-haiku-4-5": 8096,
  "claude-sonnet-4-5": 64000,
  "claude-sonnet-4-6": 64000,
  "claude-opus-4-1": 64000,
  "claude-opus-4-5": 64000,
  "claude-opus-4-6": 64000,
  "claude-opus-4-7": 64000,
};

function getClaudeMaxTokens(model: string): number {
  return CLAUDE_MAX_TOKENS[model] ?? 64000;
}

function stripClaudeSuffix(model: string): {
  baseModel: string;
  thinkingEnabled: boolean;
  thinkingVisible: boolean;
} {
  if (model.endsWith("-thinking-visible")) {
    return {
      baseModel: model.slice(0, -"-thinking-visible".length),
      thinkingEnabled: true,
      thinkingVisible: true,
    };
  }
  if (model.endsWith("-thinking")) {
    return {
      baseModel: model.slice(0, -"-thinking".length),
      thinkingEnabled: true,
      thinkingVisible: false,
    };
  }
  return { baseModel: model, thinkingEnabled: false, thinkingVisible: false };
}

// ----------------------------------------------------------------------
// Type aliases for incoming OpenAI-format request body
// ----------------------------------------------------------------------
type OAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "tool_result"; tool_use_id?: string; content?: string } // not real OAI but keep safe
  | Record<string, unknown>;

interface OAIMessage {
  role: string;
  content: string | OAIContentPart[] | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string; // role === "tool"
}

interface OAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

type OAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

interface ChatBody {
  model: string;
  messages: OAIMessage[];
  stream?: boolean;
  // generation params
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stop?: string | string[];
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  user?: string;
  // tools
  tools?: OAITool[];
  tool_choice?: OAIToolChoice;
  parallel_tool_calls?: boolean;
  // response_format
  response_format?: { type: string };
  // image generation extensions (Gemini image models)
  aspect_ratio?: string;  // e.g. "16:9", "9:16", "4:3", "3:4", "1:1"
  aspectRatio?: string;
  negative_prompt?: string;
  number_of_images?: number;  // alias for n, 1-4
  image_size?: string;
  imageSize?: string;
  output_resolution?: string;
  resolution?: string;
  media_resolution?: string;
  input_media_resolution?: string;
}

const BEDROCK_PROMPT_CACHE_MODELS = new Set(["anthropic/claude-opus-4.6"]);

function shouldUseBedrockPromptCache(model: string): boolean {
  return BEDROCK_PROMPT_CACHE_MODELS.has(model);
}

function addCacheControlToContent(
  content: string | OAIContentPart[] | null,
): string | Array<OAIContentPart & { cache_control?: { type: "ephemeral" } }> | null {
  if (typeof content === "string") {
    return content.length > 0
      ? [{ type: "text", text: content, cache_control: { type: "ephemeral" } }]
      : content;
  }
  if (!Array.isArray(content) || content.length === 0) return content;

  const blocks = [...content] as Array<OAIContentPart & { cache_control?: { type: "ephemeral" } }>;
  let targetIndex = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === "text") {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) targetIndex = blocks.length - 1;
  blocks[targetIndex] = { ...blocks[targetIndex], cache_control: { type: "ephemeral" } };
  return blocks;
}

function applyBedrockAnthropicPromptCache(body: ChatBody): ChatBody {
  if (!shouldUseBedrockPromptCache(body.model)) return body;

  let remaining = 4;
  const messages = body.messages.map((msg, index) => {
    const isFinalMessage = index === body.messages.length - 1;
    const shouldMarkSystem = msg.role === "system";
    const shouldMarkContext = !isFinalMessage && msg.role !== "system";
    if (remaining <= 0 || (!shouldMarkSystem && !shouldMarkContext)) return msg;

    const content = addCacheControlToContent(msg.content);
    if (content === msg.content) return msg;
    remaining--;
    return { ...msg, content };
  });

  return { ...body, messages };
}

function getOpenRouterCachedTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const details = (usage as { prompt_tokens_details?: unknown }).prompt_tokens_details;
  if (!details || typeof details !== "object") return 0;
  const cached = (details as { cached_tokens?: unknown }).cached_tokens;
  return typeof cached === "number" ? cached : 0;
}

function withOpenRouterCacheUsage<T extends { usage?: unknown }>(payload: T): T {
  const cachedTokens = getOpenRouterCachedTokens(payload.usage);
  if (cachedTokens <= 0 || !payload.usage || typeof payload.usage !== "object") return payload;
  return {
    ...payload,
    usage: {
      ...(payload.usage as Record<string, unknown>),
      cache_read_input_tokens: cachedTokens,
    },
  };
}

// ----------------------------------------------------------------------
// Message conversion: OpenAI -> Anthropic
// ----------------------------------------------------------------------

function oaiContentToAnthropic(
  content: string | OAIContentPart[] | null
): Anthropic.ContentBlockParam[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") {
    // Anthropic rejects empty text blocks
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }

  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof (part as { text?: string }).text === "string") {
      const text = (part as { text: string }).text;
      if (text.length === 0) continue; // Anthropic rejects empty text blocks
      blocks.push({ type: "text", text });
    } else if (part.type === "image_url") {
      const { url } = (part as { type: "image_url"; image_url: { url: string } }).image_url;
      if (url.startsWith("data:")) {
        const commaIdx = url.indexOf(",");
        const meta = url.slice(5, commaIdx); // strip "data:"
        const data = url.slice(commaIdx + 1);
        const mediaType = meta.split(";")[0] as Anthropic.Base64ImageSource["media_type"];
        blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
      } else {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
    // skip unknown part types
  }
  return blocks;
}

function convertMessagesToAnthropic(messages: OAIMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const converted: Anthropic.MessageParam[] = [];

  // We may need to merge consecutive tool results into a single user message
  // (Anthropic requires user/assistant alternation)
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      converted.push({ role: "user", content: [...pendingToolResults] });
      pendingToolResults = [];
    }
  };

  for (const msg of messages) {
    // -- system ------------------------------------------------------
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(p => (p as { type: string }).type === "text").map(p => (p as { text: string }).text).join("\n")
          : "";
      continue;
    }

    // -- tool result (role === "tool") --------------------------------
    if (msg.role === "tool") {
      const resultContent =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map(p => (p as { text?: string }).text ?? "").join("")
            : "";
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: resultContent,
      });
      continue;
    }

    // If we had accumulated tool results and now see a non-tool role, flush
    flushToolResults();

    // -- assistant ----------------------------------------------------
    if (msg.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];

      // text content
      const textBlocks = oaiContentToAnthropic(msg.content);
      content.push(...textBlocks);

      // tool_calls -> tool_use blocks
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(tc.function.arguments || "{}");
          } catch {
            parsedInput = {};
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }

      if (content.length === 0) content.push({ type: "text", text: "" });
      converted.push({ role: "assistant", content });
      continue;
    }

    // -- user ---------------------------------------------------------
    const userContent = oaiContentToAnthropic(msg.content);
    if (userContent.length === 0) continue;
    converted.push({ role: "user", content: userContent });
  }

  flushToolResults();
  return { system, messages: converted };
}

// ----------------------------------------------------------------------
// Tool conversion: OpenAI tools -> Anthropic tools
// ----------------------------------------------------------------------

function convertToolsToAnthropic(tools: OAITool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: (t.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Tool["input_schema"],
  }));
}

function convertToolChoiceToAnthropic(
  tc: OAIToolChoice | undefined
): Anthropic.ToolChoiceParam | undefined {
  if (!tc || tc === "none") return undefined;
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (typeof tc === "object" && tc.type === "function") {
    return { type: "tool", name: tc.function.name };
  }
  return { type: "auto" };
}

// ----------------------------------------------------------------------
// Anthropic - prompt caching (cache_control)
// ----------------------------------------------------------------------

/**
 * Inject cache_control markers to enable Anthropic server-side prompt caching.
 *
 * Strategy:
 *   - System prompt  → always marked (most stable, highest cache benefit)
 *   - Messages       → all turns except the final user message are marked
 *     (they constitute the shared context that repeats every turn)
 *
 * Cache tiers (Anthropic):
 *   cache_creation: ~1.25× regular input price, stored for 5 min (TTL reset on hit)
 *   cache_read:      ~0.1× regular input price
 */
function applyAnthropicCacheControl(
  system: string | undefined,
  messages: Anthropic.MessageParam[],
): {
  systemBlock: Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
} {
  // Anthropic allows at most 4 cache_control blocks total across system + messages.
  const MAX_CACHE_BLOCKS = 4;

  const systemBlock: Anthropic.TextBlockParam[] | undefined = system
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : undefined;

  // Remaining budget after the system block
  const msgBudget = MAX_CACHE_BLOCKS - (systemBlock ? 1 : 0);

  // Candidates: all messages except the final (fresh) user turn
  const candidates = messages.slice(0, -1);
  // Tag only the LAST `msgBudget` candidates to maximise cache-hit rate
  // as the conversation grows (newest stable context is most likely to reappear)
  const tagFromIdx = Math.max(0, candidates.length - msgBudget);

  const tagged = messages.map((msg, i): Anthropic.MessageParam => {
    // Last message is the fresh user turn — never tag it
    if (i === messages.length - 1) return msg;
    // Only tag messages within the budget window
    if (i < tagFromIdx) return msg;
    const content = msg.content;
    if (!Array.isArray(content) || content.length === 0) return msg;
    const blocks = [...content] as Anthropic.ContentBlockParam[];
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      cache_control: { type: "ephemeral" },
    } as Anthropic.ContentBlockParam;
    return { ...msg, content: blocks };
  });

  return { systemBlock, messages: tagged };
}

// ----------------------------------------------------------------------
// Gemini model config helpers
// ----------------------------------------------------------------------

function stripGeminiSuffix(model: string): { baseModel: string; thinkingEnabled: boolean } {
  if (model.endsWith("-thinking-visible")) {
    return { baseModel: model.slice(0, -"-thinking-visible".length), thinkingEnabled: true };
  }
  if (model.endsWith("-thinking")) {
    return { baseModel: model.slice(0, -"-thinking".length), thinkingEnabled: true };
  }
  return { baseModel: model, thinkingEnabled: false };
}

const GEMINI_IMAGE_MODELS = new Set(["gemini-3-pro-image-preview", "gemini-3-pro-image-preview-2k", "gemini-2.5-flash-image"]);

function isGeminiImageModel(model: string): boolean {
  return GEMINI_IMAGE_MODELS.has(model);
}

function getGeminiBackendModel(model: string): string {
  if (model === "gemini-3-pro-image-preview-2k") return "gemini-3-pro-image-preview";
  return model;
}

// Extract text + image parts from a Gemini response and build a content string.
// Images are encoded as markdown image tags with base64 data URIs.
function extractGeminiContent(parts: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }>): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.text) segments.push(part.text);
    if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType ?? "image/png";
      segments.push(`![generated image](data:${mime};base64,${part.inlineData.data})`);
    }
  }
  return segments.join("\n\n");
}

// ----------------------------------------------------------------------
// Message conversion: OpenAI -> Gemini
// ----------------------------------------------------------------------

type GeminiPart = Part;
type GeminiContent = Content & { role: "user" | "model"; parts: GeminiPart[] };

function normalizeGeminiMediaResolution(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "low") return "MEDIA_RESOLUTION_LOW";
  if (normalized === "medium") return "MEDIA_RESOLUTION_MEDIUM";
  if (normalized === "high") return "MEDIA_RESOLUTION_HIGH";
  if (normalized === "ultra_high" || normalized === "ultrahigh" || normalized === "2k" || normalized === "4k") {
    return "MEDIA_RESOLUTION_ULTRA_HIGH";
  }
  return undefined;
}

function parseDataUri(dataUri: string): { mimeType: string; data: string } | undefined {
  const match = dataUri.match(/^data:([^;,]+)(?:;[^,]*)?,(.+)$/s);
  if (!match) return undefined;
  return { mimeType: match[1] || "image/png", data: match[2] || "" };
}

function oaiContentToGeminiParts(content: string | OAIContentPart[] | null, defaultMediaResolution?: string): GeminiPart[] {
  if (!content) return [{ text: "" }];
  if (typeof content === "string") return [{ text: content }];
  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof (part as { text?: string }).text === "string") {
      parts.push({ text: (part as { text: string }).text });
    } else if (part.type === "image_url") {
      const imageUrl = (part as { image_url?: { url?: string; detail?: string } }).image_url;
      const url = imageUrl?.url;
      if (!url) continue;
      const mediaResolution = normalizeGeminiMediaResolution(imageUrl.detail) ?? defaultMediaResolution;
      const mediaResolutionPayload = mediaResolution ? { mediaResolution: { level: mediaResolution } } : {};
      if (url.startsWith("data:")) {
        const parsed = parseDataUri(url);
        if (parsed?.data) {
          parts.push({
            inlineData: { data: parsed.data, mimeType: parsed.mimeType },
            ...mediaResolutionPayload,
          });
        }
      } else {
        parts.push({
          fileData: { fileUri: url, mimeType: "image/jpeg" },
          ...mediaResolutionPayload,
        });
      }
    }
  }
  return parts.length > 0 ? parts : [{ text: "" }];
}

function convertMessagesToGemini(messages: OAIMessage[], defaultMediaResolution?: string): {
  systemInstruction: string | undefined;
  contents: GeminiContent[];
} {
  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string"
        ? msg.content
        : (Array.isArray(msg.content)
          ? (msg.content as OAIContentPart[])
              .filter(p => p.type === "text")
              .map(p => (p as { text: string }).text)
              .join("\n")
          : "");
      systemInstruction = systemInstruction ? `${systemInstruction}\n${text}` : text;
    } else {
      const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";
      const parts = oaiContentToGeminiParts(msg.content, defaultMediaResolution);
      // Merge consecutive same-role messages into one to satisfy Gemini alternation rule
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    }
  }

  // Gemini requires the first turn to be user; inject a stub if needed
  if (contents.length === 0 || contents[0].role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: "." }] });
  }

  return { systemInstruction, contents };
}

function normalizeGeminiImageSize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase().replace(/\s+/g, "");
  if (normalized === "1K" || normalized === "1024" || normalized === "1024P") return "1K";
  if (normalized === "2K" || normalized === "2048" || normalized === "2048P") return "2K";
  if (normalized === "4K" || normalized === "4096" || normalized === "4096P") return "4K";
  if (normalized === "512" || normalized === "512P") return "512";
  return undefined;
}

function applyGeminiImageConfig(config: Record<string, unknown>, body: ChatBody, baseModel: string): void {
  const imageConfig: Record<string, string> = {};
  const aspectRatio = body.aspect_ratio ?? body.aspectRatio;
  if (aspectRatio) imageConfig["aspectRatio"] = aspectRatio;
  const explicitSize = body.image_size ?? body.imageSize ?? body.output_resolution ?? body.resolution;
  const imageSize = normalizeGeminiImageSize(explicitSize) ?? (baseModel.endsWith("-2k") ? "2K" : undefined);
  if (imageSize) imageConfig["imageSize"] = imageSize;
  if (Object.keys(imageConfig).length > 0) config["imageConfig"] = imageConfig;
  if (body.negative_prompt) config["negativePrompt"] = body.negative_prompt;
}

// ----------------------------------------------------------------------
// SSE chunk helpers
// ----------------------------------------------------------------------

function makeChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason?: string | null
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
}

function sseWrite(res: Response, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function setSseHeaders(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
}

// ----------------------------------------------------------------------
// Anthropic - streaming
// ----------------------------------------------------------------------

async function handleClaudeStream(
  _req: Request,
  res: Response,
  body: ChatBody,
  stats: ReqStats
) {
  const { model, temperature, top_p, stop, tools, tool_choice } = body;
  const messages = await resolveImageUrls(body.messages);
  const { baseModel, thinkingEnabled, thinkingVisible } = stripClaudeSuffix(model);
  const modelMax = getClaudeMaxTokens(baseModel);
  // Thinking mode: always use model max (thinking tokens + output tokens both count).
  // Non-thinking: respect caller's max_tokens to honour token budget from main node,
  // but default to model max when unspecified so output is never truncated.
  const maxTokens = thinkingEnabled
    ? modelMax
    : (body.max_tokens && body.max_tokens > 0 ? Math.min(body.max_tokens, modelMax) : modelMax);

  const { system, messages: anthropicMessages } = convertMessagesToAnthropic(messages);

  // Apply cache_control to system + all-but-last messages for Anthropic prompt caching
  const { systemBlock, messages: cachedMessages } = applyAnthropicCacheControl(system, anthropicMessages);

  // When tool_choice is "none", suppress tools entirely (Anthropic has no "none" option)
  const anthropicTools = (tools && tools.length > 0 && tool_choice !== "none")
    ? convertToolsToAnthropic(tools)
    : undefined;
  const anthropicToolChoice = (tool_choice && tool_choice !== "none")
    ? convertToolChoiceToAnthropic(tool_choice)
    : undefined;

  // Anthropic does not allow temperature / top_p when thinking is enabled
  const params: Record<string, unknown> = {
    model: baseModel,
    max_tokens: maxTokens,
    messages: cachedMessages,
    stream: true,
  };
  if (systemBlock) params["system"] = systemBlock;
  else if (system) params["system"] = system;
  if (!thinkingEnabled) {
    if (temperature !== undefined) params["temperature"] = temperature;
    else if (top_p !== undefined) params["top_p"] = top_p;
    if (stop) params["stop_sequences"] = Array.isArray(stop) ? stop : [stop];
  }
  // budget_tokens must leave room for visible output.
  // Cap at 10 000 and at most 60 % of maxTokens so at least 40 % remains for output.
  if (thinkingEnabled) params["thinking"] = { type: "enabled", budget_tokens: Math.min(10000, Math.floor(maxTokens * 0.6)) };
  if (anthropicTools) params["tools"] = anthropicTools;
  if (anthropicToolChoice) params["tool_choice"] = anthropicToolChoice;

  setSseHeaders(res);
  res.write(": init\n\n"); // flush connection immediately -- prevents proxy timeout before first AI token

  const id = `chatcmpl-${Date.now()}`;
  let inThinking = false;
  let inputTokens = 0; // total effective input tokens (fresh + cache_read + cache_write)
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  // Map Anthropic content-block index -> OAI tool_calls index (0-based among tool_use blocks only)
  const blockIdxToToolIdx: Record<number, number> = {};
  let toolCallCount = 0;
  let sseBodyStarted = false; // true after first sseWrite (headers have been flushed to wire)

  const keepaliveInterval = setInterval(() => {
    sseBodyStarted = true;
    res.write(": keepalive\n\n");
  }, 5000);

  try {
    const stream = anthropic.messages.stream(params as Anthropic.MessageCreateParamsStreaming);

    for await (const event of stream) {
      if (event.type === "message_start") {
        // Capture token counts; include cache tokens for accurate stats
        const u = event.message.usage as {
          input_tokens: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        } | undefined;
        inputTokens = (u?.input_tokens ?? 0)
          + (u?.cache_read_input_tokens ?? 0)
          + (u?.cache_creation_input_tokens ?? 0);
        cacheReadTokens = u?.cache_read_input_tokens ?? 0;
        cacheWriteTokens = u?.cache_creation_input_tokens ?? 0;
        sseBodyStarted = true;
        sseWrite(res, makeChunk(id, model, { role: "assistant", content: "" }));

      } else if (event.type === "content_block_start") {
        const block = event.content_block;
        const idx = event.index;

        if (block.type === "thinking") {
          inThinking = true;
          if (thinkingVisible) {
            sseWrite(res, makeChunk(id, model, { content: "<thinking>\n" }));
          }
        } else if (block.type === "text") {
          if (inThinking && thinkingVisible) {
            sseWrite(res, makeChunk(id, model, { content: "\n</thinking>\n\n" }));
          }
          inThinking = false;
        } else if (block.type === "tool_use") {
          // Assign a sequential OAI tool call index (0-based) independent of content block index
          const toolIdx = toolCallCount++;
          blockIdxToToolIdx[idx] = toolIdx;
          sseBodyStarted = true;
          sseWrite(res, makeChunk(id, model, {
            tool_calls: [{
              index: toolIdx,
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: "" },
            }],
          }));
        }

      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        const idx = event.index;

        if (delta.type === "thinking_delta") {
          if (thinkingVisible) {
            sseWrite(res, makeChunk(id, model, { content: delta.thinking }));
          }
        } else if (delta.type === "text_delta") {
          sseWrite(res, makeChunk(id, model, { content: delta.text }));
        } else if (delta.type === "input_json_delta") {
          // Use the mapped OAI tool call index, not the Anthropic content block index
          const toolIdx = blockIdxToToolIdx[idx] ?? 0;
          sseWrite(res, makeChunk(id, model, {
            tool_calls: [{
              index: toolIdx,
              function: { arguments: delta.partial_json },
            }],
          }));
        }

      } else if (event.type === "message_delta") {
        const stopReason = event.delta.stop_reason;
        const finishReason =
          stopReason === "tool_use" ? "tool_calls"
          : stopReason === "end_turn" ? "stop"
          : (stopReason ?? "stop");
        // Build accurate usage: input_tokens from message_start + output_tokens from message_delta
        const outputTokens = event.usage?.output_tokens ?? 0;
        stats.promptTokens = inputTokens;
        stats.completionTokens = outputTokens;
        const usage: Record<string, number> = {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        };
        // Surface cache breakdown for clients that understand it
        if (cacheReadTokens > 0)  usage["cache_read_input_tokens"]  = cacheReadTokens;
        if (cacheWriteTokens > 0) usage["cache_creation_input_tokens"] = cacheWriteTokens;
        sseWrite(res, { ...makeChunk(id, model, {}, finishReason), usage });
      }
    }

    res.write("data: [DONE]\n\n");
  } catch (streamErr) {
    if (sseBodyStarted) {
      // SSE already started -- send an error event so the client knows, then end cleanly
      try {
        sseWrite(res, {
          error: {
            message: streamErr instanceof Error ? streamErr.message : "Stream error",
            type: "stream_error",
          },
        });
        res.write("data: [DONE]\n\n");
      } catch { /* ignore write errors during cleanup */ }
      // Do NOT re-throw: error was communicated via SSE; let finally handle res.end()
    } else {
      // No SSE data written yet -- re-throw so outer catch can send a proper JSON error.
      // Do NOT call res.end() here; let the outer catch's res.json() do it.
      clearInterval(keepaliveInterval);
      throw streamErr;
    }
  } finally {
    clearInterval(keepaliveInterval);
    // End the response only when SSE body was started (success path or mid-stream error).
    // When !sseBodyStarted we re-threw above and the outer catch handles res.end().
    if (sseBodyStarted && !res.writableEnded) res.end();
  }
}

// ----------------------------------------------------------------------
// Anthropic - non-streaming
// ----------------------------------------------------------------------

async function handleClaudeNonStream(
  _req: Request,
  _res: Response,
  body: ChatBody,
  stats: ReqStats
): Promise<Record<string, unknown>> {
  const { model, temperature, top_p, stop, tools, tool_choice } = body;
  const messages = await resolveImageUrls(body.messages);
  const { baseModel, thinkingEnabled, thinkingVisible } = stripClaudeSuffix(model);
  const modelMax = getClaudeMaxTokens(baseModel);
  // Same logic as streaming: thinking -> model max; otherwise honour caller, default to model max.
  const maxTokens = thinkingEnabled
    ? modelMax
    : (body.max_tokens && body.max_tokens > 0 ? Math.min(body.max_tokens, modelMax) : modelMax);

  const { system, messages: anthropicMessages } = convertMessagesToAnthropic(messages);

  // Apply cache_control for Anthropic prompt caching
  const { systemBlock, messages: cachedMessages } = applyAnthropicCacheControl(system, anthropicMessages);

  // When tool_choice is "none", suppress tools entirely (Anthropic has no "none" option)
  const anthropicTools = (tools && tools.length > 0 && tool_choice !== "none")
    ? convertToolsToAnthropic(tools)
    : undefined;
  const anthropicToolChoice = (tool_choice && tool_choice !== "none")
    ? convertToolChoiceToAnthropic(tool_choice)
    : undefined;

  const params: Record<string, unknown> = {
    model: baseModel,
    max_tokens: maxTokens,
    messages: cachedMessages,
    stream: false,
  };
  if (systemBlock) params["system"] = systemBlock;
  else if (system) params["system"] = system;
  if (!thinkingEnabled) {
    if (temperature !== undefined) params["temperature"] = temperature;
    else if (top_p !== undefined) params["top_p"] = top_p;
    if (stop) params["stop_sequences"] = Array.isArray(stop) ? stop : [stop];
  }
  if (thinkingEnabled) params["thinking"] = { type: "enabled", budget_tokens: Math.min(10000, Math.floor(maxTokens * 0.6)) };
  if (anthropicTools) params["tools"] = anthropicTools;
  if (anthropicToolChoice) params["tool_choice"] = anthropicToolChoice;

  // Anthropic SDK v0.82+ throws for non-streaming when max_tokens > ~21333 tokens
  // (expected generation time > 10 min). Use stream().finalMessage() to collect a
  // complete response via streaming without hitting that SDK-level check.
  const streamingParams = { ...params, stream: undefined } as Anthropic.MessageCreateParamsStreaming;
  const response = await anthropic.messages.stream(streamingParams).finalMessage();

  // Collect blocks
  let thinkingText = "";
  let bodyText = "";
  const toolCallResults: Array<{ id: string; name: string; input: unknown }> = [];

  for (const block of response.content) {
    if (block.type === "thinking") {
      thinkingText += (block as { thinking?: string }).thinking ?? "";
    } else if (block.type === "text") {
      bodyText += block.text;
    } else if (block.type === "tool_use") {
      toolCallResults.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  const stopReason = response.stop_reason;
  const finishReason =
    stopReason === "tool_use" ? "tool_calls"
    : stopReason === "end_turn" ? "stop"
    : (stopReason ?? "stop");

  // Compose message
  let fullContent: string | null = bodyText || null;
  if (thinkingText && thinkingVisible) {
    fullContent = `<thinking>${thinkingText}</thinking>\n\n${bodyText}`;
  }

  const id = `chatcmpl-${Date.now()}`;

  const assistantMessage: Record<string, unknown> = {
    role: "assistant",
    content: fullContent,
  };

  if (toolCallResults.length > 0) {
    assistantMessage["tool_calls"] = toolCallResults.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      },
    }));
  }

  // Include cache tokens in the total for accurate stats and cost estimation
  const usageRaw = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  const cacheRead = usageRaw.cache_read_input_tokens ?? 0;
  const cacheWrite = usageRaw.cache_creation_input_tokens ?? 0;
  const totalInput = usageRaw.input_tokens + cacheRead + cacheWrite;

  stats.promptTokens = totalInput;
  stats.completionTokens = usageRaw.output_tokens;

  const usageOut: Record<string, number> = {
    prompt_tokens: totalInput,
    completion_tokens: usageRaw.output_tokens,
    total_tokens: totalInput + usageRaw.output_tokens,
  };
  if (cacheRead > 0)  usageOut["cache_read_input_tokens"]  = cacheRead;
  if (cacheWrite > 0) usageOut["cache_creation_input_tokens"] = cacheWrite;

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: assistantMessage,
      finish_reason: finishReason,
    }],
    usage: usageOut,
  };
}

// ----------------------------------------------------------------------
// Gemini - streaming
// ----------------------------------------------------------------------

async function handleGeminiStream(
  _req: Request,
  res: Response,
  body: ChatBody,
  stats: ReqStats
) {
  const { model, max_tokens, temperature, top_p } = body;
  const { baseModel, thinkingEnabled } = stripGeminiSuffix(model);
  const backendModel = getGeminiBackendModel(baseModel);
  const resolvedMessages = await resolveImageUrls(body.messages);
  const mediaResolution = normalizeGeminiMediaResolution(body.input_media_resolution ?? body.media_resolution);
  const { systemInstruction, contents } = convertMessagesToGemini(resolvedMessages, mediaResolution);

  setSseHeaders(res);
  res.write(": init\n\n");

  const id = `chatcmpl-${Date.now()}`;

  const keepaliveInterval = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 5000);

  try {
    const config: Record<string, unknown> = {
      maxOutputTokens: max_tokens ?? 8192,
    };
    if (temperature !== undefined) config["temperature"] = temperature;
    if (top_p !== undefined) config["topP"] = top_p;
    if (systemInstruction) config["systemInstruction"] = systemInstruction;
    if (thinkingEnabled) config["thinkingConfig"] = { thinkingBudget: -1 };

    sseWrite(res, makeChunk(id, model, { role: "assistant", content: "" }));

    const imageModel = isGeminiImageModel(baseModel);
    let inputTokens = 0;
    let outputTokens = 0;

    if (imageModel) {
      // Image models don't support streaming — use generateContent and send at once
      config["responseModalities"] = [Modality.TEXT, Modality.IMAGE];
      const numImages = body.number_of_images ?? body.n;
      if (numImages && numImages > 1) config["numberOfImages"] = Math.min(numImages, 4);
      applyGeminiImageConfig(config, body, baseModel);
      const response = await gemini.models.generateContent({
        model: backendModel,
        contents,
        config: config as Parameters<typeof gemini.models.generateContent>[0]["config"],
      });
      const allCandidates = response.candidates ?? [];
      const content = allCandidates
        .map(c => extractGeminiContent((c.content?.parts ?? []) as Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }>))
        .filter(Boolean).join("\n\n");
      if (content) sseWrite(res, makeChunk(id, model, { content }));
      inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    } else {
      const stream = await gemini.models.generateContentStream({
        model: backendModel,
        contents,
        config: config as Parameters<typeof gemini.models.generateContentStream>[0]["config"],
      });

      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          sseWrite(res, makeChunk(id, model, { content: text }));
        }
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        }
      }
    }

    stats.promptTokens = inputTokens;
    stats.completionTokens = outputTokens;
    sseWrite(res, makeChunk(id, model, {}, "stop"));
    sseWrite(res, {
      id, object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000), model,
      choices: [],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    });
    res.write("data: [DONE]\n\n");
  } catch (streamErr) {
    try {
      sseWrite(res, {
        error: {
          message: streamErr instanceof Error ? streamErr.message : "Stream error",
          type: "stream_error",
        },
      });
      res.write("data: [DONE]\n\n");
    } catch { /* ignore */ }
  } finally {
    clearInterval(keepaliveInterval);
    if (!res.writableEnded) res.end();
  }
}

// ----------------------------------------------------------------------
// Gemini - non-streaming
// ----------------------------------------------------------------------

async function handleGeminiNonStream(
  _req: Request,
  _res: Response,
  body: ChatBody,
  stats: ReqStats
): Promise<Record<string, unknown>> {
  const { model, max_tokens, temperature, top_p } = body;
  const { baseModel, thinkingEnabled } = stripGeminiSuffix(model);
  const backendModel = getGeminiBackendModel(baseModel);
  const resolvedMessages = await resolveImageUrls(body.messages);
  const mediaResolution = normalizeGeminiMediaResolution(body.input_media_resolution ?? body.media_resolution);
  const { systemInstruction, contents } = convertMessagesToGemini(resolvedMessages, mediaResolution);

  const config: Record<string, unknown> = {
    maxOutputTokens: max_tokens ?? 8192,
  };
  if (temperature !== undefined) config["temperature"] = temperature;
  if (top_p !== undefined) config["topP"] = top_p;
  if (systemInstruction) config["systemInstruction"] = systemInstruction;
  if (thinkingEnabled) config["thinkingConfig"] = { thinkingBudget: -1 };

  const imageModel = isGeminiImageModel(baseModel);
  if (imageModel) {
    config["responseModalities"] = [Modality.TEXT, Modality.IMAGE];
    const numImages = body.number_of_images ?? body.n;
    if (numImages && numImages > 1) config["numberOfImages"] = Math.min(numImages, 4);
    applyGeminiImageConfig(config, body, baseModel);
  }

  const response = await gemini.models.generateContent({
    model: backendModel,
    contents,
    config: config as Parameters<typeof gemini.models.generateContent>[0]["config"],
  });

  const candidates = response.candidates ?? [];
  const text = imageModel
    ? candidates.map(c =>
        extractGeminiContent((c.content?.parts ?? []) as Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }>)
      ).filter(Boolean).join("\n\n")
    : (response.text ?? "");
  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  stats.promptTokens = inputTokens;
  stats.completionTokens = outputTokens;
  const id = `chatcmpl-${Date.now()}`;

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

// ----------------------------------------------------------------------
// OpenRouter - streaming (OpenAI-compatible, uses openrouter client)
// ----------------------------------------------------------------------

async function handleOpenRouterStream(
  _req: Request,
  res: Response,
  body: ChatBody,
  stats: ReqStats
) {
  const cacheAwareBody = applyBedrockAnthropicPromptCache(body);
  const resolvedMessages = await resolveImageUrls(cacheAwareBody.messages);

  const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
    model: cacheAwareBody.model,
    messages: resolvedMessages as OpenAI.ChatCompletionMessageParam[],
    stream: true,
    stream_options: { include_usage: true },
  };

  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.top_p !== undefined) params.top_p = body.top_p;
  if (body.max_tokens !== undefined) params.max_tokens = body.max_tokens;
  if (body.stop !== undefined) params.stop = body.stop as string | string[];

  // Route all anthropic/ models through AWS Bedrock via OpenRouter Provider Routing
  const bedrockParams = cacheAwareBody.model.startsWith("anthropic/")
    ? { ...params, provider: { order: ["Bedrock"], allow_fallbacks: false } }
    : params;

  setSseHeaders(res);
  res.write(": init\n\n");

  const keepaliveInterval = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 5000);

  try {
    const stream = await openrouter.chat.completions.create(
      bedrockParams as OpenAI.Chat.ChatCompletionCreateParamsStreaming
    );
    for await (const chunk of stream) {
      if (chunk.usage) {
        stats.promptTokens = chunk.usage.prompt_tokens ?? 0;
        stats.completionTokens = chunk.usage.completion_tokens ?? 0;
      }
      sseWrite(res, withOpenRouterCacheUsage(chunk));
    }
    res.write("data: [DONE]\n\n");
  } catch (streamErr) {
    try {
      sseWrite(res, {
        error: {
          message: streamErr instanceof Error ? streamErr.message : "Stream error",
          type: "stream_error",
        },
      });
      res.write("data: [DONE]\n\n");
    } catch { /* ignore */ }
  } finally {
    clearInterval(keepaliveInterval);
    if (!res.writableEnded) res.end();
  }
}

// ----------------------------------------------------------------------
// OpenRouter - non-streaming
// ----------------------------------------------------------------------

async function handleOpenRouterNonStream(
  _req: Request,
  _res: Response,
  body: ChatBody,
  stats: ReqStats
): Promise<Record<string, unknown>> {
  const cacheAwareBody = applyBedrockAnthropicPromptCache(body);
  const resolvedMessages = await resolveImageUrls(cacheAwareBody.messages);

  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: cacheAwareBody.model,
    messages: resolvedMessages as OpenAI.ChatCompletionMessageParam[],
    stream: false,
  };

  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.top_p !== undefined) params.top_p = body.top_p;
  if (body.max_tokens !== undefined) params.max_tokens = body.max_tokens;
  if (body.stop !== undefined) params.stop = body.stop as string | string[];
  if (body.seed !== undefined) params.seed = body.seed;

  // Route all anthropic/ models through AWS Bedrock via OpenRouter Provider Routing
  const bedrockParams = cacheAwareBody.model.startsWith("anthropic/")
    ? { ...params, provider: { order: ["Bedrock"], allow_fallbacks: false } }
    : params;

  const response = await openrouter.chat.completions.create(
    bedrockParams as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
  );
  stats.promptTokens = response.usage?.prompt_tokens ?? 0;
  stats.completionTokens = response.usage?.completion_tokens ?? 0;
  return withOpenRouterCacheUsage(response) as unknown as Record<string, unknown>;
}

// ----------------------------------------------------------------------
// OpenAI - streaming
// ----------------------------------------------------------------------

async function handleOpenAIStream(
  _req: Request,
  res: Response,
  body: ChatBody,
  stats: ReqStats
) {
  setSseHeaders(res);
  res.write(": init\n\n"); // flush connection immediately -- prevents proxy timeout before first AI token

  const resolvedMessages = await resolveImageUrls(body.messages);

  // Pass through all OpenAI-compatible params
  const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
    model: body.model,
    messages: resolvedMessages as OpenAI.ChatCompletionMessageParam[],
    stream: true,
    stream_options: { include_usage: true },
  };

  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.top_p !== undefined) params.top_p = body.top_p;
  if (body.max_tokens !== undefined) params.max_tokens = body.max_tokens;
  if (body.stop !== undefined) params.stop = body.stop as string | string[];
  if (body.seed !== undefined) params.seed = body.seed;
  if (body.presence_penalty !== undefined) params.presence_penalty = body.presence_penalty;
  if (body.frequency_penalty !== undefined) params.frequency_penalty = body.frequency_penalty;
  if (body.n !== undefined) params.n = body.n;
  if (body.user !== undefined) params.user = body.user;
  if (body.response_format !== undefined) params.response_format = body.response_format as OpenAI.ResponseFormatText;
  if (body.logprobs !== undefined) params.logprobs = body.logprobs;
  if (body.top_logprobs !== undefined) params.top_logprobs = body.top_logprobs;
  if (body.tools && body.tools.length > 0) {
    params.tools = body.tools as OpenAI.ChatCompletionTool[];
    if (body.tool_choice !== undefined && body.tool_choice !== "none") {
      params.tool_choice = body.tool_choice as OpenAI.ChatCompletionToolChoiceOption;
    }
    if (body.parallel_tool_calls !== undefined) {
      params.parallel_tool_calls = body.parallel_tool_calls;
    }
  }

  const keepaliveInterval = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 5000);

  try {
    const stream = await openai.chat.completions.create(params);
    for await (const chunk of stream) {
      if (chunk.usage) {
        stats.promptTokens = chunk.usage.prompt_tokens ?? 0;
        stats.completionTokens = chunk.usage.completion_tokens ?? 0;
      }
      sseWrite(res, chunk);
    }
    res.write("data: [DONE]\n\n");
  } catch (streamErr) {
    try {
      sseWrite(res, {
        error: {
          message: streamErr instanceof Error ? streamErr.message : "Stream error",
          type: "stream_error",
        },
      });
      res.write("data: [DONE]\n\n");
    } catch { /* ignore write errors during cleanup */ }
  } finally {
    clearInterval(keepaliveInterval);
    if (!res.writableEnded) res.end();
  }
}

// ----------------------------------------------------------------------
// OpenAI - non-streaming
// ----------------------------------------------------------------------

async function handleOpenAINonStream(
  _req: Request,
  _res: Response,
  body: ChatBody,
  stats: ReqStats
): Promise<Record<string, unknown>> {
  const resolvedMessages = await resolveImageUrls(body.messages);

  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: body.model,
    messages: resolvedMessages as OpenAI.ChatCompletionMessageParam[],
    stream: false,
  };

  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.top_p !== undefined) params.top_p = body.top_p;
  if (body.max_tokens !== undefined) params.max_tokens = body.max_tokens;
  if (body.stop !== undefined) params.stop = body.stop as string | string[];
  if (body.seed !== undefined) params.seed = body.seed;
  if (body.presence_penalty !== undefined) params.presence_penalty = body.presence_penalty;
  if (body.frequency_penalty !== undefined) params.frequency_penalty = body.frequency_penalty;
  if (body.n !== undefined) params.n = body.n;
  if (body.user !== undefined) params.user = body.user;
  if (body.response_format !== undefined) params.response_format = body.response_format as OpenAI.ResponseFormatText;
  if (body.logprobs !== undefined) params.logprobs = body.logprobs;
  if (body.top_logprobs !== undefined) params.top_logprobs = body.top_logprobs;
  if (body.tools && body.tools.length > 0) {
    params.tools = body.tools as OpenAI.ChatCompletionTool[];
    if (body.tool_choice !== undefined && body.tool_choice !== "none") {
      params.tool_choice = body.tool_choice as OpenAI.ChatCompletionToolChoiceOption;
    }
    if (body.parallel_tool_calls !== undefined) {
      params.parallel_tool_calls = body.parallel_tool_calls;
    }
  }

  const response = await openai.chat.completions.create(params);
  stats.promptTokens = response.usage?.prompt_tokens ?? 0;
  stats.completionTokens = response.usage?.completion_tokens ?? 0;
  return response as unknown as Record<string, unknown>;
}

// ----------------------------------------------------------------------
// Model name normalization
// Handles display names from clients like Cherry Studio:
// e.g. "[Replit] Claude Opus 4.6" -> "claude-opus-4-6"
// ----------------------------------------------------------------------

function normalizeModelId(model: string): string {
  // Strip any "[Provider] " prefix (e.g. "[Replit] ", "[OpenAI] ")
  let m = model.replace(/^\[.*?\]\s*/, "");
  // If the remaining name contains spaces it's a display name -- convert to API ID format
  if (m.includes(" ")) {
    m = m.toLowerCase()
         .replace(/\s+/g, "-")   // spaces -> dashes
         .replace(/\./g, "-");   // dots   -> dashes
  }
  return m;
}

// ----------------------------------------------------------------------
// Route
// ----------------------------------------------------------------------

router.post("/chat/completions", authMiddleware, async (req: Request, res: Response) => {
  const startTime = Date.now();
  const stats = makeReqStats();
  let model = "";
  let isStream = false;
  try {
    const body = req.body as ChatBody;
    body.model = normalizeModelId(body.model ?? "");
    model = body.model;
    isStream = !!body.stream;
    const { messages, stream } = body;

    if (!model || !messages) {
      res.status(400).json({
        error: { message: "model and messages are required", type: "invalid_request_error" },
      });
      return;
    }

    if (!isModelEnabled(model)) {
      res.status(403).json({
        error: {
          message: `Model '${model}' is currently disabled by the proxy administrator.`,
          type: "invalid_request_error",
          code: "model_disabled",
        },
      });
      return;
    }

    // Resolve model alias: replace friendly name with actual backend model ID
    const resolvedModel = MODEL_ALIASES[model] ?? model;
    const effectiveBody = resolvedModel !== model ? { ...body, model: resolvedModel } : body;

    const isClaude      = resolvedModel.startsWith("claude-");
    const isGemini      = resolvedModel.startsWith("gemini-");
    const isOpenRouter  = !isClaude && !isGemini && resolvedModel.includes("/");

    if (stream) {
      // Streaming — no caching, handle as before
      if (isClaude) await handleClaudeStream(req, res, effectiveBody, stats);
      else if (isGemini) await handleGeminiStream(req, res, effectiveBody, stats);
      else if (isOpenRouter) await handleOpenRouterStream(req, res, effectiveBody, stats);
      else await handleOpenAIStream(req, res, effectiveBody, stats);
    } else {
      // Non-streaming — check cache first
      const cacheKey = hashRequest(effectiveBody);
      const cached = cacheGet(cacheKey);

      if (cached) {
        // Cache hit — return immediately without calling upstream
        res.setHeader("X-Cache", "HIT");
        res.json(cached);
      } else {
        // Cache miss — call handler (returns data without sending response)
        let data: Record<string, unknown>;
        if (isClaude) data = await handleClaudeNonStream(req, res, effectiveBody, stats);
        else if (isGemini) data = await handleGeminiNonStream(req, res, effectiveBody, stats);
        else if (isOpenRouter) data = await handleOpenRouterNonStream(req, res, effectiveBody, stats);
        else data = await handleOpenAINonStream(req, res, effectiveBody, stats);

        cacheSet(cacheKey, data, model);
        res.setHeader("X-Cache", "MISS");
        res.json(data);
      }
    }

    const duration = Date.now() - startTime;
    pushRequestLog({
      method: req.method, path: req.path, model, backend: "local",
      status: 200, duration, stream: isStream,
      promptTokens: stats.promptTokens || undefined,
      completionTokens: stats.completionTokens || undefined,
      level: "info",
    });
    recordModelStat(model, stats.promptTokens, stats.completionTokens);

  } catch (err: unknown) {
    req.log.error({ err }, "Error in /v1/chat/completions");
    const duration = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : "Internal server error";
    pushRequestLog({
      method: req.method, path: req.path, model: model || undefined, backend: "local",
      status: 500, duration, stream: isStream, level: "error", error: errMsg,
    });
    if (!res.headersSent) {
      // Forward upstream API errors with their original status and message
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        typeof (err as { status: unknown }).status === "number"
      ) {
        const apiErr = err as { status: number; message?: string; error?: { message?: string; type?: string } };
        const status = apiErr.status >= 400 ? apiErr.status : 502;
        const message = apiErr.error?.message ?? apiErr.message ?? "Upstream API error";
        const type = apiErr.error?.type ?? "upstream_error";
        res.status(status).json({ error: { message, type } });
      } else {
        res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
      }
    }
  }
});

export default router;
