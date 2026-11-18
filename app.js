const PREFIX = "sachiin-quickchat-hd-";
const CHUNK_SIZE = 64 * 1024;

let peer = null;
let conn = null;
let myRoomCode = Math.floor(1000 + Math.random() * 9000).toString();
let typingTimeout = null;

// Reply & Edit State
let activeReplyText = null;
let editingMsgId = null;
let msgCounter = 0;

// Themes & Icebreakers
const THEMES = ['theme-default', 'theme-insta', 'theme-cyber', 'theme-sunset'];
let currentThemeIdx = 0;

const ICEBREAKERS = [
    "TRUTH: Apne phone ki sabse ajeeb photo kaunsi hai? Bhej ke dikhao! 📸",
    "DARE: Ek voice note mein apna favourite gaana 5 second gaake bhejo! 🎤",
    "QUESTION: Agar abhi kahin ghumne jaane ka mauka mile toh kahan jaoge? ✈️",
    "TRUTH: Last time kis baat par sabse zyada hasi aayi thi? 😂",
    "DARE: Apni gallery ki 3rd photo bina dekhe abhi yahan bhejo! 🔥",
    "QUESTION: Raat ke 2 baje sabse zyada kis cheez ki bhook lagti hai? 🍕"
];

// Voice Recorder State
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

// Incoming File Buffer
let incomingFile = { chunks: [], receivedBytes: 0, totalBytes: 0, fileName: '', mimeType: '', time: '', msgId: '' };

// Sound Effects
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playPopSound() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.08);
    osc.start(); osc.stop(audioCtx.currentTime + 0.08);
}

function initPeer() {
    peer = new Peer(PREFIX + myRoomCode);
    peer.on('open', () => {
        document.getElementById('myRoomCode').textContent = myRoomCode;
        document.getElementById('hostStatus').textContent = "🟢 Ready! Waiting for friend to join...";
    });
    peer.on('connection', (connection) => {
        conn = connection;
        setupConnection();
    });
    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            myRoomCode = Math.floor(1000 + Math.random() * 9000).toString();
            initPeer();
        } else {
            document.getElementById('joinStatus').textContent = "Room not found or offline. Check code!";
        }
    });
}
initPeer();

function switchTab(tab) {
    document.getElementById('createTabBtn').classList.toggle('active', tab === 'create');
    document.getElementById('joinTabBtn').classList.toggle('active', tab === 'join');
    document.getElementById('createPanel').classList.toggle('hidden', tab !== 'create');
    document.getElementById('joinPanel').classList.toggle('hidden', tab !== 'join');
}

document.getElementById('copyCodeBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(myRoomCode);
    const btn = document.getElementById('copyCodeBtn');
    btn.textContent = "✅";
    setTimeout(() => btn.textContent = "📋", 1500);
});

document.getElementById('connectBtn').addEventListener('click', () => {
    const code = document.getElementById('joinCodeInput').value.trim();
    if (code.length !== 4) {
        document.getElementById('joinStatus').textContent = "Please enter a valid 4-digit code!";
        return;
    }
    document.getElementById('joinStatus').textContent = "Connecting...";
    conn = peer.connect(PREFIX + code, { reliable: true });
    setupConnection();
});

