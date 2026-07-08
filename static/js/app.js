/* =========================================================================
   PredictMaint AI — Main Application JavaScript
   Handles: chat, theme, sensors, quick-prompts, export, session stats
   ========================================================================= */

'use strict';

/* ──────────────────────────────────────────────────────────────────────────
   Constants & State
   ────────────────────────────────────────────────────────────────────────── */
const MAX_CHARS     = 2000;
const WELCOME_MSG   = `
## 👋 Welcome to PredictMaint AI

I am your **IBM Watsonx Granite**-powered Industrial Maintenance Expert.
I can help you with:

- 🔍 **Fault prediction** from sensor data or symptom descriptions
- 🔧 **Step-by-step repair** instructions for your specific machine
- ⚠️ **Safety protocols** (LOTO, PPE, zero-energy verification)
- 🛡️ **Post-repair checks** and preventive maintenance schedules

---

**To get started:**
1. Select your **machine type** from the left panel
2. Describe the fault, symptoms, or paste sensor readings
3. Or click a **Quick Diagnostic** shortcut on the left

> ⚙️ I follow strict safety-first guidelines and always provide LOTO
> instructions before any repair steps.
`;

const state = {
  sending:    false,
  msgCount:   0,
  diagCount:  0,
  sessionStart: new Date(),
  severity:   'medium',
  alerts:     [],
};

/* ──────────────────────────────────────────────────────────────────────────
   DOM References
   ────────────────────────────────────────────────────────────────────────── */
const dom = {
  messagesArea:     document.getElementById('messagesArea'),
  messageInput:     document.getElementById('messageInput'),
  sendBtn:          document.getElementById('sendBtn'),
  typingIndicator:  document.getElementById('typingIndicator'),
  machineSelect:    document.getElementById('machineSelect'),
  charCount:        document.getElementById('charCount'),
  statusDot:        document.getElementById('statusDot'),
  statusText:       document.getElementById('statusText'),
  themeToggle:      document.getElementById('themeToggle'),
  themeIcon:        document.getElementById('themeIcon'),
  clearBtn:         document.getElementById('clearBtn'),
  exportBtn:        document.getElementById('exportBtn'),
  analyzeSensorsBtn:document.getElementById('analyzeSensorsBtn'),
  statMessages:     document.getElementById('statMessages'),
  statDiagnoses:    document.getElementById('statDiagnoses'),
  statMachine:      document.getElementById('statMachine'),
  statStart:        document.getElementById('statStart'),
  alertsList:       document.getElementById('alertsList'),
  sensorTemp:       document.getElementById('sensorTemp'),
  sensorVib:        document.getElementById('sensorVib'),
  sensorPressure:   document.getElementById('sensorPressure'),
  sensorCurrent:    document.getElementById('sensorCurrent'),
};

/* ──────────────────────────────────────────────────────────────────────────
   Initialisation
   ────────────────────────────────────────────────────────────────────────── */
function init() {
  // Configure marked.js renderer
  marked.setOptions({
    breaks: true,
    gfm:    true,
  });

  // Restore or set theme
  const savedTheme = localStorage.getItem('pm-theme') || 'dark';
  setTheme(savedTheme, false);

  // Render welcome message
  appendMessage('ai', WELCOME_MSG, 'now');

  // Session start time
  dom.statStart.textContent = state.sessionStart.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  });

  // Check API health
  checkHealth();

  // Attach event listeners
  attachEvents();
}

/* ──────────────────────────────────────────────────────────────────────────
   Event Listeners
   ────────────────────────────────────────────────────────────────────────── */
function attachEvents() {
  // Send on button click
  dom.sendBtn.addEventListener('click', handleSend);

  // Send on Enter (Shift+Enter = newline)
  dom.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Auto-resize textarea + char count
  dom.messageInput.addEventListener('input', () => {
    autoResize(dom.messageInput);
    updateCharCount();
  });

  // Theme toggle
  dom.themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'light' : 'dark');
  });

  // Clear conversation
  dom.clearBtn.addEventListener('click', clearConversation);

  // Export chat
  dom.exportBtn.addEventListener('click', exportChat);

  // Quick-prompt buttons
  document.querySelectorAll('.quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      dom.messageInput.value = btn.dataset.prompt;
      autoResize(dom.messageInput);
      updateCharCount();
      dom.messageInput.focus();
    });
  });

  // Severity buttons
  document.querySelectorAll('.sev-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sev-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.severity = btn.dataset.sev;
    });
  });

  // Machine select → update stat
  dom.machineSelect.addEventListener('change', () => {
    dom.statMachine.textContent = dom.machineSelect.value;
  });
  dom.statMachine.textContent = dom.machineSelect.value;

  // Analyze sensor data button
  dom.analyzeSensorsBtn.addEventListener('click', analyzeSensors);
}

