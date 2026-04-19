/**
 * scripts/setup-integrations.mjs
 *
 * Reference script for the four AI integrations the agent must configure
 * automatically on first project open / remix. The agent should call the
 * `setupReplitAIIntegrations` callback (available only inside the agent's
 * code execution sandbox) — this file documents the exact arguments.
 *
 * See replit.md "MANDATORY FIRST-RUN SETUP" for the agent contract.
 */

export const integrations = [
  {
    label: "Anthropic",
    providerSlug: "anthropic",
    providerApiKeyEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
    providerUrlEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
  },
  {
    label: "OpenAI",
    providerSlug: "openai",
    providerApiKeyEnvVarName: "AI_INTEGRATIONS_OPENAI_API_KEY",
    providerUrlEnvVarName: "AI_INTEGRATIONS_OPENAI_BASE_URL",
  },
  {
    label: "Gemini",
    providerSlug: "gemini",
    providerApiKeyEnvVarName: "AI_INTEGRATIONS_GEMINI_API_KEY",
    providerUrlEnvVarName: "AI_INTEGRATIONS_GEMINI_BASE_URL",
  },
  {
    label: "OpenRouter",
    providerSlug: "openrouter",
    providerApiKeyEnvVarName: "AI_INTEGRATIONS_OPENROUTER_API_KEY",
    providerUrlEnvVarName: "AI_INTEGRATIONS_OPENROUTER_BASE_URL",
  },
];

console.log("This file documents the integrations the agent will configure.");
console.log("See replit.md for the exact code the agent runs automatically.");
for (const i of integrations) {
  console.log(`- ${i.label} (${i.providerSlug}) -> ${i.providerApiKeyEnvVarName}`);
}
