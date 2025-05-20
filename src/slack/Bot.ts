import bolt, { type AssistantThreadStartedMiddleware, type AssistantUserMessageMiddleware } from "@slack/bolt";
import { getOrThrow } from "../shared/utils.js";
import type { ConversationsRepliesResponse, RichTextSection, RichTextBlock, RichTextText } from "@slack/web-api";
import { llmClient } from "../llm/llmClient.js";
import type {
    ChatCompletionMessageParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import logger from "../shared/logger.js";
import messageBuilder from "./messageBuilder.js";
import { McpSession } from "../mcp/McpSession.js";
import { slackClient } from "./slackClient.js";
import { userStore } from "../shared/userStore.js";
import { User } from "../shared/User.js";
import { authCallback } from "./authController.js";
import type { RequestHandler } from "express";
import type { ToolCallRequest } from "../mcp/McpSession.js";

export class Bot {
    private _app: bolt.App;
    private _receiver: bolt.ExpressReceiver;
    constructor() {
        this._receiver = new bolt.ExpressReceiver({ signingSecret: getOrThrow("SLACK_SIGNING_SECRET") });

        this._app = new bolt.App({
            token: getOrThrow("SLACK_BOT_TOKEN"),
            appToken: getOrThrow("SLACK_APP_TOKEN"),
            signingSecret: getOrThrow("SLACK_SIGNING_SECRET"),
            logLevel: bolt.LogLevel.INFO,
            receiver: this._receiver,
        });
    }

    async start() {
        const assistant = new bolt.Assistant({
            threadStarted: this._threadStarted,
            userMessage: this._userMessage,
        });

        this._app.assistant(assistant);
        this._app.action("approve_tool_call", this._proceedWithToolCallAction);
        this._app.action("cancel_tool_call", this._cancelToolCallAction);
        this._app.action("redirect", this._redirectAction);

        this._receiver.router.get("/auth/callback", authCallback as RequestHandler);
        await this._app.start(process.env.PORT || 3000);
    }

    // Only usefull to ack() and remove the warning from the slack interface
    private _redirectAction = async ({
        ack,
        respond,
    }: bolt.SlackActionMiddlewareArgs<bolt.BlockAction<bolt.ButtonAction>>) => {
        ack();
        await respond({ text: "Check your browser!" });
    };

    private _cancelToolCallAction = async ({
        ack,
        respond,
    }: bolt.SlackActionMiddlewareArgs<bolt.BlockAction<bolt.ButtonAction>>) => {
        ack();
        await respond({
            text: "Ok, I'm not going to use that tool. What else can I do for you?",
        });
    };

    private _proceedWithToolCallAction = async ({
        payload,
        body,
        action,
        ack,
        respond,
        say,
    }: bolt.SlackActionMiddlewareArgs<bolt.BlockAction<bolt.ButtonAction>>) => {
        ack();
        let toolRequests: ToolCallRequest[] = [];
        try {
            toolRequests = Bot._extractToolCallRequest(body);
        } catch (e) {
            logger.error(e);
            await respond({ text: "Sorry something went wrong. Please try again." });
            return;
        }
        const user = userStore.get(body.user.id);
        const mcpSession = user?.mcpSession;
        if (!mcpSession) {
            logger.error("No mcpSession found for userId: " + body.user.id);
            await respond({ text: "Sorry something went wrong. Please try again." });
            return;
        }

        await respond({ text: "Ok, I'm working on it..." });

        await Promise.all(
            toolRequests.map((toolCallRequest) => this._processToolCallRequest(toolCallRequest, mcpSession)),
        );
        if (!toolRequests.every((toolCallRequest) => toolCallRequest.success)) {
            await respond({ text: "Sorry something went wrong. Please try again." });
            return;
        }
        const chatCompletionMessages: ChatCompletionMessageParam[] = [];
        chatCompletionMessages.push({
            role: "system",
            content: `
            You are a helpful assistant. You've just used a tool and received results. Interpret these results for the user in a clear, helpful way. Please format your response as markdown.
            Just give me your interpretation of the results, no extra text before.`,
        });
        let toolCallResultsMessages = "I used the tools:\n";
        toolCallResultsMessages += toolRequests.map((toolCallRequest) => {
            return `- ${toolCallRequest.toolName} with arguments "${toolCallRequest.toolArgs}" and got this result:\n${toolCallRequest.toolCallResult.content[0].text}\n`; //TODO type the toolCallResult
        });
        toolCallResultsMessages += "\n\nPlease interpret these results for me.";
        chatCompletionMessages.push({
            role: "user",
            content: toolCallResultsMessages,
        });
        const interpretation = await llmClient.getResponse(chatCompletionMessages, []);
        logger.debug(
            "Tool call interpretated for tools : " +
                toolRequests.map((toolCallRequest) => toolCallRequest.toolName).join(", ") +
                " - " +
                interpretation?.content,
        );
        await slackClient.postMarkdown(interpretation?.content || "...", mcpSession.threadTs, mcpSession.channelId);
    };

    // This event correspond to the start of an mcpSession. Opening a new thread closes the previous mcpSession
    private _threadStarted: AssistantThreadStartedMiddleware = async ({ event, say }) => {
        logger.debug(
            "Thread started for user " +
                event.assistant_thread.user_id +
                " with thread ts " +
                event.assistant_thread.thread_ts,
        );
        try {
            let user = userStore.get(event.assistant_thread.user_id);
            if (user) {
                // Close the previous mcp session of the current user if it exists.
                if (user.mcpSession) {
                    logger.debug("Deleting previous mcp session for user " + user);
                    user.closeMcpSession();
                }
            } else {
                user = new User(event.assistant_thread.user_id);
                userStore.new(event.assistant_thread.user_id, user);
            }

            await user.startMcpSession(event.assistant_thread.thread_ts, event.assistant_thread.channel_id);
        } catch (e) {
            logger.error(e);
            say("I'm sorry, something went wrong. Please try starting a new conversation.");
        }
    };

    private _userMessage: AssistantUserMessageMiddleware = async ({ client, message, say }) => {
        try {
            const { isInThread, message: messageInThread } = Bot._isMessageInThread(message);
            if (!isInThread) {
                say("I'm sorry, I can only help in a thread!");
                return;
            }
            const user = userStore.get(messageInThread.user);
            if (!user) {
                logger.error("user not found : " + messageInThread.user);
                say("I'm sorry, something went wrong. Please try again in a little while.");
                return;
            }
            const mcpSession = user.mcpSession;
            if (!mcpSession) {
                logger.error("mcpSession not found for thread: " + messageInThread.thread_ts);
                say("I'm sorry, something went wrong. Please try again in a little while.");
                return;
            }

            // Get the last 10 messages in the thread and prepare it for the LLM with the system message
            const conversationReplies = await client.conversations.replies({
                channel: messageInThread.channel,
                ts: messageInThread.thread_ts!,
                limit: 10,
            });
            const chatCompletionMessages = Bot._toChatCompletionMessages(conversationReplies);
            chatCompletionMessages.unshift(Bot._getSystemMessage()); // add the system message at the beginning of the conversation

            const llmResponse = await llmClient.getResponse(chatCompletionMessages, mcpSession.tools);

            // Handle tool calls in llm response
            if (llmResponse?.tool_calls && llmResponse.tool_calls.length > 0) {
                const toolRequests = llmResponse.tool_calls.map((toolCall) => {
                    return {
                        ...Bot._extractToolCallParams(toolCall),
                        toolCallResult: null,
                        success: false,
                    };
                });
                let toolRequestMessage = "I want to use: \n";
                toolRequestMessage += toolRequests
                    .map(
                        (toolRequest) =>
                            toolRequest.toolName + " with arguments " + JSON.stringify(toolRequest.toolArgs),
                    )
                    .join("\nand\n");
                toolRequestMessage += ".";
                await slackClient.postBlocks(
                    messageBuilder.toolRequest(toolRequests),
                    mcpSession.threadTs,
                    mcpSession.channelId,
                );
            } else {
                await slackClient.postMarkdown(
                    llmResponse?.content || "...",
                    mcpSession.threadTs,
                    mcpSession.channelId,
                );
            }
        } catch (e) {
            logger.error(e);
            await say("I'm sorry, something went wrong. Please try again in a little while.");
        }
    };

    private static _isMessageInThread(message: bolt.KnownEventFromType<"message">): {
        isInThread: boolean;
        message: bolt.types.GenericMessageEvent;
    } {
        if (message.subtype !== undefined) {
            return { isInThread: false, message: message as unknown as bolt.types.GenericMessageEvent };
        }

        if (message.thread_ts === undefined) {
            return { isInThread: false, message: message as bolt.types.GenericMessageEvent };
        }
        return { isInThread: true, message: message };
    }

    private async _processToolCallRequest(toolCallRequest: ToolCallRequest, mcpSession: McpSession): Promise<void> {
        try {
            await mcpSession.processToolCallRequest(toolCallRequest);
            toolCallRequest.success = true;
        } catch (e) {
            logger.error("Error executing tool call: " + toolCallRequest.toolName + " - " + e);
            toolCallRequest.success = false;
        }
    }

    private static _extractToolCallParams(toolCall: ChatCompletionMessageToolCall): {
        toolName: string;
        toolArgs: Record<string, any>;
    } {
        return {
            toolName: toolCall.function.name,
            toolArgs: JSON.parse(toolCall.function.arguments),
        };
    }

    private static _toChatCompletionMessages(
        conversationReplies: ConversationsRepliesResponse,
    ): ChatCompletionMessageParam[] {
        if (!conversationReplies.messages) {
            return [];
        }
        return conversationReplies.messages
            .filter((message) => (message as any).subtype === undefined)
            .map((message) => {
                return {
                    role: message.bot_id ? "assistant" : "user",
                    content: message.text || "",
                } as ChatCompletionMessageParam;
            });
    }

    private static _getSystemMessage() {
        const currentDateTime = new Date().toLocaleString();
        const systemMessage: ChatCompletionSystemMessageParam = {
            role: "system",
            content: `
#### CONTEXT
Nous sommes le ${currentDateTime}.
You are a friendly slack assistant that can help answer questions and help with tasks. 
      `,
        };
        return systemMessage;
    }

    private static _extractToolCallRequest(actionBody: bolt.BlockAction<bolt.ButtonAction>): ToolCallRequest[] {
        const messageBlocks = actionBody.message?.blocks;
        if (!messageBlocks || !messageBlocks.length || messageBlocks.length !== 3) {
            throw new Error("Tool params not found");
        }
        const toolRequestList = (messageBlocks[1] as RichTextBlock).elements[0]!
            .elements as unknown as RichTextSection[];
        const toolRequests = toolRequestList.map((element) => {
            // Concatenate all text elements, mainly because slacks breaks down emojis in different elements
            const fullText = element.elements
                .map((e) => {
                    if (e.type === "text") {
                        return e.text;
                    } else if (e.type === "emoji") {
                        return e.unicode ? Bot._unicodeToEmoji(e.unicode) : "";
                    }
                    return "";
                })
                .join("");

            const toolName = fullText.split(" with arguments:\n")[0];
            const toolArgs = JSON.parse(fullText.split(" with arguments:\n")[1] || "{}") as Record<string, unknown>;
            if (!toolName || !toolArgs) {
                throw new Error("Tool name or args not found");
            }
            return {
                toolName: toolName,
                toolArgs: toolArgs,
                toolCallResult: null,
                success: false,
            };
        });
        return toolRequests;
    }

    private static _unicodeToEmoji(unicode: string): string {
        const codePoint = parseInt(unicode, 16);
        return String.fromCodePoint(codePoint);
    }
}
export default Bot;