function setupConnection() {
    conn.on('open', () => {
        const myName = document.getElementById('usernameInput').value.trim() || "User";
        conn.send({ type: 'intro', name: myName });
        document.getElementById('connectScreen').classList.add('hidden');
        document.getElementById('chatScreen').classList.remove('hidden');
    });

    conn.on('data', (data) => {
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            const buffer = data instanceof ArrayBuffer ? data : data.buffer;
            incomingFile.chunks.push(buffer);
            incomingFile.receivedBytes += buffer.byteLength;

            const pct = Math.min(100, Math.round((incomingFile.receivedBytes / incomingFile.totalBytes) * 100));
            updateProgress(true, `Receiving ${incomingFile.fileName}... ${pct}%`, pct);

            if (incomingFile.receivedBytes >= incomingFile.totalBytes) {
                const fullBlob = new Blob(incomingFile.chunks, { type: incomingFile.mimeType });
                const blobUrl = URL.createObjectURL(fullBlob);
                appendUniversalFile(blobUrl, incomingFile.fileName, incomingFile.mimeType, incomingFile.totalBytes, 'received', incomingFile.time, incomingFile.msgId);
                playPopSound();
                updateProgress(false);
                incomingFile.chunks = [];
            }
            return;
        }

        if (data.type === 'intro') {
            document.getElementById('peerName').textContent = data.name;
            document.getElementById('peerAvatar').textContent = data.name.charAt(0).toUpperCase();
        } else if (data.type === 'chat') {
            appendMessage(data.text, 'received', data.time, data.msgId, data.replyTo);
            playPopSound();
        } else if (data.type === 'edit') {
            applyEditToMessage(data.msgId, data.newText);
        } else if (data.type === 'unsend') {
            applyUnsendToMessage(data.msgId);
        } else if (data.type === 'react') {
            toggleHeartOnMsg(data.msgId);
            playPopSound();
        } else if (data.type === 'theme') {
            document.body.className = data.theme;
        } else if (data.type === 'game') {
            appendGameCard(data.prompt);
            playPopSound();
        } else if (data.type === 'file-meta') {
            incomingFile = { chunks: [], receivedBytes: 0, totalBytes: data.size, fileName: data.name, mimeType: data.mime, time: data.time, msgId: data.msgId };
            updateProgress(true, `Receiving ${data.name}... 0%`, 0);
        } else if (data.type === 'typing') {
            document.getElementById('peerStatus').textContent = data.isTyping ? "typing..." : "● Online • E2E Encrypted";
        }
    });

    conn.on('close', () => {
        document.getElementById('peerStatus').textContent = "🔴 Disconnected";
        document.getElementById('peerStatus').style.color = "#f87171";
    });
}

// Theme Switcher
document.getElementById('themeBtn').addEventListener('click', () => {
    currentThemeIdx = (currentThemeIdx + 1) % THEMES.length;
    const newTheme = THEMES[currentThemeIdx];
    document.body.className = newTheme;
    if (conn && conn.open) conn.send({ type: 'theme', theme: newTheme });
});

// Fun Icebreaker Game
document.getElementById('gameBtn').addEventListener('click', () => {
    const prompt = ICEBREAKERS[Math.floor(Math.random() * ICEBREAKERS.length)];
    appendGameCard(prompt);
    if (conn && conn.open) conn.send({ type: 'game', prompt });
});

function appendGameCard(prompt) {
    const container = document.getElementById('messagesContainer');
    const card = document.createElement('div');
    card.className = 'game-card';
    card.innerHTML = `<span>🎲 FUN ICEBREAKER</span>${prompt}`;
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
}

// Voice Note Recording
document.getElementById('micBtn').addEventListener('click', async () => {
    const micBtn = document.getElementById('micBtn');
    if (!isRecording) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                await sendBinaryFile(audioBlob, `VoiceNote_${Date.now()}.webm`, 'audio/webm');
                stream.getTracks().forEach(t => t.stop());
            };
            mediaRecorder.start();
            isRecording = true;
            micBtn.classList.add('recording');
            micBtn.textContent = "⏹";
        } catch {
            alert("Mic permission denied! Browser settings mein mic allow karo.");
        }
    } else {
        mediaRecorder.stop();
        isRecording = false;
        micBtn.classList.remove('recording');
        micBtn.textContent = "🎤";
    }
});

