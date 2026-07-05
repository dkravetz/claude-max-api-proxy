/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import type { OpenAIChatRequest, OpenAIContentBlock, OpenAIImageBlock } from "../types/openai.js";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  sessionId?: string;
  tempFiles: string[];
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names (provider prefixes like `claude-code-cli/` and `claude-max/`
  // are stripped by extractModel before consulting this map)
  "claude-opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-haiku-4": "haiku",
  "claude-haiku-4-5": "haiku",
  // Bare aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
  "opus-max": "opus",
  "sonnet-max": "sonnet",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  // Try direct lookup
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Try stripping provider prefix
  const stripped = model.replace(/^(?:claude-code-cli|claude-max)\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Default to opus (Claude Max subscription)
  return "opus";
}

/**
 * Extract text and images from a content field.
 * Images are written to temp files so Claude can read them via its Read tool.
 * Returns the text content and the list of temp file paths created.
 */
function extractContent(content: string | OpenAIContentBlock[]): {
  text: string;
  imagePaths: string[];
} {
  if (typeof content === "string") {
    return { text: content, imagePaths: [] };
  }
  if (!Array.isArray(content)) {
    return { text: String(content || ""), imagePaths: [] };
  }

  const textParts: string[] = [];
  const imagePaths: string[] = [];

  for (const block of content) {
    if (block.type === "text" || block.type === "input_text") {
      textParts.push((block as { type: string; text: string }).text);
    } else if (block.type === "image_url") {
      const { url } = (block as OpenAIImageBlock).image_url;
      if (url.startsWith("data:")) {
        const commaIdx = url.indexOf(",");
        const header = url.slice(0, commaIdx);
        const data = url.slice(commaIdx + 1);
        const mimeMatch = header.match(/data:([^;]+)/);
        const mime = mimeMatch?.[1] ?? "image/jpeg";
        const ext = mime.split("/")[1]?.split("+")[0] ?? "jpg";
        const filePath = join(tmpdir(), `claude-proxy-${randomBytes(8).toString("hex")}.${ext}`);
        writeFileSync(filePath, Buffer.from(data, "base64"));
        imagePaths.push(filePath);
      }
      // https:// image URLs are not supported — base64 data URIs only
    }
  }

  return { text: textParts.join("\n"), imagePaths };
}

/**
 * Strip OpenClaw-specific tooling sections from system prompts.
 * These reference tools (exec, process, web_search, etc.) that don't exist
 * in the Claude Code CLI environment, causing the model to get confused.
 * We remove: ## Tooling, ## Tool Call Style, ## OpenClaw CLI Quick Reference,
 * ## OpenClaw Self-Update
 */
function stripOpenClawTooling(text: string): string {
  const sectionsToStrip = [
    "## Tooling",
    "## Tool Call Style",
    "## OpenClaw CLI Quick Reference",
    "## OpenClaw Self-Update",
  ];
  let result = text;
  for (const section of sectionsToStrip) {
    // Match from section header to the next ## header (or end of string)
    const pattern = new RegExp(
      section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "\\n[\\s\\S]*?(?=\\n## |$)",
      "g"
    );
    result = result.replace(pattern, "");
  }
  // Clean up excessive blank lines left behind
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI.
 * Also returns any temp image files created so the caller can clean them up.
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 * Images are saved to temp files and Claude is instructed to Read them.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"]
): { prompt: string; tempFiles: string[] } {
  const parts: string[] = [];
  const tempFiles: string[] = [];

  for (const msg of messages) {
    const { text, imagePaths } = extractContent(msg.content);
    tempFiles.push(...imagePaths);

    switch (msg.role) {
      case "system":
        parts.push(`<system>\n${stripOpenClawTooling(text)}\n</system>\n`);
        break;

      case "user": {
        if (imagePaths.length > 0) {
          const filePaths = imagePaths.map((p) => `  - ${p}`).join("\n");
          parts.push(
            `Use the Read tool to read the following image file(s) before responding:\n${filePaths}\n\n${text}`
          );
        } else {
          parts.push(text);
        }
        break;
      }

      case "assistant":
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
    }
  }

  return { prompt: parts.join("\n").trim(), tempFiles };
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const { prompt, tempFiles } = messagesToPrompt(request.messages);
  return {
    prompt,
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
    tempFiles,
  };
}
