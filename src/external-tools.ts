// External tool providers - enables capabilities beyond what Claude can do natively.
// Uses native fetch (no external dependencies) to call provider APIs.
// Supported providers: Gemini, OpenAI (extensible to others).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import {
  EXTERNAL_TOOLS_ENABLED,
  EXTERNAL_TOOL_PROVIDERS,
  PROJECT_ROOT,
  DRY_RUN,
} from "./config.js";
import { log, startTimer } from "./logger.js";
import type {
  ExternalToolProviderConfig,
  ExternalToolResult,
  ExternalToolRequest,
  ExternalToolCapability,
} from "./types.js";

// --- Capability Registry ---

/** Maps capabilities to provider names that support them. */
const PROVIDER_CAPABILITIES: Record<string, ExternalToolCapability[]> = {
  gemini: ["image_generation", "vision", "web_search", "code_execution", "general"],
  openai: ["image_generation", "vision", "general"],
};

/** Path to file where Claude can write external tool requests. */
const TOOL_REQUEST_FILE = resolve(PROJECT_ROOT, ".clawdup.tool-requests.json");

/** Path to file where external tool results are stored for Claude to read. */
const TOOL_RESULTS_FILE = resolve(PROJECT_ROOT, ".clawdup.tool-results.json");

/**
 * Check if external tools are available and configured.
 */
export function hasExternalTools(): boolean {
  return EXTERNAL_TOOLS_ENABLED && EXTERNAL_TOOL_PROVIDERS.length > 0;
}

/**
 * Get a list of available providers and their capabilities.
 * Used to inform Claude about what external tools are available.
 */
export function getAvailableToolsSummary(): string {
  if (!hasExternalTools()) return "";

  const lines: string[] = ["## Available External Tools\n"];
  lines.push("The following external tool providers are configured and available.");
  lines.push("To request an external tool, create a file called `.clawdup.tool-requests.json` in the project root.");
  lines.push("The file should contain a JSON array of request objects.\n");
  lines.push("**Request format:**");
  lines.push("```json");
  lines.push(`[
  {
    "provider": "<provider-name>",
    "capability": "<capability>",
    "prompt": "<what you need the tool to do>",
    "params": {}
  }
]`);
  lines.push("```\n");
  lines.push("**Available providers:**\n");

  for (const provider of EXTERNAL_TOOL_PROVIDERS) {
    if (!provider.enabled) continue;
    const caps = PROVIDER_CAPABILITIES[provider.name] || ["general"];
    const modelStr = provider.model ? ` (model: ${provider.model})` : "";
    lines.push(`- **${provider.name}**${modelStr}: ${caps.join(", ")}`);
  }

  lines.push("");
  lines.push("**Capabilities explained:**");
  lines.push("- `image_generation`: Generate images from text descriptions. Params: `{ width?: number, height?: number }`");
  lines.push("- `vision`: Analyze images (pass image URL or base64 in params). Params: `{ image_url?: string }`");
  lines.push("- `web_search`: Search the web for information. The prompt is the search query.");
  lines.push("- `code_execution`: Execute code snippets. Params: `{ language?: string }`");
  lines.push("- `general`: General text generation/completion.\n");
  lines.push("After you create the request file, the automation will execute the tools and provide results back to you.");
  lines.push("The results will be written to `.clawdup.tool-results.json` in the project root.");
  lines.push("**Important:** Only request external tools for tasks you genuinely cannot do yourself (e.g., generating images, searching the live web).");

  return lines.join("\n");
}

/**
 * Read external tool requests written by Claude.
 * Returns the parsed requests or an empty array if no file exists.
 */
