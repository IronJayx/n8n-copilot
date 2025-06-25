import { useRootStore } from '@n8n/stores/useRootStore';

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface StreamingCallbacks {
	onText: (text: string) => void;
	onError: (error: Error) => void;
	onComplete?: () => void;
}

class AiChatService {
	async streamChatResponse(
		userMessage: string,
		callbacks: StreamingCallbacks,
		conversationHistory: ChatMessage[] = [],
	): Promise<void> {
		try {
			const rootStore = useRootStore();
			const baseUrl = rootStore.baseUrl;

			// Create request to backend copilot endpoint
			const response = await fetch(`${baseUrl}rest/copilot/chat`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				credentials: 'include', // Include cookies for authentication
				body: JSON.stringify({
					userMessage,
					conversationHistory,
				}),
			});

			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			if (!response.body) {
				throw new Error('No response body');
			}

			// Set up SSE reading
			const reader = response.body.getReader();
			const decoder = new TextDecoder();

			try {
				while (true) {
					const { done, value } = await reader.read();

					if (done) break;

					const chunk = decoder.decode(value);
					const lines = chunk.split('\n');

					for (const line of lines) {
						if (line.startsWith('data: ')) {
							try {
								const data = JSON.parse(line.slice(6));

								switch (data.type) {
									case 'text':
										callbacks.onText(data.content);
										break;
									case 'error':
										callbacks.onError(new Error(data.content));
										return;
									case 'complete':
										if (callbacks.onComplete) {
											callbacks.onComplete();
										}
										return;
								}
							} catch (parseError) {
								console.warn('Failed to parse SSE data:', line);
							}
						}
					}
				}
			} finally {
				reader.releaseLock();
			}
		} catch (error) {
			callbacks.onError(error instanceof Error ? error : new Error('Unknown error occurred'));
		}
	}
}

// Export singleton instance
export const aiChatService = new AiChatService();
