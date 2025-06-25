<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useUIStore } from '@/stores/ui.store';
import { useSettingsStore } from '@/stores/settings.store';
import { useSourceControlStore } from '@/stores/sourceControl.store';
import { useCredentialsStore } from '@/stores/credentials.store';
import { useI18n } from '@n8n/i18n';
import { useGlobalEntityCreation } from '@/composables/useGlobalEntityCreation';
import { aiChatService } from '@/api/copilot';

import { useWorkflowHelpers } from '@/composables/useWorkflowHelpers';
// import { useWorkflowsStore } from '@/stores/workflows.store'; // TODO: use this for more precise workflow editing

import { useToast } from '@/composables/useToast';
import { useCanvasOperations } from '@/composables/useCanvasOperations';

import { v4 as uuidv4 } from 'uuid';
import {
	N8nIcon,
	N8nNavigationDropdown,
	N8nTooltip,
	N8nLink,
	N8nIconButton,
	N8nButton,
} from '@n8n/design-system';
import ChatDiscussion from '@/components/ChatDiscussion.vue';
import ChatInput from '@/components/ChatInput.vue';
import Logo from '@/components/Logo/Logo.vue';
import type { IWorkflowToShare, IWorkflowDb } from '@/Interface';
import { useRootStore } from '@n8n/stores/useRootStore';

const props = defineProps<{
	readOnly?: boolean;
	id: IWorkflowDb['id'];
	tags: IWorkflowDb['tags'];
	name: IWorkflowDb['name'];
	meta: IWorkflowDb['meta'];
}>();

// Define message type
interface Message {
	id: string;
	text: string;
	sender: 'user' | 'n8n-copilot';
	timestamp: Date;
	images?: string[];
}

// Reactive data
const uiStore = useUIStore();
const settingsStore = useSettingsStore();
const sourceControlStore = useSourceControlStore();
const credentialsStore = useCredentialsStore();
const i18n = useI18n();
const workflowHelpers = useWorkflowHelpers();
const rootStore = useRootStore();
const toast = useToast();
const { resetWorkspace, initializeWorkspace } = useCanvasOperations();

const isCollapsed = computed(() => uiStore.sidebarMenuCollapsed);
const fullyExpanded = ref(true);

// Workflow generation state
const isGeneratingWorkflow = ref(false);
const isResponding = ref(false);

// Global entity creation
const {
	menu,
	handleSelect: handleMenuSelect,
	createProjectAppendSlotName,
	createWorkflowsAppendSlotName,
	createCredentialsAppendSlotName,
	projectsLimitReachedMessage,
	upgradeLabel,
	hasPermissionToCreateProjects,
} = useGlobalEntityCreation();

const createBtn = ref<InstanceType<typeof N8nNavigationDropdown>>();

const messages = ref<Message[]>([
	{
		id: uuidv4(),
		text: "Hello! I'm your AI assistant. How can I help you with your n8n workflow today?",
		sender: 'n8n-copilot',
		timestamp: new Date(),
	},
]);

// Credential management
const anthropicCredentials = computed(() => {
	return credentialsStore.getCredentialsByType('anthropicApi');
});

const hasAnthropicCredential = computed(() => {
	return anthropicCredentials.value.length > 0;
});

const firstAnthropicCredential = computed(() => {
	return anthropicCredentials.value[0] || null;
});

// Note: Backend will handle credential access and validation

// Listen for credential changes
let unsubscribeCredentials: (() => void) | null = null;

onMounted(async () => {
	// Fetch credentials when component mounts
	try {
		await credentialsStore.fetchAllCredentials();
	} catch (error) {
		console.error('Failed to fetch credentials:', error);
	}

	// Listen for credential changes
	unsubscribeCredentials = credentialsStore.$subscribe(() => {
		// This will trigger reactivity when credentials change
	});
});

onUnmounted(() => {
	if (unsubscribeCredentials) {
		unsubscribeCredentials();
	}
});

const getCurrentWorkflowData = async () => {
	const workflowData = await workflowHelpers.getWorkflowDataToSave();
	const { tags, ...data } = workflowData;
	const exportData: IWorkflowToShare = {
		...data,
		meta: {
			...props.meta,
			instanceId: rootStore.instanceId,
		},
	};
	return exportData;
};

