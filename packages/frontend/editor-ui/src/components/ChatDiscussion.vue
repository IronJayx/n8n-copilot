<script setup lang="ts">
import { onMounted, onUpdated, ref, reactive } from 'vue';
import { N8nIconButton, N8nTooltip } from '@n8n/design-system';
import { useToast } from '@/composables/useToast';

interface Message {
	id: string;
	text: string;
	sender: 'user' | 'n8n-copilot';
	timestamp: Date;
	images?: string[];
}

interface ParsedMessagePart {
	type: 'text' | 'json';
	content: string;
}

const props = defineProps<{
	messages: Message[];
	responding?: boolean;
}>();

const discussionContainer = ref<HTMLElement>();
const toast = useToast();

// Track expanded state for each JSON block
const expandedJsonBlocks = reactive<Record<string, boolean>>({});

// Copy JSON content to clipboard
const copyJsonToClipboard = async (jsonContent: string) => {
	try {
		await navigator.clipboard.writeText(jsonContent);
		toast.showMessage({
			title: 'Copied to clipboard',
			message: 'JSON content has been copied to clipboard',
			type: 'success',
		});
	} catch (error) {
		console.error('Failed to copy to clipboard:', error);
		toast.showError(error, 'Failed to copy to clipboard');
	}
};

// Auto-scroll to bottom when new messages are added
const scrollToBottom = () => {
	if (discussionContainer.value) {
		discussionContainer.value.scrollTop = discussionContainer.value.scrollHeight;
	}
};