// Send or Save Edited Message
function sendMessage() {
    const input = document.getElementById('msgInput');
    const text = input.value.trim();
    if (!text || !conn || !conn.open) return;

    if (editingMsgId) {
        applyEditToMessage(editingMsgId, text);
        conn.send({ type: 'edit', msgId: editingMsgId, newText: text });
        input.value = '';
        cancelAction();
        toggleSendMicButtons();
        return;
    }

    const time = getCurrentTime();
    const msgId = `msg-${Date.now()}-${++msgCounter}`;
    conn.send({ type: 'chat', text, time, msgId, replyTo: activeReplyText });
    conn.send({ type: 'typing', isTyping: false });

    appendMessage(text, 'sent', time, msgId, activeReplyText);
    input.value = '';
    cancelAction();
    toggleSendMicButtons();
}

function sendEmoji(emoji) {
    if (!conn || !conn.open) return;
    const time = getCurrentTime();
    const msgId = `msg-${Date.now()}-${++msgCounter}`;
    conn.send({ type: 'chat', text: emoji, time, msgId, replyTo: null });
    appendMessage(emoji, 'sent', time, msgId, null);
}

function closeAllMenus() {
    document.querySelectorAll('.msg-popup-menu').forEach(m => m.remove());
}

// Mobile-Touch Proof Popup Menu
function toggleMessageMenu(wrapper, msgId, side, isTextMsg) {
    const existing = wrapper.querySelector('.msg-popup-menu');
    closeAllMenus();
    if (existing) return;

    const bubble = document.getElementById(msgId);
    if (!bubble || bubble.classList.contains('unsent-bubble')) return;

    const menu = document.createElement('div');
    menu.className = 'msg-popup-menu';

    const bindTap = (btn, handler) => {
        const trigger = (e) => {
            e.preventDefault();
            e.stopPropagation();
            handler();
            closeAllMenus();
        };
        btn.addEventListener('touchend', trigger, { passive: false });
        btn.addEventListener('click', trigger);
    };

    // 1. Heart React Button
    const reactBtn = document.createElement('button');
    reactBtn.type = 'button';
    reactBtn.className = 'popup-btn';
    reactBtn.textContent = '❤️';
    bindTap(reactBtn, () => {
        toggleHeartOnMsg(msgId);
        if (conn && conn.open) conn.send({ type: 'react', msgId });
    });
    menu.appendChild(reactBtn);

    // 2. Reply Button
    if (isTextMsg) {
        const replyBtn = document.createElement('button');
        replyBtn.type = 'button';
        replyBtn.className = 'popup-btn';
        replyBtn.textContent = '↩ Reply';
        bindTap(replyBtn, () => {
            const txt = bubble.querySelector('.msg-text')?.textContent || 'Media';
            startReply(txt);
        });
        menu.appendChild(replyBtn);
    }

    // 3. Edit & Unsend Buttons (Only for Sent Messages)
    if (side === 'sent') {
        if (isTextMsg) {
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'popup-btn';
            editBtn.textContent = '✏️ Edit';
            bindTap(editBtn, () => startEdit(msgId));
            menu.appendChild(editBtn);
        }

        const unsendBtn = document.createElement('button');
        unsendBtn.type = 'button';
        unsendBtn.className = 'popup-btn danger';
        unsendBtn.textContent = '🗑️ Unsend';
        bindTap(unsendBtn, () => unsendMessage(msgId));
        menu.appendChild(unsendBtn);
    }

    wrapper.appendChild(menu);
}

function startReply(text) {
    cancelAction();
    activeReplyText = text;
    document.getElementById('actionLabel').textContent = "Replying to:";
    document.getElementById('actionPreviewText').textContent = text;
    document.getElementById('actionBar').classList.remove('hidden');
    document.getElementById('msgInput').focus();
}

function startEdit(msgId) {
    const bubble = document.getElementById(msgId);
    if (!bubble || bubble.classList.contains('unsent-bubble')) return;
    const textEl = bubble.querySelector('.msg-text');
    if (!textEl) return;

    cancelAction();
    editingMsgId = msgId;
    document.getElementById('actionLabel').textContent = "✏️ Editing message:";
    document.getElementById('actionPreviewText').textContent = textEl.textContent;
    document.getElementById('actionBar').classList.remove('hidden');

    const input = document.getElementById('msgInput');
    input.value = textEl.textContent;
    input.focus();
    toggleSendMicButtons();
}

