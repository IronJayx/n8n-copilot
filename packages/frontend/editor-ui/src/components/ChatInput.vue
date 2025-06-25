<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { v4 as uuidv4 } from 'uuid';
import { N8nIcon } from '@n8n/design-system';

interface Message {
	id: string;
	text: string;
	sender: 'user' | 'n8n-copilot';
	timestamp: Date;
	images?: string[];
}

interface UploadedImage {
	id: string;
	dataUrl: string;
	name: string;
}

const emit = defineEmits<{
	'send-message': [message: Message];
}>();

// Reactive data
const inputValue = ref('');
const uploadedImages = ref<UploadedImage[]>([]);
const fileInputRef = ref<HTMLInputElement>();
const textareaRef = ref();

const placeholder = 'Ask n8n-copilot...';

// Computed
const canSend = computed(() => {
	return inputValue.value.trim() || uploadedImages.value.length > 0;
});

// Methods
const sendMessage = () => {
	if (!canSend.value) return;

	const messageImages = uploadedImages.value.map((img) => img.dataUrl);

	const message: Message = {
		id: uuidv4(),
		text: inputValue.value.trim(),
		sender: 'user',
		timestamp: new Date(),
		images: messageImages.length > 0 ? messageImages : undefined,
	};

	emit('send-message', message);

	// Clear input
	inputValue.value = '';
	uploadedImages.value = [];
};

const handleFileUpload = () => {
	fileInputRef.value?.click();
};

const processFiles = (event: Event) => {
	const target = event.target as HTMLInputElement;
	const files = target.files;

	if (!files) return;

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		if (file.type.startsWith('image/')) {
			readImageFile(file);
		}
	}

	// Reset input so the same file can be uploaded again if needed
	target.value = '';
};

const readImageFile = (file: File) => {
	const reader = new FileReader();
	reader.onload = (e) => {
		if (e.target && e.target.result) {
			uploadedImages.value.push({
				id: uuidv4(),
				dataUrl: e.target.result as string,
				name: file.name,
			});
		}
	};
	reader.readAsDataURL(file);
};

const removeImage = (id: string) => {
	uploadedImages.value = uploadedImages.value.filter((img) => img.id !== id);
};

const handleKeydown = (event: KeyboardEvent) => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		sendMessage();
	}
};

const handlePaste = (event: ClipboardEvent) => {
	if (event.clipboardData && event.clipboardData.items) {
		const items = event.clipboardData.items;

		for (let i = 0; i < items.length; i++) {
			if (items[i].type.indexOf('image') !== -1) {
				const blob = items[i].getAsFile();
				if (blob) {
					event.preventDefault();
					const reader = new FileReader();
					reader.onload = (e) => {
						if (e.target && e.target.result) {
							uploadedImages.value.push({
								id: uuidv4(),
								dataUrl: e.target.result as string,
								name: 'Pasted image',
							});
						}
					};
					reader.readAsDataURL(blob);
					break;
				}
			}
		}
	}
};

const handleInput = () => {
	// Auto-resize textarea
	if (textareaRef.value) {
		textareaRef.value.style.height = 'auto';
		textareaRef.value.style.height = `${textareaRef.value.scrollHeight}px`;
	}
};

onMounted(() => {
	console.log('ChatInput mounted');
});
</script>

<template>
	<div :class="$style.chatInputContainer">
		<!-- Image previews -->
		<div v-if="uploadedImages.length > 0" :class="$style.imagePreviews">
			<div v-for="image in uploadedImages" :key="image.id" :class="$style.imagePreview">
				<img :src="image.dataUrl" :alt="image.name" :class="$style.previewImage" />
				<button :class="$style.removeImageBtn" @click="removeImage(image.id)">
					<N8nIcon icon="times" size="xsmall" />
				</button>
			</div>
		</div>

		<!-- Text input area -->
		<div :class="$style.inputArea">
			<textarea
				ref="textareaRef"
				v-model="inputValue"
				:placeholder="placeholder"
				:class="$style.textarea"
				rows="1"
				@keydown="handleKeydown"
				@paste="handlePaste"
				@input="handleInput"
			></textarea>
		</div>

		<!-- Action buttons -->
		<div :class="$style.actions">
			<!-- Upload Button -->
			<button :class="$style.uploadBtn" @click="handleFileUpload" aria-label="Upload image">
				<N8nIcon icon="image" size="small" />
			</button>

			<!-- Hidden file input -->
			<input
				ref="fileInputRef"
				type="file"
				accept="image/*"
				multiple
				:class="$style.hiddenInput"
				@change="processFiles"
			/>

			<!-- Send Button -->
			<button
				:class="[$style.sendBtn, { [$style.disabled]: !canSend }]"
				:disabled="!canSend"
				@click="sendMessage"
				aria-label="Send message"
			>
				<N8nIcon icon="arrow-right" size="small" />
			</button>
		</div>
	</div>
</template>

<style module lang="scss">
.chatInputContainer {
	background-color: #f7f4ec;
	backdrop-filter: blur(8px);
	border: 1px solid rgba(0, 0, 0, 0.1);
	border-radius: 0.5rem;
	overflow: hidden;
	display: flex;
	flex-direction: column;
}

.imagePreviews {
	padding: 0.5rem;
	border-bottom: 1px solid rgba(255, 255, 255, 0.1);
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}

.imagePreview {
	position: relative;
}

.previewImage {
	height: 4rem;
	width: 4rem;
	border-radius: 0.25rem;
	object-fit: cover;
}

.removeImageBtn {
	position: absolute;
	top: -0.5rem;
	right: -0.5rem;
	background-color: #8a8786;
	border-radius: 50%;
	padding: 0.125rem;
	color: black;
	border: none;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;

	&:hover {
		background-color: black;
		color: white;
	}
}

.inputArea {
	flex: 1;
	background-color: #f7f4ec;
}

.textarea {
	width: 100%;
	background: #f7f4ec;
	border: none;
	padding: 0.75rem;
	color: black;
	resize: none;
	min-height: 3.5rem;
	max-height: 150px;
	overflow-y: auto;
	font-family: inherit;
	font-size: 14px;
	line-height: 1.4;

	&::placeholder {
		color: rgba(0, 0, 0, 0.5);
	}

	&:focus {
		outline: none;
		box-shadow: none;
		background: #f7f4ec;
	}

	&::-webkit-scrollbar {
		width: 4px;
	}

	&::-webkit-scrollbar-track {
		background: transparent;
	}

	&::-webkit-scrollbar-thumb {
		background: rgba(0, 0, 0, 0.2);
		border-radius: 2px;
	}

	&::-webkit-scrollbar-thumb:hover {
		background: rgba(0, 0, 0, 0.3);
	}
}

.actions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	padding: 0 0.75rem 0.75rem;
	margin-top: auto;
	gap: 0.5rem;
}

.uploadBtn {
	color: rgba(0, 0, 0, 0.7);
	background: none;
	border: none;
	cursor: pointer;
	padding: 0.25rem;
	border-radius: 0.25rem;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: color 0.2s;

	&:hover {
		color: black;
	}
}

.sendBtn {
	background-color: #8a8786;
	color: white;
	border: none;
	border-radius: 50%;
	padding: 0.5rem;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: background-color 0.2s;

	&:hover:not(.disabled) {
		background-color: #7b7978;
	}

	&.disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
}

.hiddenInput {
	display: none;
}
</style>
