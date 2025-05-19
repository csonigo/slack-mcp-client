import logger from "../shared/logger.js";
import { z } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

import { Tool } from "./Tool.js";
import { SlackOAuthClientProvider } from "./SlackOauthClientProvider.js";
import { McpSession } from "./McpSession.js";

import type { User, McpServerAuth } from "../shared/User.js";
import { userStore } from "../shared/userStore.js";
import { getOrThrow } from "../shared/utils.js";

const HttpClientConfig = z.object({
    url: z.string().url(),
    env: z.record(z.string(), z.string()).optional(),
});

const SseClientConfig = z.object({
    url: z.string().url(),
    env: z.record(z.string(), z.string()).optional(),
});

const StdioClientConfig = z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
});

export const McpClientConfig = z.union([StdioClientConfig, SseClientConfig, HttpClientConfig]);
export type McpClientConfig = z.infer<typeof McpClientConfig>;

const McpToolProperty = z.object({
    type: z.string(),
    description: z.string().default(""),
});
type McpToolProperty = z.infer<typeof McpToolProperty>;

const McpToolSchema = z.object({
    type: z.string(),
    properties: z.record(z.string(), McpToolProperty).default({}),
    required: z.array(z.string()).default([]),
});
export type McpToolSchema = z.infer<typeof McpToolSchema>;

export const McpTool = z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: McpToolSchema,
});
export type McpTool = z.infer<typeof McpTool>;

export const McpToolsArray = z.array(McpTool);

export class McpClient {
    private _config: McpClientConfig;
    private _transport: SSEClientTransport | StdioClientTransport | StreamableHTTPClientTransport | null;
    private _client: Client;
    private _connected: boolean = false;
    private _userId: string;
    private _serverUrl: string;
    private _authProvider: OAuthClientProvider | null = null;
    private _serverName: string;
    public tools: Record<string, Tool> = {};

    constructor(serverName: string, config: McpClientConfig, userId: string) {
        this._serverName = serverName;
        this._config = config;
        this._userId = userId;
        this._serverUrl = (config as { url: string }).url;
        this._transport = null;
        this._client = new Client(
            {
                name: this.serverName,
                version: "1.0.0",
            },
            {
                capabilities: {
                    prompts: {},
                    resources: {},
                    tools: {},
                },
            },
        );
        this._connected = false;
        this._authProvider = null;
    }

    get serverName(): string {
        return this._serverName;
    }

    get authProvider(): OAuthClientProvider | null {
        return this._authProvider;
    }

    get serverUrl(): string {
        return this._serverUrl;
    }

    get user(): User {
        const user = userStore.get(this._userId);
        if (!user) {
            throw new Error("No User for client " + this.serverName);
        }
        return user;
    }

    get mcpSession(): McpSession {
        const user = this.user;
        if (!user.mcpSession) {
            throw new Error("No MCP session for client " + this.serverName);
        }
        return user.mcpSession;
    }

    get mcpServerAuth(): McpServerAuth | undefined {
        return this.user.mcpServerAuths[this._serverUrl];
    }

    set mcpServerAuth(auth: McpServerAuth) {
        this.user.mcpServerAuths[this._serverUrl] = auth;
        userStore.update(this._userId, this.user);
    }

    async connect() {
        if (this._connected) {
            logger.warn("MCP client " + this.serverName + " is already connected.");
            return;
        }
        try {
            logger.debug(
                "Connecting to MCP server " + this.serverName + " with config: " + JSON.stringify(this._config),
            );
            if ("url" in this._config && this._config.url.endsWith("/sse")) {
                // To update for new workflow to detect http or sse
                await this.setupAuthProvider();
                this._transport = new SSEClientTransport(new URL(this._config.url));
            } else if ("url" in this._config) {
                await this.setupAuthProvider();
                this._transport = new StreamableHTTPClientTransport(new URL(this._config.url), {
                    authProvider: this._authProvider!,
                });
            } else if ("command" in this._config) {
                this._transport = new StdioClientTransport({
                    command: this._config.command,
                    args: this._config.args,
                });
            }
            await this._client.connect(this._transport as Transport);
            this._connected = true;

            logger.info("Connected to MCP Server " + this.serverName);
            return true;
        } catch (error) {
            if (error instanceof UnauthorizedError) {
                return false;
            }
            throw error;
        }
    }

    async disconnect() {
        if (!this._client) {
            throw new Error(`Cannot disconnect from ${this.serverName} because server is not initialized`);
        }
        await this._client.close();
        this._connected = false;
    }

    async listTools() {
        try {
            if (!this._connected) {
                return {};
            }
            const clientTools = (await this._client.listTools()).tools;
            const mcpToolsArray = McpToolsArray.parse(clientTools); // TODO use exported tool type & schema from the sdk
            mcpToolsArray.forEach((tool) => {
                this.tools[tool.name] = new Tool(tool, this.serverName);
            });
            logger.debug("Tools for " + this.serverName + ": " + JSON.stringify(this.tools));
        } catch (error) {
            logger.error("Error listing tools for " + this.serverName + ": " + error);
            return {};
        }
    }

    private async setupAuthProvider() {
        if (!this.mcpServerAuth) {
            logger.debug("Creating new auth for server " + this._serverUrl);
            this.mcpServerAuth = {
                serverUrl: this._serverUrl,
                serverName: this.serverName,
            };
        }
        const stateData = {
            userId: this._userId,
            serverUrl: this._serverUrl,
        };
        const encodedState = Buffer.from(JSON.stringify(stateData)).toString("base64");
        const redirectUrl = getOrThrow("AUTH_REDIRECT_URL") + "?state=" + encodedState;
        this._authProvider = new SlackOAuthClientProvider(this._userId, this._serverUrl, redirectUrl);
    }

    async executeTool(toolName: string, toolArgs: Record<string, any>): Promise<any> {
        try {
            const result = await this._client.callTool({
                name: toolName,
                arguments: toolArgs,
            });
            return result;
        } catch (error) {
            // TODO: define error types
            logger.error("Error executing tool " + toolName + " for " + this.serverName + ": " + error);
            throw error;
        }
    }
}