// Function to extract and parse JSON workflow from AI response
function extractWorkflowJson(responseText: string): IWorkflowToShare | null {
	// Look for ```json ... ``` blocks in the response
	const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n```/g;
	const matches = [...responseText.matchAll(jsonBlockRegex)];

	if (matches.length === 0) {
		return null;
	}

	// Take the last JSON block if multiple exist
	const lastMatch = matches[matches.length - 1];
	const jsonString = lastMatch[1];

	try {
		const parsed: IWorkflowToShare = JSON.parse(jsonString);

		// Basic validation that it's a workflow
		if (parsed && typeof parsed === 'object' && parsed.nodes && Array.isArray(parsed.nodes)) {
			return parsed;
		}

		return null;
	} catch (error) {
		console.error('Failed to parse JSON from AI response:', error);
		return null;
	}
}

// Function to replace current workflow with AI-generated workflow
function importWorkflowFromAI(workflowData: IWorkflowDb) {
	try {
		// Clear the current workspace
		resetWorkspace();

		// Initialize with the new workflow data
		initializeWorkspace(workflowData);

		// Update document title if workflow has a name
		if (workflowData.name) {
			workflowHelpers.setDocumentTitle(workflowData.name, 'IDLE');
		}

		// Show success notification
		toast.showMessage({
			title: 'Workflow Replaced',
			message: 'The current workflow has been replaced with the AI-generated workflow',
			type: 'success',
		});

		console.log('Workflow replaced successfully from AI response');
	} catch (error) {
		console.error('Failed to replace workflow:', error);

		// Show error notification
		toast.showError(error, 'Failed to replace workflow from AI response');
	}
}

// Handler for new messages with Claude integration
async function handleSendMessage(message: Message) {
	// Add user message
	messages.value.push(message);

	const workflowData = await getCurrentWorkflowData();

	// Convert workflow to JSON string
	const workflowJson = JSON.stringify(workflowData, null, 2);

	// Prepare the message with workflow context
	const messageWithContext = `Current n8n workflow:
\`\`\`json
${workflowJson}
\`\`\`

User question: ${message.text}`;

	// Create a placeholder message for streaming response
	const aiResponseId = uuidv4();
	const aiResponse: Message = {
		id: aiResponseId,
		text: '',
		sender: 'n8n-copilot',
		timestamp: new Date(),
	};
	messages.value.push(aiResponse);

	// Track the full response for parsing
	let fullResponse = '';

	// Set responding state
	isResponding.value = true;

	try {
		// Convert frontend messages to API format for conversation history
		const conversationHistory = messages.value
			.filter((msg) => msg.sender !== 'n8n-copilot' || msg.text.trim() !== '') // Exclude empty AI responses
			.slice(0, -1) // Exclude the current message and the placeholder AI response we just added
			.map((msg) => ({
				role: msg.sender === 'user' ? ('user' as const) : ('assistant' as const),
				content: msg.text,
			}));

		// Use the AI chat service for streaming response (backend will handle credential access)
		await aiChatService.streamChatResponse(
			messageWithContext,
			{
				onText: (text: string) => {
					// Accumulate the full response
					fullResponse += text;

					// Check for JSON block detection
					if (fullResponse.includes('```json') && !isGeneratingWorkflow.value) {
						isGeneratingWorkflow.value = true;
						toast.showMessage({
							title: 'Editing Workflow',
							message: 'editing your workflow...',
							type: 'info',
							duration: 10000,
						});
					}

					// Find the AI response message and update its text
					const responseIndex = messages.value.findIndex((msg) => msg.id === aiResponseId);
					if (responseIndex !== -1) {
						messages.value[responseIndex].text += text;
					}
				},
				onError: (error: Error) => {
					console.error('Claude API error:', error);
					// Reset state on error
					isResponding.value = false;
					if (isGeneratingWorkflow.value) {
						isGeneratingWorkflow.value = false;
					}
					const responseIndex = messages.value.findIndex((msg) => msg.id === aiResponseId);
					if (responseIndex !== -1) {
						messages.value[responseIndex].text =
							'Sorry, I encountered an error while processing your request. Please try again.';
					}
				},
				onComplete: () => {
					console.log('Claude response completed');

					// Reset responding state first
					isResponding.value = false;

					// Try to extract and import workflow JSON from the response
					const workflowJson = extractWorkflowJson(fullResponse);

					if (workflowJson) {
						console.log('Found workflow JSON in AI response, importing...');
						importWorkflowFromAI(workflowJson as IWorkflowDb);
					}

					// Reset state on completion
					if (isGeneratingWorkflow.value) {
						isGeneratingWorkflow.value = false;
						toast.showMessage({
							title: 'Workflow Generated',
							message: 'AI has finished generating your workflow',
							type: 'success',
							duration: 2000,
						});
					}
				},
			},
			conversationHistory,
		);
	} catch (error) {
		console.error('Error calling Claude API:', error);
		// Reset responding state on catch error
		isResponding.value = false;
		const responseIndex = messages.value.findIndex((msg) => msg.id === aiResponseId);
		if (responseIndex !== -1) {
			messages.value[responseIndex].text =
				'Sorry, I encountered an error while processing your request. Please check your API configuration and try again.';
		}
	}
}

