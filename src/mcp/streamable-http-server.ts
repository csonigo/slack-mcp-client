import { Logger } from "@aws-lambda-powertools/logger";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { APIGatewayProxyWithCognitoAuthorizerEvent, APIGatewayProxyResult } from "aws-lambda";

const isRequestMessage = (message: JSONRPCMessage): message is JSONRPCMessage & { id: number } =>
    "method" in message && "id" in message;

const isResponseMessage = (message: JSONRPCMessage): message is JSONRPCMessage & { id: number } => "id" in message;

export class HttpServerTransport implements Transport {
    public sessionId?: string;
    private _logger: Logger;
    private _started = false;
    private _pendingRequests = new Map<
        number,
        {
            resolve: (message: JSONRPCMessage) => void;
            reject: (error: Error) => void;
        }
    >();

    constructor({ logger }: { logger: Logger }) {
        this._logger = logger;
    }

    public onmessage?: (message: JSONRPCMessage) => void;

    /**
     * Starts the transport. This is required by the Transport interface but is a no-op
     * for the Streamable HTTP transport as connections are managed per-request.
     */
    public start = async () => {
        if (this._started) {
            throw new Error("HttpServerTransport already started");
        }
        this._started = true;
        this._logger.debug("HttpServerTransport started");
    };

    public send = async (message: JSONRPCMessage) => {
        if (isResponseMessage(message)) {
            const pendingRequest = this._pendingRequests.get(message.id);
            if (pendingRequest !== undefined) {
                pendingRequest.resolve(message);
                this._pendingRequests.delete(message.id);
            }
        }
    };

    public close = async () => {
        this._logger.debug("HttpServerTransport closed");
    };

    private startFreshSession = ({ sessionId }: { sessionId: string }) => {
        this.sessionId = sessionId;
        this._pendingRequests.clear();
    };

    public handleHttpEvent = async ({
        body,
        requestContext: {
            authorizer: { claims },
        },
    }: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> => {
        this.startFreshSession({ sessionId: claims.username });
        const messages = Array.isArray(body)
            ? body.map((msg) => JSONRPCMessageSchema.parse(msg))
            : [JSONRPCMessageSchema.parse(body)];

        messages.map((message) => {
            this._logger.info("Incoming message", { payload: message });
            this.onmessage?.(message);
        });
        const requestMessages = messages.filter(isRequestMessage);

        if (requestMessages.length === 0) {
            return { statusCode: 202, body: "" };
        }

        // Create promises for each request and collect their responses
        const responseMessages = await Promise.all(
            requestMessages.map(
                (requestMessage) =>
                    new Promise<JSONRPCMessage>((resolve, reject) => {
                        this._pendingRequests.set(requestMessage.id, { resolve, reject });
                    }),
            ),
        );

        return {
            statusCode: 200,
            body: JSON.stringify(responseMessages.length > 1 ? responseMessages : responseMessages[0]),
        };
    };
}
