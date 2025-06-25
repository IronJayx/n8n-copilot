import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { Post, RestController } from '@n8n/decorators';
import { Response } from 'express';
import { z } from 'zod';

import { CredentialsFinderService } from '@/credentials/credentials-finder.service';
import { CredentialsService } from '@/credentials/credentials.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { AuthenticatedRequest } from '@/requests';

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
}

// Create a proper DTO class that extends zod schema
export const CopilotChatRequestDto = z.object({
	userMessage: z.string().min(1),
	conversationHistory: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: z.string(),
			}),
		)
		.optional()
		.default([]),
});

export type CopilotChatRequest = z.infer<typeof CopilotChatRequestDto>;

@RestController('/copilot')
export class CopilotController {
	constructor(
		private readonly logger: Logger,
		private readonly credentialsService: CredentialsService,
		private readonly credentialsFinderService: CredentialsFinderService,
	) {}

	private async getAnthropicApiKey(user: User): Promise<string> {
		// Find user's Anthropic credentials
		const credentials = await this.credentialsService.getMany(user, {
			listQueryOptions: {},
			includeScopes: false,
			includeData: false,
		});

		// Find the first Anthropic credential
		const anthropicCredential = credentials.find((cred) => cred.type === 'anthropicApi');

		if (!anthropicCredential) {
			throw new NotFoundError(
				'No Anthropic credentials found. Please configure Anthropic credentials first.',
			);
		}

		// Get the credential with decrypted data
		const credentialWithData = await this.credentialsFinderService.findCredentialForUser(
			anthropicCredential.id,
			user,
			['credential:read'],
		);

		if (!credentialWithData) {
			throw new ForbiddenError('You do not have permission to access the Anthropic credentials.');
		}

		// Decrypt the credential data
		const decryptedData = this.credentialsService.decrypt(credentialWithData, true) as {
			apiKey?: string;
		};
		const apiKey = decryptedData.apiKey;

		if (!apiKey || typeof apiKey !== 'string') {
			throw new BadRequestError('Anthropic API key not found in credentials.');
		}

		return apiKey;
	}

	private getAnthropicClient(apiKey: string): Anthropic {
		return new Anthropic({
			apiKey,
		});
	}

	@Post('/chat')
	async chatWithCopilot(req: AuthenticatedRequest, res: Response) {
		try {
			// Validate the payload manually
			const validatedPayload = CopilotChatRequestDto.parse(req.body);
			const { userMessage, conversationHistory } = validatedPayload;

			// Get API key for the authenticated user
			const apiKey = await this.getAnthropicApiKey(req.user);
			const client = this.getAnthropicClient(apiKey);

			// Build messages array with conversation history
			const messages: ChatMessage[] = [
				...conversationHistory,
				{
					role: 'user',
					content: userMessage,
				},
			];

			// Set up SSE headers for streaming
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
				'Access-Control-Allow-Origin': req.headers.origin || 'http://localhost:8080',
				'Access-Control-Allow-Credentials': 'true',
				'Access-Control-Allow-Headers': 'Cache-Control, Content-Type',
			});

			try {
				// Create streaming response from Claude
				const stream = client.messages.stream({
					system:
						"You are an AI copilot specialized in creating and editing n8n workflows. You will receive user messages with their current n8n JSON workflow data.\n\nYour role is to:\n1. Understand the user's intent (create workflow from scratch, edit current workflow, or get specific information/explanation about the current workflow)\n2. Provide helpful responses based on their needs\n\nResponse format:\n- Start with clear explanations of what you understand and what you're doing\n- If creating or modifying a workflow, include the complete new JSON workflow between ```json ``` code blocks\n- Stay concise and to the point in your explanations\n- Focus on n8n best practices and efficient workflow design",
					model: 'claude-3-7-sonnet-latest',
					max_tokens: 2048,
					messages,
				});

				// Process the stream properly
				for await (const chunk of stream) {
					if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
						// Stream text content as it arrives
						const data = JSON.stringify({ type: 'text', content: chunk.delta.text });
						res.write(`data: ${data}\n\n`);

						// Ensure data is flushed immediately
						if (res.flush) {
							res.flush();
						}
					}
				}

				// Send completion signal
				res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
				res.end();
			} catch (streamError) {
				this.logger.error('Anthropic streaming error', {
					error:
						streamError instanceof Error
							? streamError.message
							: `Unknown streaming error: ${JSON.stringify(streamError)}`,
					userId: req.user.id,
				});

				res.write(
					`data: ${JSON.stringify({
						type: 'error',
						content:
							streamError instanceof Error
								? streamError.message
								: `Streaming failed: ${JSON.stringify(streamError)}`,
					})}\n\n`,
				);
				res.end();
			}
		} catch (error) {
			this.logger.error('Copilot chat error', {
				error: error instanceof Error ? error.message : 'Unknown error',
				userId: req.user.id,
			});

			if (error instanceof z.ZodError) {
				throw new BadRequestError('Invalid request payload');
			}

			throw error;
		}
	}
}