/* ──────────────────────────────────────────────────────────────────────────
   Send Message
   ────────────────────────────────────────────────────────────────────────── */
async function handleSend() {
  const msg = dom.messageInput.value.trim();
  if (!msg || state.sending) return;
  if (msg.length > MAX_CHARS) {
    showToast('Message too long (max 2000 characters)', 'danger');
    return;
  }

  // Show user message
  const time = currentTime();
  appendMessage('user', msg, time);
  dom.messageInput.value = '';
  autoResize(dom.messageInput);
  updateCharCount();

  // Update stats
  state.msgCount++;
  dom.statMessages.textContent = state.msgCount;

  // Show typing
  setLoading(true);

  try {
    const res = await fetch('/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message:      msg,
        machine_type: dom.machineSelect.value,
        severity:     state.severity,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    setLoading(false);
    appendMessage('ai', data.reply, data.timestamp || currentTime());

    // Increment diagnosis count
    state.diagCount++;
    dom.statDiagnoses.textContent = state.diagCount;

    // Add to alerts panel
    addAlert(msg, dom.machineSelect.value, state.severity);

  } catch (err) {
    setLoading(false);
    appendMessage('ai', `⚠️ **Error:** ${err.message}`, currentTime());
    setStatus('offline', 'Error');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Analyze Sensor Data
   ────────────────────────────────────────────────────────────────────────── */
function analyzeSensors() {
  const temp     = dom.sensorTemp.value.trim();
  const vib      = dom.sensorVib.value.trim();
  const pressure = dom.sensorPressure.value.trim();
  const current  = dom.sensorCurrent.value.trim();

  if (!temp && !vib && !pressure && !current) {
    showToast('Please enter at least one sensor reading', 'warning');
    return;
  }

  const parts = [];
  if (temp)     parts.push(`Temperature: ${temp}°C`);
  if (vib)      parts.push(`Vibration: ${vib} mm/s`);
  if (pressure) parts.push(`Pressure: ${pressure} bar`);
  if (current)  parts.push(`Current: ${current} A`);

  const machine = dom.machineSelect.value;
  const prompt  = `Analyze the following sensor readings for a ${machine} and predict potential faults, provide diagnosis and repair instructions:\n\n${parts.join('\n')}\n\nSeverity level: ${state.severity}`;

  dom.messageInput.value = prompt;
  autoResize(dom.messageInput);
  updateCharCount();

  // Clear sensor fields
  [dom.sensorTemp, dom.sensorVib, dom.sensorPressure, dom.sensorCurrent]
    .forEach(el => el.value = '');

  handleSend();
}

/* ──────────────────────────────────────────────────────────────────────────
   Append Message Bubble
   ────────────────────────────────────────────────────────────────────────── */
function appendMessage(role, content, time) {
  const isUser    = role === 'user';
  const isWelcome = !isUser && state.msgCount === 0 && dom.messagesArea.children.length === 0;

  const row = document.createElement('div');
  row.className = `message-row ${isUser ? 'user-row' : 'ai-row'}`;

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${isUser ? 'user' : 'ai'}${isWelcome ? ' welcome' : ''}`;

  if (isUser) {
    bubble.textContent = content;
  } else {
    // Render markdown for AI responses
    bubble.innerHTML = marked.parse(content);
  }

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = isUser ? `You · ${time}` : `AI Agent · ${time}`;

  // Avatar
  let avatarHtml = '';
  if (!isUser) {
    avatarHtml = `<div class="ai-avatar-sm flex-shrink-0"><i class="bi bi-robot"></i></div>`;
  }

  if (isUser) {
    row.innerHTML = `
      <div>
        <div class="message-bubble user">${escapeHtml(content)}</div>
        <div class="msg-meta">You · ${time}</div>
      </div>
    `;
  } else {
    const rendered = marked.parse(content);
    row.innerHTML = `
      ${avatarHtml}
      <div>
        <div class="message-bubble ai${isWelcome ? ' welcome' : ''}">${rendered}</div>
        <div class="msg-meta">AI Agent · ${time}</div>
      </div>
    `;
  }

  dom.messagesArea.appendChild(row);
  scrollToBottom();
}

/* ──────────────────────────────────────────────────────────────────────────
   Loading State
   ────────────────────────────────────────────────────────────────────────── */
function setLoading(on) {
  state.sending = on;
  dom.sendBtn.disabled = on;
  dom.analyzeSensorsBtn.disabled = on;

  if (on) {
    dom.typingIndicator.classList.remove('d-none');
    scrollToBottom();
  } else {
    dom.typingIndicator.classList.add('d-none');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Clear Conversation
   ────────────────────────────────────────────────────────────────────────── */
async function clearConversation() {
  try {
    await fetch('/api/clear', { method: 'POST' });
  } catch (_) { /* ignore */ }

  dom.messagesArea.innerHTML = '';
  state.msgCount  = 0;
  state.diagCount = 0;
  dom.statMessages.textContent  = '0';
  dom.statDiagnoses.textContent = '0';
  dom.alertsList.innerHTML = '<div class="no-alerts">No alerts this session</div>';
  state.alerts = [];

  appendMessage('ai', WELCOME_MSG, currentTime());
  showToast('Conversation cleared', 'success');
}

/* ──────────────────────────────────────────────────────────────────────────
   Export Chat
   ────────────────────────────────────────────────────────────────────────── */
function exportChat() {
  const rows  = dom.messagesArea.querySelectorAll('.message-row');
  if (!rows.length) { showToast('Nothing to export', 'warning'); return; }

  let txt = `PredictMaint AI — Chat Export\nDate: ${new Date().toLocaleString()}\n${'='.repeat(60)}\n\n`;

  rows.forEach(row => {
    const isUser = row.classList.contains('user-row');
    const bubble = row.querySelector('.message-bubble');
    const meta   = row.querySelector('.msg-meta');
    if (bubble) {
      const label = isUser ? '[USER]' : '[AI]  ';
      txt += `${label}  ${meta ? meta.textContent : ''}\n`;
      txt += bubble.innerText + '\n\n' + '-'.repeat(40) + '\n\n';
    }
  });

  const blob = new Blob([txt], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `predictmaint-export-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Chat exported', 'success');
}

/* ──────────────────────────────────────────────────────────────────────────
   Alerts Panel
   ────────────────────────────────────────────────────────────────────────── */
function addAlert(msg, machine, severity) {
  const noAlerts = dom.alertsList.querySelector('.no-alerts');
  if (noAlerts) noAlerts.remove();

  // Keep max 5 alerts
  if (state.alerts.length >= 5) {
    state.alerts.shift();
    dom.alertsList.firstChild && dom.alertsList.removeChild(dom.alertsList.firstChild);
  }

  const shortMsg = msg.length > 50 ? msg.substring(0, 50) + '…' : msg;
  const item = document.createElement('div');
  item.className = `alert-item ${severity}`;
  item.innerHTML = `<strong>${machine}</strong> — ${shortMsg}`;
  dom.alertsList.appendChild(item);
  state.alerts.push({ msg, machine, severity });
}

/* ──────────────────────────────────────────────────────────────────────────
   Health Check
   ────────────────────────────────────────────────────────────────────────── */
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      setStatus('online', 'Connected');
    } else {
      setStatus('offline', 'API Error');
    }
  } catch {
    setStatus('offline', 'Offline');
  }
}