function unsendMessage(msgId) {
    applyUnsendToMessage(msgId);
    if (conn && conn.open) {
        conn.send({ type: 'unsend', msgId });
    }
}

function applyEditToMessage(msgId, newText) {
    const bubble = document.getElementById(msgId);
    if (!bubble || bubble.classList.contains('unsent-bubble')) return;
    const textEl = bubble.querySelector('.msg-text');
    if (textEl) textEl.textContent = newText;

    const meta = bubble.querySelector('.msg-meta');
    if (meta && !meta.querySelector('.edited-tag')) {
        const tag = document.createElement('span');
        tag.className = 'edited-tag';
        tag.textContent = '(edited)';
        meta.prepend(tag);
    }
}

function applyUnsendToMessage(msgId) {
    const bubble = document.getElementById(msgId);
    if (!bubble) return;
    bubble.className = 'msg-bubble unsent-bubble';
    bubble.innerHTML = '🚫 This message was unsent';
    closeAllMenus();
}

function cancelAction() {
    activeReplyText = null;
    editingMsgId = null;
    document.getElementById('actionBar').classList.add('hidden');
}

function toggleHeartOnMsg(msgId) {
    const bubble = document.getElementById(msgId);
    if (!bubble || bubble.classList.contains('unsent-bubble')) return;
    let badge = bubble.querySelector('.heart-badge');
    if (badge) badge.remove();
    else {
        badge = document.createElement('div');
        badge.className = 'heart-badge';
        badge.textContent = '❤️';
        bubble.appendChild(badge);
    }
}