const formatTime = (timestamp: Date) => {
	return timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// Parse message text to separate regular text from JSON blocks
const parseMessageContent = (text: string): ParsedMessagePart[] => {
	const parts: ParsedMessagePart[] = [];

	// First, find completed JSON blocks
	const completedJsonRegex = /```json\s*\n([\s\S]*?)\n```/g;
	let lastIndex = 0;
	let match;
	const completedBlocks: Array<{ start: number; end: number; content: string }> = [];

	while ((match = completedJsonRegex.exec(text)) !== null) {
		completedBlocks.push({
			start: match.index,
			end: match.index + match[0].length,
			content: match[1],
		});
	}

	// Now check for incomplete JSON blocks (```json without closing backticks)
	const incompleteJsonRegex = /```json\s*\n/g;
	let incompleteMatch;
	const incompleteBlocks: Array<{ start: number; startPos: number }> = [];

	while ((incompleteMatch = incompleteJsonRegex.exec(text)) !== null) {
		const startPos = incompleteMatch.index;
		const contentStart = incompleteMatch.index + incompleteMatch[0].length;

		// Check if this is already part of a completed block
		const isCompleted = completedBlocks.some(
			(block) => startPos >= block.start && startPos < block.end,
		);

		if (!isCompleted) {
			incompleteBlocks.push({
				start: startPos,
				startPos: contentStart,
			});
		}
	}

	// Process all blocks in order
	const allBlocks = [
		...completedBlocks.map((b) => ({ ...b, type: 'completed' as const })),
		...incompleteBlocks.map((b) => ({ ...b, type: 'incomplete' as const, end: text.length })),
	].sort((a, b) => a.start - b.start);

	lastIndex = 0;

	for (const block of allBlocks) {
		// Add text before this block
		if (block.start > lastIndex) {
			const textBefore = text.slice(lastIndex, block.start).trim();
			if (textBefore) {
				parts.push({ type: 'text', content: textBefore });
			}
		}

		// Add the JSON block
		let jsonContent: string;
		if (block.type === 'completed') {
			jsonContent = 'content' in block ? block.content : '';
		} else {
			// For incomplete blocks, get content from start position to end of text
			jsonContent = 'startPos' in block ? text.slice(block.startPos) : '';
		}

		try {
			// Try to parse and reformat the JSON for better display
			const parsed = JSON.parse(jsonContent);
			const formatted = JSON.stringify(parsed, null, 2);
			parts.push({ type: 'json', content: formatted });
		} catch (error) {
			// If parsing fails, just use the original content
			parts.push({ type: 'json', content: jsonContent });
		}

		lastIndex = block.end;
	}

	// Add remaining text after the last block
	if (lastIndex < text.length) {
		const remainingText = text.slice(lastIndex).trim();
		if (remainingText) {
			parts.push({ type: 'text', content: remainingText });
		}
	}

	// If no blocks were found, return the original text
	if (parts.length === 0) {
		parts.push({ type: 'text', content: text });
	}

	return parts;
};

// Toggle JSON block expansion
const toggleJsonExpansion = (messageId: string, partIndex: number) => {
	const key = `${messageId}-${partIndex}`;
	expandedJsonBlocks[key] = !expandedJsonBlocks[key];
};

// Check if JSON block is expanded
const isJsonExpanded = (messageId: string, partIndex: number) => {
	// Keep JSON blocks expanded while AI is responding
	if (props.responding) {
		return true;
	}

	const key = `${messageId}-${partIndex}`;
	return expandedJsonBlocks[key] || false;
};

onMounted(() => {
	scrollToBottom();
});

onUpdated(() => {
	scrollToBottom();
});
</script>

<template>
	<div ref="discussionContainer" :class="$style.discussionContainer">
		<div
			v-for="message in messages"
			:key="message.id"
			:class="[
				$style.messageWrapper,
				message.sender === 'user' ? $style.userMessage : $style.n8nChatMessage,
			]"
		>
			<div :class="$style.messageContent">
				<div :class="$style.messageHeader">
					<span :class="$style.senderName">
						{{ message.sender === 'user' ? 'You' : 'n8n-copilot' }}
					</span>
				</div>

				<!-- Display images if any -->
				<div v-if="message.images && message.images.length > 0" :class="$style.imageContainer">
					<img
						v-for="(image, index) in message.images"
						:key="index"
						:src="image"
						:class="$style.messageImage"
						alt="Uploaded image"
					/>
				</div>

				<!-- Message text with JSON block formatting -->
				<div :class="$style.messageText">
					<template v-for="(part, index) in parseMessageContent(message.text)" :key="index">
						<div v-if="part.type === 'text'" :class="$style.textContent">
							{{ part.content }}
						</div>
						<div v-else-if="part.type === 'json'" :class="$style.jsonBlock">
							<div :class="$style.jsonHeader">
								<span>json</span>
								<N8nTooltip placement="top">
									<template #content>Copy JSON to clipboard</template>
									<N8nIconButton
										icon="copy"
										type="tertiary"
										size="mini"
										:class="$style.copyButton"
										@click="copyJsonToClipboard(part.content)"
									/>
								</N8nTooltip>
							</div>
							<div :class="$style.jsonContentWrapper">
								<pre
									:class="[
										$style.jsonContent,
										{ [$style.collapsed]: !isJsonExpanded(message.id, index) },
									]"
									>{{ part.content }}</pre
								>
								<div :class="$style.expandButtonWrapper">
									<N8nTooltip placement="top">
										<template #content>
											{{ isJsonExpanded(message.id, index) ? 'Collapse' : 'Expand' }}
										</template>
										<N8nIconButton
											:icon="isJsonExpanded(message.id, index) ? 'chevron-up' : 'chevron-down'"
											type="tertiary"
											size="mini"
											:class="$style.expandButton"
											@click="toggleJsonExpansion(message.id, index)"
										/>
									</N8nTooltip>
								</div>
							</div>
						</div>
					</template>
				</div>

				<!-- Timestamp at the bottom -->
				<div :class="$style.messageFooter">
					<span :class="$style.timestamp">
						{{ formatTime(message.timestamp) }}
					</span>
				</div>
			</div>
		</div>
	</div>
</template>

<style module lang="scss">
.discussionContainer {
	height: 100%;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
	gap: 1rem;
}

.messageWrapper {
	display: flex;
	width: 100%;

	&.userMessage {
		justify-content: flex-end;

		.messageContent {
			padding: 0.75rem 1rem;
			background-color: #f7f4ec;
			border: 1px solid rgba(0, 0, 0, 0.1);
			border-radius: 1rem 1rem 0.25rem 1rem;
			width: 100%;
			overflow: hidden;
		}
	}

	&.n8nChatMessage {
		justify-content: flex-start;

		.messageContent {
			color: black;
			width: 100%;
			overflow: hidden;
		}
	}
}

.messageContent {
	word-wrap: break-word;
}

.messageHeader {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 0.5rem;
	font-size: 0.75rem;
	opacity: 0.8;
}

.senderName {
	font-weight: bold;
}

.messageFooter {
	display: flex;
	justify-content: flex-end;
	margin-top: 0.5rem;
	padding-top: 0.25rem;
}

.timestamp {
	font-size: 0.7rem;
	opacity: 0.6;
	color: #666;

	.userMessage & {
		color: rgba(0, 0, 0, 0.6);
	}
}

.imageContainer {
	margin: 0.5rem 0;
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}

.messageImage {
	max-width: 200px;
	max-height: 200px;
	border-radius: 0.5rem;
	object-fit: cover;
}

.messageText {
	line-height: 1.4;
	font-size: 0.9rem;
}

.textContent {
	white-space: pre-wrap;
	margin-bottom: 0.5rem;

	&:last-child {
		margin-bottom: 0;
	}
}

.jsonBlock {
	background-color: #f7f4ec;
	border: 1px solid rgba(0, 0, 0, 0.1);
	border-radius: 0.5rem;
	margin: 0.5rem 0;
	overflow: hidden;

	.userMessage & {
		background-color: rgba(255, 255, 255, 0.1);
		border-color: rgba(255, 255, 255, 0.2);
	}
}

.jsonContentWrapper {
	position: relative;
}

.jsonHeader {
	background-color: #e8e2d4;
	border-bottom: 1px solid rgba(0, 0, 0, 0.1);
	padding: 0.25rem 0.5rem;
	font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
	font-size: 0.7rem;
	font-weight: 600;
	color: #666;
	letter-spacing: 0.5px;
	display: flex;
	justify-content: space-between;
	align-items: center;

	.userMessage & {
		background-color: rgba(255, 255, 255, 0.2);
		border-bottom-color: rgba(255, 255, 255, 0.3);
		color: rgba(255, 255, 255, 0.8);
	}
}

.copyButton {
	opacity: 0.7;
	background: none;
	border: none;
	transition: opacity 0.2s ease;

	&:hover {
		opacity: 1;
		background: none;
	}

	.userMessage & {
		opacity: 0.8;

		&:hover {
			opacity: 1;
			background: none;
		}
	}
}

.jsonContent {
	padding: 0.75rem;
	margin: 0;
	font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
	font-size: 0.8rem;
	line-height: 1.4;
	color: #24292e;
	white-space: pre;
	overflow-x: auto;
	transition: max-height 0.3s ease-in-out;

	&.collapsed {
		max-height: calc(1.4em * 7); // 7 lines
		overflow: hidden;
		position: relative;

		&::after {
			content: '';
			position: absolute;
			bottom: 0;
			left: 0;
			right: 0;
			height: 3em;
			background: linear-gradient(transparent, #f7f4ec);
			pointer-events: none;

			.userMessage & {
				background: linear-gradient(transparent, rgba(255, 255, 255, 0.1));
			}
		}
	}

	.userMessage & {
		color: rgba(255, 255, 255, 0.9);
	}
}

.expandButtonWrapper {
	position: absolute;
	bottom: 8px;
	right: 8px;
	z-index: 10;
}

.expandButton {
	background: rgba(255, 255, 255, 0.9);
	border: 1px solid rgba(0, 0, 0, 0.1);
	border-radius: 50%;
	box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
	opacity: 0.8;
	transition: all 0.2s ease;

	&:hover {
		opacity: 1;
		background: rgba(255, 255, 255, 1);
		box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
		transform: scale(1.05);
	}

	.userMessage & {
		background: rgba(0, 0, 0, 0.7);
		border-color: rgba(255, 255, 255, 0.2);
		color: white;

		&:hover {
			background: rgba(0, 0, 0, 0.9);
			border-color: rgba(255, 255, 255, 0.3);
		}
	}
}

/* Scrollbar styling */
.discussionContainer::-webkit-scrollbar {
	width: 6px;
}

.discussionContainer::-webkit-scrollbar-track {
	background: transparent;
}

.discussionContainer::-webkit-scrollbar-thumb {
	background: rgba(0, 0, 0, 0.2);
	border-radius: 3px;
}

.discussionContainer::-webkit-scrollbar-thumb:hover {
	background: rgba(0, 0, 0, 0.3);
}

.jsonBlock::-webkit-scrollbar {
	height: 8px;
}

.jsonBlock::-webkit-scrollbar-track {
	background: transparent;
}

.jsonBlock::-webkit-scrollbar-thumb {
	background: rgba(0, 0, 0, 0.2);
	border-radius: 4px;
}

.jsonBlock::-webkit-scrollbar-thumb:hover {
	background: rgba(0, 0, 0, 0.3);
}
</style>