// Credential management functions
function openAnthropicCredentialModal() {
	if (hasAnthropicCredential.value) {
		// Edit existing credential
		const credential = firstAnthropicCredential.value;
		if (credential) {
			uiStore.openExistingCredential(credential.id);
		}
	} else {
		// Create new credential
		uiStore.openNewCredential('anthropicApi');
	}
}

// Toggle collapse functionality
const toggleCollapse = () => {
	uiStore.toggleSidebarMenuCollapse();
	// When expanding, delay showing some element to ensure smooth animation
	if (!isCollapsed.value) {
		setTimeout(() => {
			fullyExpanded.value = !isCollapsed.value;
		}, 300);
	} else {
		fullyExpanded.value = !isCollapsed.value;
	}
};
</script>

<template>
	<div
		:class="{
			['side-menu']: true,
			[$style.sideMenu]: true,
			[$style.sideMenuCollapsed]: isCollapsed,
		}"
	>
		<div
			id="collapse-change-button"
			:class="['clickable', $style.sideMenuCollapseButton]"
			@click="toggleCollapse"
		>
			<N8nIcon v-if="isCollapsed" icon="chevron-right" size="xsmall" class="ml-5xs" />
			<N8nIcon v-else icon="chevron-left" size="xsmall" class="mr-5xs" />
		</div>

		<!-- Logo Section -->
		<div :class="$style.logo">
			<Logo
				location="sidebar"
				:collapsed="isCollapsed"
				:release-channel="settingsStore.settings.releaseChannel"
			>
				<span v-if="!isCollapsed" :class="$style.aiTag">copilot</span>
				<N8nTooltip
					v-if="sourceControlStore.preferences.branchReadOnly && !isCollapsed"
					placement="bottom"
				>
					<template #content>
						<i18n-t keypath="readOnlyEnv.tooltip">
							<template #link>
								<N8nLink
									to="https://docs.n8n.io/source-control-environments/setup/#step-4-connect-n8n-and-configure-your-instance"
									size="small"
								>
									{{ i18n.baseText('readOnlyEnv.tooltip.link') }}
								</N8nLink>
							</template>
						</i18n-t>
					</template>
					<N8nIcon
						data-test-id="read-only-env-icon"
						icon="lock"
						size="xsmall"
						:class="$style.readOnlyEnvironmentIcon"
					/>
				</N8nTooltip>
			</Logo>

			<div :class="$style.headerActions">
				<!-- Settings Icon -->
				<N8nTooltip placement="bottom">
					<template #content>
						{{
							hasAnthropicCredential
								? 'Manage Anthropic credentials'
								: 'Configure Anthropic credentials'
						}}
					</template>
					<N8nIconButton
						icon="cog"
						type="tertiary"
						size="small"
						:class="$style.settingsButton"
						@click="openAnthropicCredentialModal"
					/>
				</N8nTooltip>

				<!-- Add Button -->
				<N8nNavigationDropdown
					ref="createBtn"
					data-test-id="universal-add"
					:menu="menu"
					@select="handleMenuSelect"
				>
					<N8nIconButton icon="plus" type="secondary" outline />
					<template #[createWorkflowsAppendSlotName]>
						<N8nTooltip
							v-if="sourceControlStore.preferences.branchReadOnly"
							placement="right"
							:content="i18n.baseText('readOnlyEnv.cantAdd.workflow')"
						>
							<N8nIcon style="margin-left: auto; margin-right: 5px" icon="lock" size="xsmall" />
						</N8nTooltip>
					</template>
					<template #[createCredentialsAppendSlotName]>
						<N8nTooltip
							v-if="sourceControlStore.preferences.branchReadOnly"
							placement="right"
							:content="i18n.baseText('readOnlyEnv.cantAdd.credential')"
						>
							<N8nIcon style="margin-left: auto; margin-right: 5px" icon="lock" size="xsmall" />
						</N8nTooltip>
					</template>
					<template #[createProjectAppendSlotName]="{ item }">
						<N8nTooltip
							v-if="sourceControlStore.preferences.branchReadOnly"
							placement="right"
							:content="i18n.baseText('readOnlyEnv.cantAdd.project')"
						>
							<N8nIcon style="margin-left: auto; margin-right: 5px" icon="lock" size="xsmall" />
						</N8nTooltip>
						<N8nTooltip
							v-else-if="item.disabled"
							placement="right"
							:content="projectsLimitReachedMessage"
						>
							<N8nIcon
								v-if="!hasPermissionToCreateProjects"
								style="margin-left: auto; margin-right: 5px"
								icon="lock"
								size="xsmall"
							/>
							<N8nButton
								v-else
								:size="'mini'"
								style="margin-left: auto"
								type="tertiary"
								@click="handleMenuSelect(item.id)"
							>
								{{ upgradeLabel }}
							</N8nButton>
						</N8nTooltip>
					</template>
				</N8nNavigationDropdown>
			</div>
		</div>

		<!-- Messages Area -->
		<div v-if="fullyExpanded" :class="$style.messagesContainer">
			<ChatDiscussion :messages="messages" :responding="isResponding" />
		</div>

		<!-- Input Area -->
		<div v-if="fullyExpanded" :class="$style.inputContainer">
			<div v-if="!hasAnthropicCredential" :class="$style.noApiKeyMessage">
				<p>Configure Anthropic credentials to use the chat</p>
				<N8nButton type="primary" size="small" @click="openAnthropicCredentialModal">
					Configure Anthropic Credentials
				</N8nButton>
			</div>
			<ChatInput v-else @send-message="handleSendMessage" />
		</div>
	</div>
