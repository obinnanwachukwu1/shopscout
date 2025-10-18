/**
 * ShopScout Chat Controller
 *
 * Handles chat interactions in the side panel
 */

let currentProduct = null;
let chatHistory = [];
let currentAnalysis = null;
const toolStatusMessages = new Map();
let activeStream = null;
let lastErroredStreamId = null;

// DOM elements
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const typingIndicator = document.getElementById('typingIndicator');
const emptyState = document.getElementById('emptyState');
const productBadge = document.getElementById('productBadge');
const suggestedQuestions = document.querySelectorAll('.suggested-question');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadCurrentProduct();
  setupEventListeners();
});

/**
 * Setup event listeners
 */
function setupEventListeners() {
  sendBtn.addEventListener('click', handleSendMessage);

  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  // Auto-resize textarea
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = chatInput.scrollHeight + 'px';
  });

  // Suggested questions
  suggestedQuestions.forEach(btn => {
    btn.addEventListener('click', () => {
      chatInput.value = btn.textContent;
      handleSendMessage();
    });
  });

  // Listen for updates from background
  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'ANALYSIS_UPDATED':
        currentAnalysis = message.data || null;
        currentProduct = message.data?.rawProductData || message.data?.productData || null;
        updateProductBadge();
        break;
      case 'CHAT_PROGRESS':
        handleChatProgress(message.data);
        break;
      case 'CHAT_STREAM_START':
        handleStreamStart(message.data);
        break;
      case 'CHAT_STREAM_CHUNK':
        handleStreamChunk(message.data);
        break;
      case 'CHAT_STREAM_END':
        handleStreamEnd(message.data);
        break;
      case 'CHAT_STREAM_ERROR':
        handleStreamError(message.data);
        break;
      case 'QUESTION_ANSWERED':
        if (!message.data?.streamed) {
          const data = message.data || {};
          if (data.streamId && data.streamId === lastErroredStreamId) {
            lastErroredStreamId = null;
            break;
          }
          addMessage('assistant', data.answer || 'I could not find that information.', data.source || null);
        }
        break;
      default:
        break;
    }
  });
}

/**
 * Load current product data
 */
async function loadCurrentProduct() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_CURRENT_ANALYSIS'
    });

    if (response.success && response.data) {
      currentAnalysis = response.data;
      currentProduct = response.data.rawProductData || response.data.productData;
      updateProductBadge();
    }
  } catch (error) {
    console.error('Error loading product:', error);
  }
}

/**
 * Update product badge
 */
function updateProductBadge() {
  if (currentProduct) {
    productBadge.textContent = currentProduct.title || 'Product loaded';
    productBadge.title = currentProduct.title;
  } else {
    productBadge.textContent = 'No product selected';
  }
}

/**
 * Handle send message
 */
async function handleSendMessage() {
  const message = chatInput.value.trim();
  if (!message) return;

  // Add user message to chat
  addMessage('user', message);
  chatInput.value = '';
  chatInput.style.height = 'auto';

  // Hide empty state
  if (emptyState) {
    emptyState.style.display = 'none';
  }

  // Disable input while processing
  sendBtn.disabled = true;
  chatInput.disabled = true;
  typingIndicator.classList.add('active');

  try {
    const contextPayload = {
      productData: currentProduct,
      rawProductData: currentProduct
    };

    if (currentAnalysis) {
      contextPayload.analysis = {
        rawProductData: currentAnalysis.rawProductData || currentProduct,
        externalReviews: currentAnalysis.externalReviews || null
      };

      if (currentAnalysis.externalReviews) {
        contextPayload.externalReviews = currentAnalysis.externalReviews;
      }
    }

    const response = await chrome.runtime.sendMessage({
      type: 'USER_QUESTION',
      question: message,
      context: contextPayload
    });

    if (response.success && response.data) {
      if (!response.data.streamed) {
        addMessage('assistant', response.data.answer || 'I could not find that information.', response.data.source || null);
      }
    } else {
      addMessage('assistant', 'Sorry, I could not answer that question.');
    }
  } catch (error) {
    console.error('Error sending message:', error);
    addMessage('assistant', 'An error occurred. Please try again.');
  } finally {
    sendBtn.disabled = false;
    chatInput.disabled = false;
    typingIndicator.classList.remove('active');
    chatInput.focus();
  }
}

function createSourceLink(source) {
  const sourceLink = document.createElement('div');
  sourceLink.className = 'message-source';
  sourceLink.textContent = '📍 View source on page';
  sourceLink.onclick = () => highlightSource(source);
  return sourceLink;
}

/**
 * Add message to chat
 */
