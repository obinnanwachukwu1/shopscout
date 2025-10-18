/**
 * ShopScout Chat Controller
 *
 * Handles chat interactions in the side panel
 */

let currentProduct = null;
let chatHistory = [];

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
    if (message.type === 'ANALYSIS_UPDATED') {
      currentProduct = message.data?.productData;
      updateProductBadge();
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
      currentProduct = response.data.productData;
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
    const response = await chrome.runtime.sendMessage({
      type: 'USER_QUESTION',
      question: message,
      context: { productData: currentProduct }
    });

    if (response.success && response.data) {
      addMessage('assistant', response.data.answer, response.data.source);
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
    const sourceLink = document.createElement('div');
    sourceLink.className = 'message-source';
    sourceLink.textContent = '📍 View source on page';
    sourceLink.onclick = () => highlightSource(source);
    messageContent.appendChild(sourceLink);
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
