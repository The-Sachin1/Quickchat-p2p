const PREFIX = "sachiin-quickchat-hd-";
const CHUNK_SIZE = 64 * 1024; // 64KB chunks for 100% lossless transfer

let peer = null;
let conn = null;
let myRoomCode = Math.floor(1000 + Math.random() * 9000).toString();
let typingTimeout = null;

// Incoming File Buffer State
let incomingFile = {
    chunks: [],
    receivedBytes: 0,
    totalBytes: 0,
    fileName: '',
    mimeType: '',
    time: ''
};

// Notification Sound
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
        // 1. Binary ArrayBuffer Chunk (Photos, Videos, Docs)
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            const buffer = data instanceof ArrayBuffer ? data : data.buffer;
            incomingFile.chunks.push(buffer);
            incomingFile.receivedBytes += buffer.byteLength;

            const pct = Math.min(100, Math.round((incomingFile.receivedBytes / incomingFile.totalBytes) * 100));
            updateProgress(true, `Receiving ${incomingFile.fileName}... ${pct}%`, pct);

            if (incomingFile.receivedBytes >= incomingFile.totalBytes) {
                const fullBlob = new Blob(incomingFile.chunks, { type: incomingFile.mimeType });
                const blobUrl = URL.createObjectURL(fullBlob);
                appendUniversalFile(blobUrl, incomingFile.fileName, incomingFile.mimeType, incomingFile.totalBytes, 'received', incomingFile.time);
                playPopSound();
                updateProgress(false);
                incomingFile.chunks = [];
            }
            return;
        }

        // 2. JSON Control & Text Messages
        if (data.type === 'intro') {
            document.getElementById('peerName').textContent = data.name;
            document.getElementById('peerAvatar').textContent = data.name.charAt(0).toUpperCase();
        } else if (data.type === 'chat') {
            appendMessage(data.text, 'received', data.time);
            playPopSound();
        } else if (data.type === 'file-meta') {
            incomingFile = {
                chunks: [],
                receivedBytes: 0,
                totalBytes: data.size,
                fileName: data.name,
                mimeType: data.mime,
                time: data.time
            };
            updateProgress(true, `Receiving ${data.name}... 0%`, 0);
        } else if (data.type === 'typing') {
            document.getElementById('peerStatus').textContent = data.isTyping ? "typing..." : "● Online (HD Ready)";
        }
    });

    conn.on('close', () => {
        document.getElementById('peerStatus').textContent = "🔴 Disconnected";
        document.getElementById('peerStatus').style.color = "#f87171";
    });
}

function updateProgress(show, text = '', pct = 0) {
    const bar = document.getElementById('transferBar');
    if (!show) {
        bar.classList.add('hidden');
        return;
    }
    bar.classList.remove('hidden');
    document.getElementById('transferText').textContent = text;
    document.getElementById('progressFill').style.width = `${pct}%`;
}

function getCurrentTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sendMessage() {
    const input = document.getElementById('msgInput');
    const text = input.value.trim();
    if (!text || !conn || !conn.open) return;

    const time = getCurrentTime();
    conn.send({ type: 'chat', text, time });
    conn.send({ type: 'typing', isTyping: false });
    appendMessage(text, 'sent', time);
    input.value = '';
}

function sendEmoji(emoji) {
    if (!conn || !conn.open) return;
    const time = getCurrentTime();
    conn.send({ type: 'chat', text: emoji, time });
    appendMessage(emoji, 'sent', time);
}

// Universal File Sender (Photos, Videos, PDFs, ZIPs, Docs)
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !conn || !conn.open) return;

    const time = getCurrentTime();
    const mimeType = file.type || 'application/octet-stream';
    const arrayBuffer = await file.arrayBuffer();

    conn.send({
        type: 'file-meta',
        name: file.name,
        size: arrayBuffer.byteLength,
        mime: mimeType,
        time
    });

    let offset = 0;
    while (offset < arrayBuffer.byteLength) {
        const chunk = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
        conn.send(chunk);
        offset += CHUNK_SIZE;

        const pct = Math.min(100, Math.round((offset / arrayBuffer.byteLength) * 100));
        updateProgress(true, `Sending ${file.name}... ${pct}%`, pct);
        await new Promise(r => setTimeout(r, 4));
    }

    updateProgress(false);
    const localBlobUrl = URL.createObjectURL(file);
    appendUniversalFile(localBlobUrl, file.name, mimeType, arrayBuffer.byteLength, 'sent', time);
    e.target.value = '';
});

function appendMessage(text, side, time) {
    const container = document.getElementById('messagesContainer');
    const bubble = document.createElement('div');
    bubble.className = `msg-bubble msg-${side}`;

    const textDiv = document.createElement('div');
    textDiv.textContent = text;

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = `<span>${time}</span> ${side === 'sent' ? '<span>✓✓</span>' : ''}`;

    bubble.appendChild(textDiv);
    bubble.appendChild(meta);
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
}

// Render Photo, Video, or Document Card
function appendUniversalFile(blobUrl, fileName, mimeType, byteSize, side, time) {
    const container = document.getElementById('messagesContainer');
    const bubble = document.createElement('div');
    bubble.className = `msg-bubble msg-${side}`;

    const badge = document.createElement('div');
    badge.className = 'hd-badge';

    if (mimeType.startsWith('image/')) {
        badge.textContent = `💎 ORIGINAL HD PHOTO • ${formatFileSize(byteSize)}`;
        bubble.appendChild(badge);

        const img = document.createElement('img');
        img.src = blobUrl;
        img.className = 'msg-img';
        img.onclick = () => openModal(blobUrl);
        bubble.appendChild(img);

    } else if (mimeType.startsWith('video/')) {
        badge.textContent = `🎬 ORIGINAL HD VIDEO • ${formatFileSize(byteSize)}`;
        bubble.appendChild(badge);

        const video = document.createElement('video');
        video.src = blobUrl;
        video.controls = true;
        video.className = 'msg-img';
        bubble.appendChild(video);

    } else {
        badge.textContent = `📄 DOCUMENT / FILE • ${formatFileSize(byteSize)}`;
        bubble.appendChild(badge);

        const docTitle = document.createElement('div');
        docTitle.style.fontWeight = '700';
        docTitle.style.marginBottom = '6px';
        docTitle.textContent = `📁 ${fileName}`;
        bubble.appendChild(docTitle);
    }

    const dlBtn = document.createElement('a');
    dlBtn.href = blobUrl;
    dlBtn.download = fileName || 'QuickChat_File';
    dlBtn.className = 'download-hd-btn';
    dlBtn.textContent = `⬇ Download Original (${formatFileSize(byteSize)})`;
    bubble.appendChild(dlBtn);

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = `<span>${time}</span> ${side === 'sent' ? '<span>✓✓</span>' : ''}`;
    bubble.appendChild(meta);

    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
}

function openModal(src) {
    document.getElementById('modalImg').src = src;
    document.getElementById('imageModal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('imageModal').classList.add('hidden');
}

document.getElementById('msgInput').addEventListener('input', () => {
    if (!conn || !conn.open) return;
    conn.send({ type: 'typing', isTyping: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        conn.send({ type: 'typing', isTyping: false });
    }, 1200);
});

document.getElementById('msgInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});
document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('leaveBtn').addEventListener('click', () => location.reload());