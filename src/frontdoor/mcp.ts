/**
 * Embedded Playwright MCP client. Spawns `npx @playwright/mcp …` over stdio for
 * one browser session per front-door request. Always call stop() in a finally.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '../config.ts';

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolResult = {
  ok: boolean;
  text: string;
  raw: unknown;
};

export class PlaywrightMcpSession {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    const transport = new StdioClientTransport({
      command: config.frontdoor.mcpCommand,
      args: config.frontdoor.mcpArgs,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'intake-grader-frontdoor', version: '0.1.0' });
    await client.connect(transport);
    this.transport = transport;
    this.client = client;
    this.started = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    this.assertStarted();
    const listed = await this.client!.listTools();
    return (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    this.assertStarted();
    try {
      const result = await this.client!.callTool({ name, arguments: args });
      const text = contentToText(result);
      const isError = !!(result as { isError?: boolean }).isError;
      return { ok: !isError, text, raw: result };
    } catch (err) {
      return { ok: false, text: (err as Error).message, raw: null };
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      await this.client?.close();
    } catch {
      // process may already be gone
    }
    try {
      await this.transport?.close();
    } catch {
      // ignore
    }
    this.client = null;
    this.transport = null;
  }

  private assertStarted(): void {
    if (!this.started || !this.client) throw new Error('Playwright MCP session is not started');
  }
}

function contentToText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content) || content.length === 0) {
    try {
      return JSON.stringify(result).slice(0, 8_000);
    } catch {
      return String(result);
    }
  }
  return content
    .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n')
    .slice(0, 12_000);
}