function addMessage(role, content, source = null) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? '👤' : '🔍';

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';
  messageContent.textContent = content;

  // Add source link if available
  if (source && role === 'assistant') {
    messageContent.appendChild(createSourceLink(source));
  }

  messageDiv.appendChild(avatar);
  messageDiv.appendChild(messageContent);

  // Insert before typing indicator
  chatMessages.insertBefore(messageDiv, typingIndicator);

  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Add to history
  chatHistory.push({ role, content, source });
}

function handleChatProgress(event = {}) {
  if (!event) return;

  if (event.type === 'tool_call') {
    handleToolCallEvent(event);
  }
}

function handleToolCallEvent(event) {
  const toolCallId = event?.toolCallId;
  if (!toolCallId) {
    return;
  }

  let entry = toolStatusMessages.get(toolCallId);
  const queryText = event?.query ? `“${event.query}”` : event?.tool || 'tool';

  if (!entry) {
    entry = createStatusMessage('🔍', `Searching for ${queryText}...`);
    toolStatusMessages.set(toolCallId, entry);
  }

  switch (event.status) {
    case 'start':
      entry.avatarEl.textContent = '🔍';
      entry.primaryEl.textContent = `Searching for ${queryText}...`;
      entry.secondaryEl.textContent = event.siteFilter ? `Site filter: ${event.siteFilter}` : '';
      break;
    case 'complete':
      entry.avatarEl.textContent = '✅';
      entry.primaryEl.textContent = `Search complete for ${queryText}`;
      entry.secondaryEl.textContent = event.summary || '';
      break;
    case 'error':
      entry.avatarEl.textContent = '⚠️';
      entry.primaryEl.textContent = `Search failed for ${queryText}`;
      entry.secondaryEl.textContent = event.error || 'Unknown error';
      break;
    default:
      break;
  }
}

function createStatusMessage(icon, primaryText, secondaryText = '') {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message status';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = icon;

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  const primaryEl = document.createElement('div');
  primaryEl.className = 'message-status-primary';
  primaryEl.textContent = primaryText;

  const secondaryEl = document.createElement('div');
  secondaryEl.className = 'message-status-secondary';
  secondaryEl.textContent = secondaryText;

  messageContent.appendChild(primaryEl);
  messageContent.appendChild(secondaryEl);

  messageDiv.appendChild(avatar);
  messageDiv.appendChild(messageContent);

  chatMessages.insertBefore(messageDiv, typingIndicator);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  return { messageDiv, avatarEl: avatar, primaryEl, secondaryEl };
}

function handleStreamStart(data = {}) {
  if (activeStream && activeStream.messageDiv?.parentNode) {
    activeStream.messageDiv.remove();
    activeStream = null;
  }

  activeStream = createStreamingMessage(
    data?.streamId || `stream_${Date.now()}`,
    data?.source || null,
    data?.search || null
  );
}

function createStreamingMessage(streamId, source = null, search = null) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant streaming';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = '🔍';

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  const textEl = document.createElement('div');
  textEl.className = 'message-text';
  messageContent.appendChild(textEl);

  messageDiv.appendChild(avatar);
  messageDiv.appendChild(messageContent);

  chatMessages.insertBefore(messageDiv, typingIndicator);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  return {
    streamId,
    messageDiv,
    messageContent,
    textEl,
    source,
    search
  };
}

function handleStreamChunk(data = {}) {
  if (!activeStream) {
    return;
  }

  if (data?.streamId && activeStream.streamId !== data.streamId) {
    return;
  }

  if (typeof data?.chunk === 'string') {
    activeStream.textEl.textContent += data.chunk;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function handleStreamEnd(data = {}) {
  if (!activeStream) {
    if (typeof data?.fullAnswer === 'string') {
      addMessage('assistant', data.fullAnswer, data.source || null);
    }
    return;
  }

  if (data?.streamId && activeStream.streamId !== data.streamId) {
    return;
  }

  const finalAnswer = typeof data?.fullAnswer === 'string'
    ? data.fullAnswer
    : activeStream.textEl.textContent;

  activeStream.textEl.textContent = finalAnswer;

  const source = data?.source || activeStream.source || null;
  if (source) {
    activeStream.messageContent.appendChild(createSourceLink(source));
  }

  chatHistory.push({
    role: 'assistant',
    content: finalAnswer,
    source
  });

  activeStream = null;
}

function handleStreamError(data = {}) {
  const fallback = data?.message || 'Something went wrong while answering.';

  if (data?.streamId) {
    lastErroredStreamId = data.streamId;
  }

  if (activeStream) {
    activeStream.textEl.textContent = fallback;
    chatHistory.push({
      role: 'assistant',
      content: fallback,
      source: null
    });
    activeStream = null;
    return;
  }

  addMessage('assistant', fallback);
}

/**
 * Highlight source on product page
 */
async function highlightSource(selector) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'HIGHLIGHT_ELEMENT',
        selector
      });
    }
  } catch (error) {
    console.error('Error highlighting source:', error);
  }
}

console.log('ShopScout chat loaded');
