(function() {
	const vscode = acquireVsCodeApi();
	
	let messages = [];
	let sessions = [];
	let currentSessionId = null;
	let sidebarCollapsed = false;
	
	// DOM elements
	const toggleBtn = document.getElementById('toggleSidebar');
	const chatsContainer = document.getElementById('chats');
	const newChatBtn = document.getElementById('newChat');
	const clearHistoryBtn = document.getElementById('clearHistory');
	const messagesContainer = document.getElementById('messages');
	const input = document.getElementById('input');
	const sendBtn = document.getElementById('send');
	const modelButton = document.getElementById('modelButton');
	const modelLabel = document.getElementById('modelLabel');
	const modelMenu = document.getElementById('modelMenu');
	const agentStatus = document.getElementById('agentStatus');
	const confirmOverlay = document.getElementById('confirmOverlay');
	const confirmTitle = document.getElementById('confirmTitle');
	const confirmDetail = document.getElementById('confirmDetail');
	const confirmButtons = document.getElementById('confirmButtons');
	const profileBtn = document.getElementById('profileButton');
	const settingsBtn = document.getElementById('settingsButton');
	const settingsOverlay = document.getElementById('settingsOverlay');
	const groqModelSelect = document.getElementById('groqModelSelect');
	const groqModelInput = document.getElementById('groqModelInput');
	const groqRefreshBtn = document.getElementById('groqRefresh');
	const groqSaveBtn = document.getElementById('groqSave');
	const groqTestBtn = document.getElementById('groqTest');
	const githubTokenInput = document.getElementById('githubTokenInput');
	const groqApiKeyInput = document.getElementById('groqApiKeyInput');
	const githubOwnerInput = document.getElementById('githubOwnerInput');
	const githubTokenStatus = document.getElementById('githubTokenStatus');
	const groqApiKeyStatus = document.getElementById('groqApiKeyStatus');
	const githubOwnerStatus = document.getElementById('githubOwnerStatus');
	const credSaveBtn = document.getElementById('credSave');
	const credClearBtn = document.getElementById('credClear');
	let availableModels = [];
	let currentModel = '';

	// Initialize
	window.addEventListener('DOMContentLoaded', () => {
		setupEventListeners();
		loadSidebarState();
		vscode.postMessage({ type: 'init' });
	});

	function setupEventListeners() {
		// Sidebar toggle
		if (toggleBtn) {
			toggleBtn.addEventListener('click', toggleSidebar);
		}

		// Send button
		sendBtn.addEventListener('click', sendMessage);
		
		// Enter to send (Shift+Enter for new line)
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			}
		});

		// Auto-resize textarea
		input.addEventListener('input', () => {
			input.style.height = 'auto';
			input.style.height = input.scrollHeight + 'px';
		});

		// New chat
		if (newChatBtn) {
			newChatBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'newChat' });
			});
		}
		
		if (clearHistoryBtn) {
			clearHistoryBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'clearHistory' });
			});
		}

		if (settingsBtn) {
			settingsBtn.addEventListener('click', () => {
				openSettings();
			});
		}

		if (profileBtn) {
			profileBtn.addEventListener('click', () => {
				openSettings();
			});
		}

		if (groqRefreshBtn) {
			groqRefreshBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'refreshGroqModels' });
			});
		}

		if (groqSaveBtn) {
			groqSaveBtn.addEventListener('click', () => {
				const selected = groqModelSelect?.value || '';
				const manual = groqModelInput?.value || '';
				const model = manual.trim() || selected.trim();
				vscode.postMessage({ type: 'saveGroqModel', model });
				closeSettings();
			});
		}

		if (groqTestBtn) {
			groqTestBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'testGroq' });
			});
		}

		if (credSaveBtn) {
			credSaveBtn.addEventListener('click', () => {
				const githubToken = githubTokenInput?.value || '';
				const groqApiKey = groqApiKeyInput?.value || '';
				const githubOwnerName = githubOwnerInput?.value || '';
				vscode.postMessage({
					type: 'saveCredentials',
					githubToken: githubToken.trim(),
					groqApiKey: groqApiKey.trim(),
					githubOwnerName: githubOwnerName.trim()
				});
				if (githubTokenInput) githubTokenInput.value = '';
				if (groqApiKeyInput) groqApiKeyInput.value = '';
				if (githubOwnerInput) githubOwnerInput.value = '';
			});
		}

		if (credClearBtn) {
			credClearBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'clearCredentials' });
				if (githubTokenInput) githubTokenInput.value = '';
				if (groqApiKeyInput) groqApiKeyInput.value = '';
				if (githubOwnerInput) githubOwnerInput.value = '';
			});
		}

		// Model selection
		if (modelButton) {
			modelButton.addEventListener('click', (e) => {
				e.preventDefault();
				toggleModelMenu();
			});
		}

		document.addEventListener('click', (e) => {
			if (!modelMenu || !modelButton) return;
			const target = e.target;
			if (target instanceof Node && !modelMenu.contains(target) && !modelButton.contains(target)) {
				modelMenu.classList.remove('open');
			}
		});
	}

	function toggleSidebar() {
		sidebarCollapsed = !sidebarCollapsed;
		document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
		saveSidebarState();
	}

	function loadSidebarState() {
		const state = vscode.getState() || {};
		const defaultCollapsed = document.body.classList.contains('sidebar-collapsed');
		sidebarCollapsed = typeof state.sidebarCollapsed === 'boolean' ? state.sidebarCollapsed : defaultCollapsed;
		document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
	}

	function saveSidebarState() {
		const state = vscode.getState() || {};
		state.sidebarCollapsed = sidebarCollapsed;
		vscode.setState(state);
	}

	function sendMessage() {
		const content = input.value.trim();
		if (!content) return;

		vscode.postMessage({ 
			type: 'sendMessage', 
			content 
		});

		input.value = '';
		input.style.height = 'auto';
	}

	// Handle messages from extension
	window.addEventListener('message', (event) => {
		const message = event.data;
		
		switch (message.type) {
			case 'sessionsLoaded':
				sessions = message.sessions || [];
				currentSessionId = message.currentSessionId || null;
				renderSessions();
				break;
			case 'sessionsUpdated':
				sessions = message.sessions || [];
				currentSessionId = message.currentSessionId || null;
				renderSessions();
				break;
			case 'modelsLoaded':
				handleModelsLoaded(message.models, message.currentModel);
				break;
			case 'historyLoaded':
				messages = message.messages || [];
				renderAllMessages();
				break;
			case 'messageAdded':
				messages.push(message.message);
				renderMessage(message.message);
				scrollToBottom();
				break;
			case 'messageUpdated':
				const index = messages.findIndex(m => m.id === message.message.id);
				if (index !== -1) {
					messages[index] = message.message;
					updateMessageElement(message.message);
				}
				break;
			case 'historyCleared':
				messages = [];
				messagesContainer.innerHTML = '';
				break;
			case 'confirmAction':
				showConfirm(message);
				break;
			case 'openSettings':
				openSettings();
				break;
			case 'groqModelsLoaded':
				updateGroqModels(message.models || []);
				break;
			case 'groqModelSaved':
				if (groqModelInput) groqModelInput.value = message.model || '';
				if (groqModelSelect && message.model) {
					const model = String(message.model);
					if (Array.from(groqModelSelect.options).some((opt) => opt.value === model)) {
						groqModelSelect.value = model;
					}
				}
				break;
			case 'groqTestResult':
				showConfirm({
					id: `groq_test_${Date.now()}`,
					title: message.ok ? 'Groq Test सफल' : 'Groq Test Failed',
					detail: message.message || '',
					choices: ['OK']
				});
				break;
			case 'agentStatus':
				updateAgentStatus(message.status, message.detail);
				break;
			case 'credentialsStatus':
				updateCredentialStatus(message.status || {});
				break;
		}
	});

	function updateAgentStatus(status, detail) {
		if (!agentStatus) return;
		const labelMap = {
			starting: 'Agent: starting',
			ready: 'Agent: ready',
			error: 'Agent: error'
		};
		agentStatus.classList.remove('hidden', 'starting', 'ready', 'error');
		if (!status) {
			agentStatus.classList.add('hidden');
			return;
		}
		agentStatus.classList.add(status);
		agentStatus.textContent = labelMap[status] || 'Agent: status';
		if (status === 'error' && detail) {
			agentStatus.title = `Agent service error: ${detail}`;
		} else {
			agentStatus.title = '';
		}
	}

	function openSettings() {
		if (!settingsOverlay) return;
		settingsOverlay.classList.add('open');
		if (githubTokenInput) githubTokenInput.value = '';
		if (groqApiKeyInput) groqApiKeyInput.value = '';
		if (githubOwnerInput) githubOwnerInput.value = '';
		vscode.postMessage({ type: 'requestCredentialsStatus' });
	}

	function closeSettings() {
		if (!settingsOverlay) return;
		settingsOverlay.classList.remove('open');
	}

	function updateGroqModels(models) {
		if (!groqModelSelect) return;
		groqModelSelect.innerHTML = '';
		const placeholder = document.createElement('option');
		placeholder.value = '';
		placeholder.textContent = 'Select Groq model';
		groqModelSelect.appendChild(placeholder);
		models.forEach((model) => {
			const opt = document.createElement('option');
			opt.value = model;
			opt.textContent = model;
			groqModelSelect.appendChild(opt);
		});
		const saved = (groqModelInput?.value || '').trim();
		if (saved && Array.from(groqModelSelect.options).some((opt) => opt.value === saved)) {
			groqModelSelect.value = saved;
		}
	}

	function updateCredentialStatus(status) {
		const setStatus = (el, isSet) => {
			if (!el) return;
			el.textContent = isSet ? 'Saved' : 'Not set';
		};
		setStatus(githubTokenStatus, !!status.githubToken);
		setStatus(groqApiKeyStatus, !!status.groqApiKey);
		setStatus(githubOwnerStatus, !!status.githubOwnerName);
	}

	function showConfirm(message) {
		if (!confirmOverlay) return;
		confirmTitle.textContent = message.title || 'Confirm';
		confirmDetail.textContent = message.detail || '';
		confirmButtons.innerHTML = '';

		(message.choices || ['OK']).forEach((choice) => {
			const btn = document.createElement('button');
			btn.className = 'confirm-btn';
			btn.textContent = choice;
			btn.addEventListener('click', () => {
				confirmOverlay.classList.remove('open');
				vscode.postMessage({ type: 'confirmResult', id: message.id, choice });
			});
			confirmButtons.appendChild(btn);
		});

		confirmOverlay.classList.add('open');
	}

	function handleModelsLoaded(models, selectedModel) {
		availableModels = Array.isArray(models) ? models : [];
		currentModel = selectedModel || '';
		renderModelMenu();
		updateModelLabel();
	}

	function renderModelMenu() {
		if (!modelMenu) return;
		modelMenu.innerHTML = '';

		if (availableModels.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'model-item';
			empty.textContent = 'No models found';
			modelMenu.appendChild(empty);
			return;
		}

		availableModels.forEach(model => {
			const item = document.createElement('div');
			item.className = 'model-item';
			if (model === currentModel) {
				item.classList.add('active');
			}

			const label = document.createElement('span');
			label.textContent = model;

			item.appendChild(label);

			if (model === currentModel) {
				const check = document.createElement('span');
				check.className = 'model-check';
				check.textContent = 'Selected';
				item.appendChild(check);
			}

			item.addEventListener('click', () => {
				if (model === currentModel) {
					modelMenu.classList.remove('open');
					return;
				}
				currentModel = model;
				updateModelLabel();
				renderModelMenu();
				modelMenu.classList.remove('open');
				vscode.postMessage({
					type: 'changeModel',
					model
				});
			});

			modelMenu.appendChild(item);
		});
	}

	function updateModelLabel() {
		if (!modelLabel) return;
		modelLabel.textContent = currentModel || 'Select model';
	}

	function toggleModelMenu() {
		if (!modelMenu) return;
		modelMenu.classList.toggle('open');
	}

	function renderSessions() {
		if (!chatsContainer) return;
		chatsContainer.innerHTML = '';

		if (!sessions || sessions.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'chats-empty';
			empty.textContent = 'No chats yet';
			chatsContainer.appendChild(empty);
			return;
		}

		sessions.forEach(session => {
			const item = document.createElement('div');
			item.className = 'chat-item';
			if (session.id === currentSessionId) {
				item.classList.add('active');
			}
			item.addEventListener('click', () => {
				if (session.id === currentSessionId) return;
				vscode.postMessage({ type: 'selectSession', sessionId: session.id });
			});

			const title = document.createElement('div');
			title.className = 'chat-title';
			title.textContent = session.title || 'New chat';

			const meta = document.createElement('div');
			meta.className = 'chat-meta';
			meta.textContent = formatChatTime(session.updatedAt);

			item.appendChild(title);
			item.appendChild(meta);
			chatsContainer.appendChild(item);
		});
	}

	function formatChatTime(timestamp) {
		if (!timestamp) return '';
		const date = new Date(timestamp);
		if (Number.isNaN(date.getTime())) return '';
		const now = new Date();
		const isToday = date.toDateString() === now.toDateString();
		
		if (isToday) {
			return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		} else {
			return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		}
	}

	function renderAllMessages() {
		messagesContainer.innerHTML = '';
		messages.forEach(renderMessage);
		scrollToBottom();
	}

	function renderMessage(message) {
		const messageEl = document.createElement('div');
		messageEl.className = `message ${message.role}`;
		messageEl.dataset.id = message.id;

		// Message header
		const header = document.createElement('div');
		header.className = 'message-header';
		
		const roleSpan = document.createElement('span');
		roleSpan.className = 'message-role';
		roleSpan.textContent = message.role === 'user' ? 'You' : 'CodeMate';
		header.appendChild(roleSpan);

		// Show file context
		if (message.fileContext) {
			const fileChip = document.createElement('span');
			fileChip.className = 'file-context';
			fileChip.innerHTML = `
				<svg class="file-icon" viewBox="0 0 16 16" fill="currentColor">
					<path d="M9 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5l-5-5z"/>
					<path d="M9 0v5h5"/>
				</svg>
				${message.fileContext.path}
			`;
			header.appendChild(fileChip);
		}

		messageEl.appendChild(header);

		// Message content
		const contentEl = document.createElement('div');
		contentEl.className = 'message-content';

		if (message.thinking) {
			const thinkingEl = document.createElement('div');
			thinkingEl.className = 'thinking';
			thinkingEl.innerHTML = `
				<span>${message.thinking}</span>
				<div class="thinking-dots">
					<div class="thinking-dot"></div>
					<div class="thinking-dot"></div>
					<div class="thinking-dot"></div>
				</div>
			`;
			contentEl.appendChild(thinkingEl);
		} else {
			contentEl.innerHTML = formatMessageContent(message.content);
			
			// Add code change actions
			if (message.codeChanges && message.codeChanges.length > 0) {
				message.codeChanges.forEach((change, index) => {
					const codeBlockEl = createCodeBlock(change, message.id, index);
					contentEl.appendChild(codeBlockEl);
				});
			}
		}

		messageEl.appendChild(contentEl);
		messagesContainer.appendChild(messageEl);
	}

	function updateMessageElement(message) {
		const messageEl = document.querySelector(`[data-id="${message.id}"]`);
		if (!messageEl) return;

		const contentEl = messageEl.querySelector('.message-content');
		
		if (message.thinking) {
			contentEl.innerHTML = `
				<div class="thinking">
					<span>${message.thinking}</span>
					<div class="thinking-dots">
						<div class="thinking-dot"></div>
						<div class="thinking-dot"></div>
						<div class="thinking-dot"></div>
					</div>
				</div>
			`;
		} else {
			contentEl.innerHTML = formatMessageContent(message.content);
			
			// Add code changes
			if (message.codeChanges && message.codeChanges.length > 0) {
				message.codeChanges.forEach((change, index) => {
					const codeBlockEl = createCodeBlock(change, message.id, index);
					contentEl.appendChild(codeBlockEl);
				});
			}
		}

		scrollToBottom();
	}

	function formatMessageContent(content) {
		// Render code blocks inline
		let formatted = content.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
			const safeCode = code
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');
			return `<pre><code>${safeCode}</code></pre>`;
		});

		// Convert markdown-style formatting
		formatted = formatted
			.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
			.replace(/\*(.+?)\*/g, '<em>$1</em>')
			.replace(/`(.+?)`/g, '<code>$1</code>')
			.replace(/\n/g, '<br>');

		return formatted;
	}

	function createCodeBlock(change, messageId, changeIndex) {
		const blockEl = document.createElement('div');
		blockEl.className = 'code-block';

		const header = document.createElement('div');
		header.className = 'code-header';
		
		const fileName = document.createElement('span');
		fileName.textContent = change.file;
		
		const actions = document.createElement('div');
		actions.className = 'code-actions';
		
		if (change.applied) {
			const appliedLabel = document.createElement('button');
			appliedLabel.className = 'success';
			appliedLabel.textContent = 'Applied';
			appliedLabel.disabled = true;
			actions.appendChild(appliedLabel);
		} else {
			const applyBtn = document.createElement('button');
			applyBtn.textContent = 'Apply';
			applyBtn.addEventListener('click', () => {
				console.log('[CodeMate] Apply clicked', { messageId, changeIndex });
				vscode.postMessage({ 
					type: 'applyChange', 
					messageId, 
					changeIndex 
				});
			});
			
			const rejectBtn = document.createElement('button');
			rejectBtn.textContent = 'Reject';
			rejectBtn.addEventListener('click', () => {
				console.log('[CodeMate] Reject clicked', { messageId, changeIndex });
				vscode.postMessage({ 
					type: 'rejectChange', 
					messageId, 
					changeIndex 
				});
			});
			
			actions.appendChild(applyBtn);
			actions.appendChild(rejectBtn);
		}
		
		header.appendChild(fileName);
		header.appendChild(actions);
		
		blockEl.appendChild(header);

		if (change.diff && Array.isArray(change.diff) && change.diff.length > 0) {
			const diffEl = document.createElement('pre');
			diffEl.className = 'diff';
			change.diff.forEach((line) => {
				const lineEl = document.createElement('div');
				lineEl.className = `diff-line ${line.type}`;
				const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
				lineEl.textContent = `${prefix} ${line.text}`;
				diffEl.appendChild(lineEl);
			});
			blockEl.appendChild(diffEl);
		} else {
			const codeEl = document.createElement('pre');
			codeEl.textContent = change.newCode;
			blockEl.appendChild(codeEl);
		}
		
		return blockEl;
	}

	function scrollToBottom() {
		setTimeout(() => {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}, 100);
	}
})();