function setStatus(state, text) {
  dom.statusDot.className  = `status-dot ${state}`;
  dom.statusText.textContent = text;
}

/* ──────────────────────────────────────────────────────────────────────────
   Theme Toggle
   ────────────────────────────────────────────────────────────────────────── */
function setTheme(theme, save = true) {
  document.documentElement.setAttribute('data-theme', theme);
  dom.themeIcon.className = theme === 'dark'
    ? 'bi bi-sun-fill'
    : 'bi bi-moon-stars-fill';
  if (save) localStorage.setItem('pm-theme', theme);
}

/* ──────────────────────────────────────────────────────────────────────────
   Toast Notification
   ────────────────────────────────────────────────────────────────────────── */
function showToast(msg, type = 'info') {
  const colours = {
    success: '#3fb950',
    warning: '#d29922',
    danger:  '#f85149',
    info:    '#58a6ff',
  };

  const toast = document.createElement('div');
  toast.style.cssText = `
    position:fixed; bottom:60px; right:20px; z-index:9999;
    background:var(--bg-elevated); border:1px solid ${colours[type] || colours.info};
    color:var(--text-primary); padding:10px 18px; border-radius:10px;
    font-size:13px; font-weight:500; box-shadow:0 4px 20px rgba(0,0,0,.4);
    animation: fadeIn .2s ease;
    max-width: 300px;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

/* ──────────────────────────────────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────────────────────────────────── */
function scrollToBottom() {
  requestAnimationFrame(() => {
    dom.messagesArea.scrollTop = dom.messagesArea.scrollHeight;
  });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function updateCharCount() {
  const len = dom.messageInput.value.length;
  dom.charCount.textContent = `${len} / ${MAX_CHARS}`;
  dom.charCount.className = 'char-count' +
    (len > MAX_CHARS      ? ' over' :
     len > MAX_CHARS * .8 ? ' warn' : '');
}

function currentTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ──────────────────────────────────────────────────────────────────────────
   Bootstrap
   ────────────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
