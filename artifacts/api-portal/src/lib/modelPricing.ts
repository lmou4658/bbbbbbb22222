export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICING: Record<string, ModelPricing> = {
  // ── Anthropic (direct) ────────────────────────────────────────────────────
  "claude-opus-4-7":               { inputPer1M: 15.00,  outputPer1M: 75.00  },
  "claude-opus-4-6":               { inputPer1M: 15.00,  outputPer1M: 75.00  },
  "claude-opus-4-5":               { inputPer1M: 15.00,  outputPer1M: 75.00  },
  "claude-opus-4-1":               { inputPer1M: 15.00,  outputPer1M: 75.00  },
  "claude-sonnet-4-6":             { inputPer1M: 3.00,   outputPer1M: 15.00  },
  "claude-sonnet-4-5":             { inputPer1M: 3.00,   outputPer1M: 15.00  },
  "claude-haiku-4-5":              { inputPer1M: 0.80,   outputPer1M: 4.00   },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  "gpt-5.2":                       { inputPer1M: 10.00,  outputPer1M: 40.00  },
  "gpt-5.1":                       { inputPer1M: 10.00,  outputPer1M: 40.00  },
  "gpt-5":                         { inputPer1M: 10.00,  outputPer1M: 40.00  },
  "gpt-5-mini":                    { inputPer1M: 2.00,   outputPer1M: 8.00   },
  "gpt-5-nano":                    { inputPer1M: 0.50,   outputPer1M: 2.00   },
  "gpt-4.1":                       { inputPer1M: 2.00,   outputPer1M: 8.00   },
  "gpt-4.1-mini":                  { inputPer1M: 0.40,   outputPer1M: 1.60   },
  "gpt-4.1-nano":                  { inputPer1M: 0.10,   outputPer1M: 0.40   },
  "gpt-4o":                        { inputPer1M: 2.50,   outputPer1M: 10.00  },
  "gpt-4o-mini":                   { inputPer1M: 0.15,   outputPer1M: 0.60   },
  "o4-mini":                       { inputPer1M: 1.10,   outputPer1M: 4.40   },
  "o4-mini-thinking":              { inputPer1M: 1.10,   outputPer1M: 4.40   },
  "o3":                            { inputPer1M: 10.00,  outputPer1M: 40.00  },
  "o3-thinking":                   { inputPer1M: 10.00,  outputPer1M: 40.00  },
  "o3-mini":                       { inputPer1M: 1.10,   outputPer1M: 4.40   },
  "o3-mini-thinking":              { inputPer1M: 1.10,   outputPer1M: 4.40   },

  // ── Google Gemini ─────────────────────────────────────────────────────────
  "gemini-3.1-pro-preview":        { inputPer1M: 1.25,   outputPer1M: 10.00  },
  "gemini-3-flash-preview":        { inputPer1M: 0.15,   outputPer1M: 0.60   },
  "gemini-2.5-pro":                { inputPer1M: 1.25,   outputPer1M: 10.00  },
  "gemini-2.5-flash":              { inputPer1M: 0.15,   outputPer1M: 0.60   },

  // ── OpenRouter ────────────────────────────────────────────────────────────
  "x-ai/grok-4.20":                { inputPer1M: 3.00,   outputPer1M: 15.00  },
  "x-ai/grok-4.1-fast":            { inputPer1M: 2.00,   outputPer1M: 10.00  },
  "x-ai/grok-4-fast":              { inputPer1M: 2.00,   outputPer1M: 10.00  },
  "meta-llama/llama-4-maverick":   { inputPer1M: 0.19,   outputPer1M: 0.85   },
  "meta-llama/llama-4-scout":      { inputPer1M: 0.18,   outputPer1M: 0.73   },
  "deepseek/deepseek-v3.2":        { inputPer1M: 0.28,   outputPer1M: 1.10   },
  "deepseek/deepseek-r1":          { inputPer1M: 0.55,   outputPer1M: 2.19   },
  "deepseek/deepseek-r1-0528":     { inputPer1M: 0.55,   outputPer1M: 2.19   },
  "mistralai/mistral-small-2603":  { inputPer1M: 0.10,   outputPer1M: 0.30   },
  "qwen/qwen3.5-122b-a10b":        { inputPer1M: 0.40,   outputPer1M: 1.20   },
  "google/gemini-2.5-pro":         { inputPer1M: 1.25,   outputPer1M: 10.00  },
  "anthropic/claude-opus-4.6":     { inputPer1M: 15.00,  outputPer1M: 75.00  },
  "anthropic/claude-opus-4.6-fast":{ inputPer1M: 7.50,   outputPer1M: 37.50  },
};

/** Strip thinking suffixes added by the proxy before looking up pricing. */
function normalizeModel(model: string): string {
  return model
    .replace(/-thinking-visible$/, "")
    .replace(/-thinking$/, "");
}

export function getModelPricing(model: string): ModelPricing | null {
  const key = normalizeModel(model);
  return PRICING[key] ?? null;
}

/** Calculate cost in USD given token counts. Returns null if no pricing found. */
export function calcCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const p = getModelPricing(model);
  if (!p) return null;
  return (promptTokens / 1_000_000) * p.inputPer1M
       + (completionTokens / 1_000_000) * p.outputPer1M;
}

/** Format a USD cost for display. */
export function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return `$${usd.toExponential(2)}`;
  if (usd < 0.01)   return `$${usd.toFixed(5)}`;
  if (usd < 1)      return `$${usd.toFixed(4)}`;
  if (usd < 100)    return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