</template>

<style module lang="scss">
.sideMenu {
	display: flex;
	flex-direction: column;
	height: 100vh;
	width: $sidebar-expanded-width * 2.5;
	border-right: 1px solid #d1d5db;
	background-color: #fcfbf7;
	position: relative;
	transition: width 150ms ease-in-out;

	.logo {
		display: flex;
		align-items: center;
		padding: var(--spacing-xs);
		justify-content: space-between;

		img {
			position: relative;
			left: 1px;
			height: 20px;
		}
	}

	.headerActions {
		display: flex;
		align-items: center;
		gap: var(--spacing-2xs);
	}

	.settingsButton {
		opacity: 0.7;

		&:hover {
			opacity: 1;
		}
	}

	&.sideMenuCollapsed {
		width: $sidebar-width;
		min-width: auto;

		.logo {
			flex-direction: column;
			gap: 12px;
		}
	}
}

.header {
	display: flex;
	align-items: center;
	margin: 0.5rem;
	padding: 0.5rem;
}

.headerIcon {
	margin-right: 0.25rem;
	color: black;
	font-size: 1.5rem;
}

.headerText {
	font-size: 1rem;
	font-weight: bold;
	color: black;
}

.messagesContainer {
	flex: 1;
	overflow: hidden;
	padding: 1rem;
}

.inputContainer {
	padding: 1rem;
	border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.noApiKeyMessage {
	padding: var(--spacing-m);
	background: var(--color-background-light);
	border: 1px solid var(--color-foreground-base);
	border-radius: var(--border-radius-base);
	text-align: center;

	p {
		margin: 0 0 var(--spacing-s) 0;
		color: var(--color-text-base);
		font-size: var(--font-size-s);
	}
}

.sideMenuCollapseButton {
	position: absolute;
	right: -10px;
	top: 50%;
	z-index: 999;
	display: flex;
	justify-content: center;
	align-items: center;
	color: var(--color-text-base);
	background-color: var(--color-foreground-xlight);
	width: 20px;
	height: 20px;
	border: var(--border-width-base) var(--border-style-base) var(--color-foreground-base);
	border-radius: 50%;

	&:hover {
		color: var(--color-primary-shade-1);
	}
}

.readOnlyEnvironmentIcon {
	display: inline-block;
	color: white;
	background-color: var(--color-warning);
	align-self: center;
	padding: 2px;
	border-radius: var(--border-radius-small);
	margin: 7px 12px 0 5px;
}

.aiTag {
	display: inline-block;
	background: linear-gradient(135deg, #ff6b35, #f7931e);
	color: white;
	padding: 4px 6px;
	border-radius: 6px;
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.5px;
	margin-left: 4px;
	align-self: center;
	box-shadow: 0 2px 4px rgba(255, 107, 53, 0.3);
}
</style>