function appendMessage(text, side, time, msgId, replyTo) {
    const container = document.getElementById('messagesContainer');
    const wrapper = document.createElement('div');
    wrapper.className = `msg-wrapper ${side}`;
    wrapper.id = `wrap-${msgId}`;

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble msg-${side}`;
    bubble.id = msgId;

    if (replyTo) {
        const quote = document.createElement('div');
        quote.className = 'quote-box';
        quote.textContent = replyTo;
        bubble.appendChild(quote);
    }

    const textDiv = document.createElement('div');
    textDiv.className = 'msg-text';
    textDiv.textContent = text;

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = `<span>${time}</span> ${side === 'sent' ? '<span>✓✓</span>' : ''}`;

    bubble.appendChild(textDiv);
    bubble.appendChild(meta);

    bubble.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMessageMenu(wrapper, msgId, side, true);
    });

    wrapper.appendChild(bubble);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
}

// Universal File & Audio Transfer
async function sendBinaryFile(fileOrBlob, fileName, mimeType) {
    if (!conn || !conn.open) return;
    const time = getCurrentTime();
    const msgId = `msg-${Date.now()}-${++msgCounter}`;
    const arrayBuffer = await fileOrBlob.arrayBuffer();

    conn.send({ type: 'file-meta', name: fileName, size: arrayBuffer.byteLength, mime: mimeType, time, msgId });

    let offset = 0;
    while (offset < arrayBuffer.byteLength) {
        const chunk = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
        conn.send(chunk);
        offset += CHUNK_SIZE;

        const pct = Math.min(100, Math.round((offset / arrayBuffer.byteLength) * 100));
        updateProgress(true, `Sending ${fileName}... ${pct}%`, pct);
        await new Promise(r => setTimeout(r, 4));
    }

    updateProgress(false);
    const localBlobUrl = URL.createObjectURL(fileOrBlob);
    appendUniversalFile(localBlobUrl, fileName, mimeType, arrayBuffer.byteLength, 'sent', time, msgId);
}

document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await sendBinaryFile(file, file.name, file.type || 'application/octet-stream');
    e.target.value = '';
});

function appendUniversalFile(blobUrl, fileName, mimeType, byteSize, side, time, msgId) {
    const container = document.getElementById('messagesContainer');
    const wrapper = document.createElement('div');
    wrapper.className = `msg-wrapper ${side}`;
    wrapper.id = `wrap-${msgId}`;

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble msg-${side}`;
    bubble.id = msgId;

    if (mimeType.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.src = blobUrl;
        audio.controls = true;
        bubble.appendChild(audio);
    } else if (mimeType.startsWith('image/')) {
        const badge = document.createElement('div');
        badge.className = 'hd-badge';
        badge.textContent = `💎 ORIGINAL HD PHOTO • ${formatFileSize(byteSize)}`;
        bubble.appendChild(badge);

        const img = document.createElement('img');
        img.src = blobUrl;
        img.className = 'msg-img';
        img.onclick = (e) => { e.stopPropagation(); openModal(blobUrl); };
        bubble.appendChild(img);
    } else if (mimeType.startsWith('video/')) {
        const badge = document.createElement('div');
        badge.className = 'hd-badge';
        badge.textContent = `🎬 ORIGINAL HD VIDEO • ${formatFileSize(byteSize)}`;
        bubble.appendChild(badge);

        const video = document.createElement('video');
        video.src = blobUrl;
        video.controls = true;
        video.className = 'msg-img';
        bubble.appendChild(video);
    } else {
        const badge = document.createElement('div');
        badge.className = 'hd-badge';
        badge.textContent = `📄 DOCUMENT • ${formatFileSize(byteSize)}`;
        bubble.appendChild(badge);

        const docTitle = document.createElement('div');
        docTitle.style.fontWeight = '700';
        docTitle.style.marginBottom = '6px';
        docTitle.textContent = `📁 ${fileName}`;
        bubble.appendChild(docTitle);
    }

    if (!mimeType.startsWith('audio/')) {
        const dlBtn = document.createElement('a');
        dlBtn.href = blobUrl;
        dlBtn.download = fileName || 'QuickChat_File';
        dlBtn.className = 'download-hd-btn';
        dlBtn.textContent = `⬇ Download Original (${formatFileSize(byteSize)})`;
        dlBtn.onclick = (e) => e.stopPropagation();
        bubble.appendChild(dlBtn);
    }

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = `<span>${time}</span> ${side === 'sent' ? '<span>✓✓</span>' : ''}`;
    bubble.appendChild(meta);

    bubble.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMessageMenu(wrapper, msgId, side, false);
    });

    wrapper.appendChild(bubble);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
}

document.getElementById('messagesContainer').addEventListener('click', closeAllMenus);

function updateProgress(show, text = '', pct = 0) {
    const bar = document.getElementById('transferBar');
    if (!show) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    document.getElementById('transferText').textContent = text;
    document.getElementById('progressFill').style.width = `${pct}%`;
}

function getCurrentTime() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function formatFileSize(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function openModal(src) {
    document.getElementById('modalImg').src = src;
    document.getElementById('imageModal').classList.remove('hidden');
}
function closeModal() { document.getElementById('imageModal').classList.add('hidden'); }

function toggleSendMicButtons() {
    const hasText = document.getElementById('msgInput').value.trim().length > 0;
    document.getElementById('sendBtn').classList.toggle('hidden', !hasText);
    document.getElementById('micBtn').classList.toggle('hidden', hasText);
}

document.getElementById('msgInput').addEventListener('input', () => {
    toggleSendMicButtons();
    if (!conn || !conn.open) return;
    conn.send({ type: 'typing', isTyping: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { conn.send({ type: 'typing', isTyping: false }); }, 1200);
});

document.getElementById('msgInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('leaveBtn').addEventListener('click', () => location.reload());

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        const chatScreen = document.getElementById('chatScreen');
        chatScreen.style.height = `${window.visualViewport.height}px`;
        const container = document.getElementById('messagesContainer');
        container.scrollTop = container.scrollHeight;
    });
}