export function readToolRequests(): ExternalToolRequest[] {
  try {
    if (!existsSync(TOOL_REQUEST_FILE)) return [];
    const raw = readFileSync(TOOL_REQUEST_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log("warn", "Tool request file is not an array, ignoring");
      return [];
    }
    return parsed as ExternalToolRequest[];
  } catch (err) {
    log("warn", `Failed to read tool requests: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Write external tool results so Claude can read them on resume.
 */
export function writeToolResults(results: ExternalToolResult[]): void {
  try {
    const dir = dirname(TOOL_RESULTS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(TOOL_RESULTS_FILE, JSON.stringify(results, null, 2) + "\n");
    log("debug", `Wrote ${results.length} tool result(s) to ${TOOL_RESULTS_FILE}`);
  } catch (err) {
    log("warn", `Failed to write tool results: ${(err as Error).message}`);
  }
}

/**
 * Clean up tool request and result files after processing.
 */
export function cleanupToolFiles(): void {
  try {
    if (existsSync(TOOL_REQUEST_FILE)) {
      writeFileSync(TOOL_REQUEST_FILE, "[]");
    }
  } catch {
    // ignore cleanup errors
  }
}

/**
 * Find the best provider for a given capability.
 */
function findProvider(
  providerName?: string,
  capability?: ExternalToolCapability,
): ExternalToolProviderConfig | undefined {
  const enabledProviders = EXTERNAL_TOOL_PROVIDERS.filter((p) => p.enabled);

  if (providerName) {
    return enabledProviders.find((p) => p.name === providerName.toLowerCase());
  }

  if (capability) {
    return enabledProviders.find((p) => {
      const caps = PROVIDER_CAPABILITIES[p.name] || [];
      return caps.includes(capability);
    });
  }

  return enabledProviders[0];
}

/**
 * Execute a single external tool request.
 */
async function executeRequest(request: ExternalToolRequest): Promise<ExternalToolResult> {
  const provider = findProvider(
    request.provider,
    request.capability as ExternalToolCapability,
  );

  if (!provider) {
    return {
      success: false,
      output: "",
      error: `No provider found for: ${request.provider || request.capability}`,
      provider: request.provider || "unknown",
    };
  }

  log("info", `Executing external tool: ${provider.name} (${request.capability})`, {
    provider: provider.name,
    capability: request.capability,
  });

  switch (provider.name) {
    case "gemini":
      return executeGemini(provider, request);
    case "openai":
      return executeOpenAI(provider, request);
    default:
      return {
        success: false,
        output: "",
        error: `Unknown provider: ${provider.name}`,
        provider: provider.name,
      };
  }
}

/**
 * Execute all pending external tool requests.
 * Reads requests from the request file, executes them, and writes results.
 */
export async function processToolRequests(): Promise<ExternalToolResult[]> {
  const requests = readToolRequests();
  if (requests.length === 0) return [];

  if (DRY_RUN) {
    log("info", `[DRY RUN] Would execute ${requests.length} external tool request(s)`);
    return requests.map((r) => ({
      success: true,
      output: `[DRY RUN] Would execute ${r.capability} via ${r.provider}`,
      provider: r.provider,
    }));
  }

  log("info", `Processing ${requests.length} external tool request(s)...`);
  const timer = startTimer();

  const results: ExternalToolResult[] = [];
  for (const request of requests) {
    try {
      const result = await executeRequest(request);
      results.push(result);
      if (result.success) {
        log("info", `External tool ${result.provider} succeeded`, { elapsed: timer() });
      } else {
        log("warn", `External tool ${result.provider} failed: ${result.error}`, { elapsed: timer() });
      }
    } catch (err) {
      results.push({
        success: false,
        output: "",
        error: `Unexpected error: ${(err as Error).message}`,
        provider: request.provider || "unknown",
      });
    }
  }

  writeToolResults(results);
  cleanupToolFiles();

  log("info", `Completed ${results.length} external tool request(s)`, { elapsed: timer() });
  return results;
}

/**
 * Detect if a task likely needs external tools based on keywords.
 * Returns an array of suggested capabilities.
 */
export function detectExternalToolNeeds(taskContent: string): ExternalToolCapability[] {
  const lower = taskContent.toLowerCase();
  const needs: ExternalToolCapability[] = [];

  const IMAGE_KEYWORDS = [
    "generate image", "create image", "generate a image",
    "image generation", "create an image", "generate an image",
    "create a logo", "generate a logo", "design an icon",
    "create an icon", "generate icon", "create illustration",
    "generate illustration", "draw", "create artwork",
    "generate a picture", "create a picture",
  ];

  const VISION_KEYWORDS = [
    "analyze image", "describe image", "what's in this image",
    "read this screenshot", "ocr", "extract text from image",
  ];

  const SEARCH_KEYWORDS = [
    "search the web", "look up online", "find online",
    "current information about", "latest news about",
    "what is the current",
  ];

  if (IMAGE_KEYWORDS.some((kw) => lower.includes(kw))) {
    needs.push("image_generation");
  }
  if (VISION_KEYWORDS.some((kw) => lower.includes(kw))) {
    needs.push("vision");
  }
  if (SEARCH_KEYWORDS.some((kw) => lower.includes(kw))) {
    needs.push("web_search");
  }

  return needs;
}

// --- Provider Implementations ---

/**
 * Execute a request using the Gemini API (Google AI).
 * Uses the Gemini REST API directly via native fetch.
 */
async function executeGemini(
  config: ExternalToolProviderConfig,
  request: ExternalToolRequest,
): Promise<ExternalToolResult> {
  const model = config.model || "gemini-2.0-flash";

  if (request.capability === "image_generation") {
    return executeGeminiImageGeneration(config, request, model);
  }

  // General text generation
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: request.prompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 8192,
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        output: "",
        error: `Gemini API error (${response.status}): ${errorText}`,
        provider: "gemini",
        metadata: { model, status: response.status },
      };
    }

    const data = (await response.json()) as GeminiResponse;
    const text = extractGeminiText(data);

    return {
      success: true,
      output: text,
      provider: "gemini",
      metadata: { model },
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `Gemini fetch error: ${(err as Error).message}`,
      provider: "gemini",
    };
  }
}

/**
 * Execute image generation using Gemini's Imagen model.
 * Gemini 2.0 Flash supports native image generation.
 * Generated images are saved to the project root.
 */
async function executeGeminiImageGeneration(
  config: ExternalToolProviderConfig,
  request: ExternalToolRequest,
  model: string,
): Promise<ExternalToolResult> {
  const imageModel = "gemini-2.0-flash-exp"; // Supports image generation
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:generateContent?key=${config.apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: `Generate an image: ${request.prompt}` }],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        output: "",
        error: `Gemini image generation error (${response.status}): ${errorText}`,
        provider: "gemini",
        metadata: { model: imageModel, status: response.status },
      };
    }

    const data = (await response.json()) as GeminiResponse;
    const parts = data.candidates?.[0]?.content?.parts || [];
    const savedFiles: string[] = [];
    let textOutput = "";

    for (const part of parts) {
      if (part.inlineData?.mimeType && part.inlineData?.data) {
        // Save the image to the project root
        const ext = part.inlineData.mimeType.split("/")[1] || "png";
        const filename = `generated-image-${Date.now()}.${ext}`;
        const filepath = resolve(PROJECT_ROOT, filename);
        const buffer = Buffer.from(part.inlineData.data, "base64");
        writeFileSync(filepath, buffer);
        savedFiles.push(filename);
        log("info", `Saved generated image: ${filename}`);
      }
      if (part.text) {
        textOutput += part.text;
      }
    }

    if (savedFiles.length > 0) {
      const fileList = savedFiles.map((f) => `- ${f}`).join("\n");
      return {
        success: true,
        output: `Generated ${savedFiles.length} image(s):\n${fileList}${textOutput ? `\n\n${textOutput}` : ""}`,
        provider: "gemini",
        metadata: { model: imageModel, files: savedFiles },
      };
    }

    return {
      success: true,
      output: textOutput || "Image generation completed but no image data was returned.",
      provider: "gemini",
      metadata: { model: imageModel },
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `Gemini image generation fetch error: ${(err as Error).message}`,
      provider: "gemini",
    };
  }
}

/**
 * Execute a request using the OpenAI API.
 * Uses the OpenAI REST API directly via native fetch.
 */
async function executeOpenAI(
  config: ExternalToolProviderConfig,
  request: ExternalToolRequest,
): Promise<ExternalToolResult> {
  const model = config.model || "gpt-4o";

  if (request.capability === "image_generation") {
    return executeOpenAIImageGeneration(config, request);
  }

  // General text generation via chat completions
  const url = "https://api.openai.com/v1/chat/completions";

  const body = {
    model,
    messages: [{ role: "user", content: request.prompt }],
    max_tokens: 4096,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        output: "",
        error: `OpenAI API error (${response.status}): ${errorText}`,
        provider: "openai",
        metadata: { model, status: response.status },
      };
    }

    const data = (await response.json()) as OpenAIResponse;
    const text = data.choices?.[0]?.message?.content || "";

    return {
      success: true,
      output: text,
      provider: "openai",
      metadata: { model },
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `OpenAI fetch error: ${(err as Error).message}`,
      provider: "openai",
    };
  }
}

/**
 * Execute image generation using OpenAI's DALL-E API.
 */
async function executeOpenAIImageGeneration(
  config: ExternalToolProviderConfig,
  request: ExternalToolRequest,
): Promise<ExternalToolResult> {
  const url = "https://api.openai.com/v1/images/generations";
  const params = (request.params || {}) as Record<string, unknown>;

  const body = {
    model: "dall-e-3",
    prompt: request.prompt,
    n: 1,
    size: `${params.width || 1024}x${params.height || 1024}`,
    response_format: "b64_json",
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        output: "",
        error: `OpenAI DALL-E error (${response.status}): ${errorText}`,
        provider: "openai",
        metadata: { status: response.status },
      };
    }

    const data = (await response.json()) as OpenAIImageResponse;
    const savedFiles: string[] = [];

    for (const img of data.data || []) {
      if (img.b64_json) {
        const filename = `generated-image-${Date.now()}.png`;
        const filepath = resolve(PROJECT_ROOT, filename);
        const buffer = Buffer.from(img.b64_json, "base64");
        writeFileSync(filepath, buffer);
        savedFiles.push(filename);
        log("info", `Saved generated image: ${filename}`);
      }
    }

    if (savedFiles.length > 0) {
      const fileList = savedFiles.map((f) => `- ${f}`).join("\n");
      return {
        success: true,
        output: `Generated ${savedFiles.length} image(s):\n${fileList}`,
        provider: "openai",
        metadata: { model: "dall-e-3", files: savedFiles },
      };
    }

    return {
      success: true,
      output: "Image generation completed but no image data was returned.",
      provider: "openai",
      metadata: { model: "dall-e-3" },
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `OpenAI DALL-E fetch error: ${(err as Error).message}`,
      provider: "openai",
    };
  }
}

// --- API Response Types (internal) ---

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
  }>;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
}

interface OpenAIImageResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
}

function extractGeminiText(data: GeminiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join("\n");
}
