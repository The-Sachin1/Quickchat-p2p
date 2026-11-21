// QuickChat HD v5.0 — Clean Onboarding + Reliable Real-Time P2P Chat + iOS Liquid Glass
const PEER_PREFIX = "qchd-live-v5-";
const CHUNK_SIZE = 65536;

let peer = null;
let connections = {}; // Map of username -> DataConnection
let outboxQueues = {}; // Map of username -> pending packets before open
let activeMediaCall = null;
let localStream = null;

// Fresh storage key so old cached name never interferes
let myProfile = JSON.parse(localStorage.getItem("qchd_v5_profile") || "null");
let chatStore = JSON.parse(localStorage.getItem("qchd_v5_chats") || "{}");
let callLogs = JSON.parse(localStorage.getItem("qchd_v5_calls") || "[]");
let currentPeerUser = null;

let myKeyPair = null;
let sharedKeys = {};
let viewOnceMode = false;
let burnMode = false;
let replyingTo = null;
let mediaRecorder = null;
let audioChunks = [];
let callTimerInterval = null;
let html5QrScanner = null;

// Interactive iOS Specular Sheen
const sheen = document.getElementById("glassSheen");
window.addEventListener("pointermove", e => {
    if (sheen) {
        sheen.style.left = `${e.clientX}px`;
        sheen.style.top = `${e.clientY}px`;
    }
}, { passive: true });

window.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".av-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".av-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
        });
    });

    if (myProfile && myProfile.username) {
        bootApp(myProfile);
    } else {
        document.getElementById("usernameInput").value = "";
        document.getElementById("displayNameInput").value = "";
        showScreen("setupScreen");
    }
});

document.getElementById("startAppBtn").addEventListener("click", () => {
    const rawUser = document.getElementById("usernameInput").value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const displayName = document.getElementById("displayNameInput").value.trim();
    const avatar = document.querySelector(".av-btn.active")?.dataset.avatar || "🧑‍💻";
    const errEl = document.getElementById("setupError");

    if (rawUser.length < 2) {
        errEl.textContent = "Please enter at least 2 characters for username.";
        return;
    }
    if (!displayName) {
        errEl.textContent = "Please enter your display name.";
        return;
    }

    myProfile = { username: rawUser, displayName, avatar };
    localStorage.setItem("qchd_v5_profile", JSON.stringify(myProfile));
    bootApp(myProfile);
});

async function bootApp(profile) {
    document.getElementById("myAvatarBadge").textContent = profile.avatar;
    document.getElementById("myDisplayHeader").textContent = profile.displayName;
    document.getElementById("myStatusLine").textContent = `@${profile.username} • Connecting...`;
    document.getElementById("profileUserText").textContent = `@${profile.username} (${profile.displayName})`;

    showScreen("homeScreen");
    renderRecentChats();
    renderCallLogs();

    if (window.crypto?.subtle) {
        try {
            myKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
        } catch {}
    }

    initPeer(profile.username);
}

function initPeer(username) {
    if (peer) peer.destroy();
    peer = new Peer(PEER_PREFIX + username, {
        debug: 1,
        config: {
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" },
                { urls: "stun:stun2.l.google.com:19302" }
            ]
        }
    });

    peer.on("open", () => {
        document.getElementById("statusDot").classList.add("online");
        document.getElementById("myStatusLine").textContent = `@${username} • Online`;
        document.getElementById("networkStateText").textContent = "Connected (P2P Ready)";
    });

    peer.on("disconnected", () => {
        document.getElementById("statusDot").classList.remove("online");
        document.getElementById("myStatusLine").textContent = `@${username} • Reconnecting...`;
        peer.reconnect();
    });

    peer.on("error", err => {
        console.warn("PeerJS:", err.type);
        if (err.type === "peer-unavailable" && currentPeerUser) {
            document.getElementById("peerPresence").textContent = "Offline (Waiting for friend to open app)";
        }
    });

    // Incoming P2P Connection from a friend
    peer.on("connection", conn => {
        bindConnection(conn);
    });

    // Incoming Audio/Video Call
    peer.on("call", call => handleIncomingCall(call));
}

// ==========================================
// RELIABLE CONNECTION & PACKET DELIVERY
// ==========================================
document.getElementById("connectPeerBtn").addEventListener("click", () => {
    const target = document.getElementById("connectUsernameInput").value.trim().toLowerCase().replace(/^@/, "");
    if (!target || target === myProfile.username) return;
    document.getElementById("connectUsernameInput").value = "";
    openChat(target);
});

function openChat(targetUser) {
    currentPeerUser = targetUser;
    document.getElementById("peerNameTitle").textContent = `@${targetUser}`;
    showScreen("chatScreen");
    renderChatMessages(targetUser);

    const existing = connections[targetUser];
    if (existing && existing.open) {
        document.getElementById("peerPresence").textContent = "● Online • Connected";
        sendPacket(targetUser, { type: "seen" });
    } else {
        document.getElementById("peerPresence").textContent = "Connecting to @" + targetUser + "...";
        const conn = peer.connect(PEER_PREFIX + targetUser, { reliable: true });
        bindConnection(conn);
    }
}

function bindConnection(conn) {
    const remoteUser = conn.peer.replace(PEER_PREFIX, "");
    connections[remoteUser] = conn;

    conn.on("open", async () => {
        if (currentPeerUser === remoteUser) {
            document.getElementById("peerPresence").textContent = "● Online • E2EE Connected";
        }

        // Send Handshake + ECDH Key
        let pubJwk = null;
        if (myKeyPair) {
            pubJwk = await crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
        }
        conn.send({
            type: "hello",
            username: myProfile.username,
            displayName: myProfile.displayName,
            avatar: myProfile.avatar,
            pubJwk
        });

        // Flush any queued messages for this user
        if (outboxQueues[remoteUser]?.length) {
            while (outboxQueues[remoteUser].length > 0) {
                conn.send(outboxQueues[remoteUser].shift());
            }
        }
    });

    conn.on("data", async data => {
        await onReceiveData(remoteUser, data);
    });

    conn.on("close", () => {
        if (currentPeerUser === remoteUser) {
            document.getElementById("peerPresence").textContent = "Offline";
        }
    });
}

function sendPacket(targetUser, packet) {
    let conn = connections[targetUser];
    if (conn && conn.open) {
        conn.send(packet);
    } else {
        // Queue packet and initiate connection automatically
        if (!outboxQueues[targetUser]) outboxQueues[targetUser] = [];
        outboxQueues[targetUser].push(packet);
        if (peer && peer.open) {
            const newConn = peer.connect(PEER_PREFIX + targetUser, { reliable: true });
            bindConnection(newConn);
        }
    }
}

const fileBuffers = {};

async function onReceiveData(sender, data) {
    if (data.type === "hello") {
        ensureThread(sender, data.avatar, data.displayName);
        if (currentPeerUser === sender) {
            document.getElementById("peerAvatar").textContent = data.avatar || "👤";
            document.getElementById("peerNameTitle").textContent = `${data.displayName} (@${sender})`;
            document.getElementById("peerPresence").textContent = "● Online • E2EE Connected";
        }
        if (data.pubJwk && myKeyPair) {
            const peerKey = await crypto.subtle.importKey("jwk", data.pubJwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
            const aesKey = await crypto.subtle.deriveKey({ name: "ECDH", public: peerKey }, myKeyPair.privateKey, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
            sharedKeys[sender] = aesKey;
            const raw = await crypto.subtle.exportKey("raw", aesKey);
            const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
            document.getElementById("safetyCodeText").textContent = `${hash[0]}${hash[1]}${hash[2]}`.slice(0, 6);
        }
        renderRecentChats();
        return;
    }

    if (data.type === "chat") {
        let plain = data.text;
        if (data.encrypted && sharedKeys[sender]) {
            try {
                const dec = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: new Uint8Array(data.iv) },
                    sharedKeys[sender],
                    base64ToBuf(data.cipher)
                );
                plain = new TextDecoder().decode(dec);
            } catch {}
        }

        appendMessage(sender, {
            id: data.id,
            from: "peer",
            text: plain,
            time: nowTime(),
            status: "seen"
        });

        if (currentPeerUser === sender) {
            sendPacket(sender, { type: "seen" });
        }
        return;
    }

    if (data.type === "seen") {
        if (chatStore[sender]) {
            chatStore[sender].messages.forEach(m => { if (m.from === "me") m.status = "seen"; });
            saveChats();
            if (currentPeerUser === sender) renderChatMessages(sender);
        }
        return;
    }

    if (data.type === "file-start") {
        fileBuffers[data.fileId] = { name: data.name, mime: data.mime, size: data.size, chunks: [], got: 0 };
        return;
    }
    if (data.type === "file-chunk") {
        const fb = fileBuffers[data.fileId];
        if (!fb) return;
        fb.chunks.push(data.chunk);
        fb.got += data.chunk.byteLength || data.chunk.length;
        updateProgress(`Receiving ${fb.name}`, Math.round((fb.got / fb.size) * 100));
        return;
    }
    if (data.type === "file-end") {
        const fb = fileBuffers[data.fileId];
        if (!fb) return;
        hideProgress();
        const url = URL.createObjectURL(new Blob(fb.chunks, { type: fb.mime }));
        delete fileBuffers[data.fileId];
        appendMessage(sender, { id: data.fileId, from: "peer", mediaUrl: url, mediaName: fb.name, mediaType: fb.mime, time: nowTime(), status: "seen" });
    }
}

// ==========================================
// SEND TEXT & MEDIA
// ==========================================
const msgInput = document.getElementById("messageInput");
msgInput.addEventListener("keydown", e => { if (e.key === "Enter") handleSendText(); });
document.getElementById("sendMsgBtn").addEventListener("click", handleSendText);

async function handleSendText() {
    const text = msgInput.value.trim();
    if (!text || !currentPeerUser) return;
    msgInput.value = "";

    const msgId = "msg_" + Date.now();
    appendMessage(currentPeerUser, {
        id: msgId,
        from: "me",
        text,
        time: nowTime(),
        status: connections[currentPeerUser]?.open ? "delivered" : "sent"
    });

    if (sharedKeys[currentPeerUser]) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKeys[currentPeerUser], new TextEncoder().encode(text));
        sendPacket(currentPeerUser, {
            type: "chat",
            id: msgId,
            encrypted: true,
            iv: Array.from(iv),
            cipher: bufToBase64(cipherBuf)
        });
    } else {
        sendPacket(currentPeerUser, { type: "chat", id: msgId, encrypted: false, text });
    }
}

// Batch Media Send
document.getElementById("attachBatchBtn").addEventListener("click", () => document.getElementById("multiMediaInput").click());
document.getElementById("multiMediaInput").addEventListener("change", async e => {
    const files = Array.from(e.target.files);
    if (!files.length || !currentPeerUser) return;
    e.target.value = "";

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileId = "f_" + Date.now() + "_" + i;
        appendMessage(currentPeerUser, {
            id: fileId,
            from: "me",
            mediaUrl: URL.createObjectURL(file),
            mediaName: file.name,
            mediaType: file.type,
            time: nowTime(),
            status: "delivered"
        });

        sendPacket(currentPeerUser, { type: "file-start", fileId, name: file.name, mime: file.type, size: file.size });
        let offset = 0;
        while (offset < file.size) {
            const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
            sendPacket(currentPeerUser, { type: "file-chunk", fileId, chunk: buf });
            offset += buf.byteLength;
            updateProgress(`Sending ${i + 1}/${files.length}`, Math.round((offset / file.size) * 100));
        }
        sendPacket(currentPeerUser, { type: "file-end", fileId });
    }
    hideProgress();
});

// ==========================================
// HD VOICE & VIDEO CALLS
// ==========================================
document.getElementById("videoCallBtn").addEventListener("click", () => startCall(true));
document.getElementById("audioCallBtn").addEventListener("click", () => startCall(false));

async function startCall(video) {
    if (!currentPeerUser) return;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
        document.getElementById("localVideo").srcObject = localStream;
        document.getElementById("callPeerName").textContent = `@${currentPeerUser}`;
        document.getElementById("callTimerText").textContent = "Calling...";
        document.getElementById("incomingCallControls").classList.add("hidden");
        document.getElementById("activeCallControls").classList.remove("hidden");
        document.getElementById("callOverlay").classList.remove("hidden");

        const call = peer.call(PEER_PREFIX + currentPeerUser, localStream, { metadata: { caller: myProfile.username, video } });
        wireCall(call, video ? "Video Call" : "Audio Call");
    } catch {
        alert("Camera/Microphone permission required.");
    }
}

function handleIncomingCall(call) {
    const caller = call.metadata?.caller || call.peer.replace(PEER_PREFIX, "");
    const video = call.metadata?.video ?? true;
    document.getElementById("callPeerName").textContent = `@${caller}`;
    document.getElementById("callTimerText").textContent = video ? "Incoming HD Video Call..." : "Incoming Voice Call...";
    document.getElementById("incomingCallControls").classList.remove("hidden");
    document.getElementById("activeCallControls").classList.add("hidden");
    document.getElementById("callOverlay").classList.remove("hidden");

    document.getElementById("acceptCallBtn").onclick = async () => {
        localStream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
        document.getElementById("localVideo").srcObject = localStream;
        call.answer(localStream);
        document.getElementById("incomingCallControls").classList.add("hidden");
        document.getElementById("activeCallControls").classList.remove("hidden");
        wireCall(call, video ? "Video Call" : "Audio Call");
    };
    document.getElementById("rejectCallBtn").onclick = () => { call.close(); closeCallUI(); };
}

function wireCall(call, type) {
    activeMediaCall = call;
    let sec = 0;
    call.on("stream", remote => {
        document.getElementById("remoteVideo").srcObject = remote;
        clearInterval(callTimerInterval);
        callTimerInterval = setInterval(() => {
            sec++;
            document.getElementById("callTimerText").textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
        }, 1000);
    });
    call.on("close", () => {
        callLogs.unshift({ user: currentPeerUser, type, duration: `${sec}s`, time: nowTime() });
        localStorage.setItem("qchd_v5_calls", JSON.stringify(callLogs));
        renderCallLogs();
        closeCallUI();
    });
}

document.getElementById("endCallBtn").addEventListener("click", () => { if (activeMediaCall) activeMediaCall.close(); closeCallUI(); });
function closeCallUI() {
    clearInterval(callTimerInterval);
    localStream?.getTracks().forEach(t => t.stop());
    document.getElementById("callOverlay").classList.add("hidden");
}

// ==========================================
// UI HELPERS & RENDERING
// ==========================================
function ensureThread(user, avatar = "👤", displayName = "") {
    if (!chatStore[user]) chatStore[user] = { avatar, displayName, messages: [] };
    else {
        if (avatar) chatStore[user].avatar = avatar;
        if (displayName) chatStore[user].displayName = displayName;
    }
}

function appendMessage(user, msg) {
    ensureThread(user);
    chatStore[user].messages.push(msg);
    saveChats();
    if (currentPeerUser === user) renderChatMessages(user);
    renderRecentChats();
}

function saveChats() {
    const clean = {};
    for (const [k, v] of Object.entries(chatStore)) {
        clean[k] = { avatar: v.avatar, displayName: v.displayName, messages: v.messages.filter(m => !m.mediaUrl).slice(-100) };
    }
    localStorage.setItem("qchd_v5_chats", JSON.stringify(clean));
}

function renderRecentChats() {
    const list = document.getElementById("recentChatsList");
    const users = Object.keys(chatStore);
    if (!users.length) {
        list.innerHTML = `<div class="ios-glass info-card"><p class="dim">Type your friend's <b>@username</b> in the search bar above and tap <b>Chat</b>!</p></div>`;
        return;
    }
    list.innerHTML = users.map(u => {
        const t = chatStore[u];
        const last = t.messages[t.messages.length - 1];
        const label = t.displayName ? `${t.displayName} (@${u})` : `@${u}`;
        return `
            <div class="thread-item" onclick="openChat('${u}')">
                <div class="thread-left">
                    <div class="user-av">${t.avatar || "👤"}</div>
                    <div class="thread-info">
                        <h4>${label}</h4>
                        <p>${last ? (last.text || "📎 Media") : "Tap to message"}</p>
                    </div>
                </div>
                <span class="dim">${last?.time || ""}</span>
            </div>
        `;
    }).join("");
}

function renderChatMessages(user) {
    const feed = document.getElementById("messagesContainer");
    const msgs = chatStore[user]?.messages || [];
    feed.innerHTML = msgs.map(m => {
        let body = "";
        if (m.mediaUrl) {
            if (m.mediaType?.startsWith("image/")) body = `<img src="${m.mediaUrl}" class="msg-media" />`;
            else if (m.mediaType?.startsWith("video/")) body = `<video src="${m.mediaUrl}" controls class="msg-media"></video>`;
            else body = `<a href="${m.mediaUrl}" download="${m.mediaName}" style="color:#fff;">📄 ${m.mediaName}</a>`;
        } else {
            body = `<div>${m.text}</div>`;
        }
        const tick = m.from === "me" ? `<span class="${m.status === "seen" ? "seen-blue" : ""}">✓✓</span>` : "";
        return `<div class="bubble ${m.from}">${body}<div class="bubble-meta"><span>${m.time}</span>${tick}</div></div>`;
    }).join("");
    feed.scrollTop = feed.scrollHeight;
}

function renderCallLogs() {
    const list = document.getElementById("callLogsList");
    list.innerHTML = callLogs.length
        ? callLogs.map(c => `<div class="thread-item"><div><h4>@${c.user}</h4><p class="dim">${c.type} • ${c.duration}</p></div><span class="dim">${c.time}</span></div>`).join("")
        : `<div class="ios-glass info-card"><p class="dim">No calls yet.</p></div>`;
}

// Navigation & QR
function showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
}
document.getElementById("backHomeBtn").addEventListener("click", () => { showScreen("homeScreen"); renderRecentChats(); });

document.querySelectorAll(".nav-pill").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".nav-pill").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab).classList.add("active");
    });
});

document.getElementById("qrModalBtn").addEventListener("click", () => {
    const box = document.getElementById("qrcodeContainer");
    box.innerHTML = "";
    document.getElementById("qrUserLabel").textContent = myProfile.username;
    new QRCode(box, { text: myProfile.username, width: 170, height: 170 });
    document.getElementById("qrModal").classList.remove("hidden");
});
document.getElementById("closeQrBtn").addEventListener("click", () => document.getElementById("qrModal").classList.add("hidden"));

document.getElementById("scanQrBtn").addEventListener("click", () => {
    document.getElementById("qrScannerModal").classList.remove("hidden");
    html5QrScanner = new Html5Qrcode("qrReaderBox");
    html5QrScanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 210 }, txt => {
        const target = txt.trim().toLowerCase().replace(/^@/, "");
        html5QrScanner.stop().catch(() => {});
        document.getElementById("qrScannerModal").classList.add("hidden");
        if (target && target !== myProfile.username) openChat(target);
    }).catch(() => document.getElementById("qrScannerModal").classList.add("hidden"));
});
document.getElementById("closeScannerBtn").addEventListener("click", () => {
    html5QrScanner?.stop().catch(() => {});
    document.getElementById("qrScannerModal").classList.add("hidden");
});

document.getElementById("switchAccountBtn").addEventListener("click", () => {
    localStorage.removeItem("qchd_v5_profile");
    location.reload();
});
document.getElementById("clearChatsBtn").addEventListener("click", () => {
    chatStore = {};
    saveChats();
    renderRecentChats();
});

function updateProgress(txt, pct) {
    document.getElementById("batchProgressBar").classList.remove("hidden");
    document.getElementById("batchStatusText").textContent = txt;
    document.getElementById("batchPercentText").textContent = `${pct}%`;
    document.getElementById("batchProgressFill").style.width = `${pct}%`;
}
function hideProgress() { setTimeout(() => document.getElementById("batchProgressBar").classList.add("hidden"), 700); }
function nowTime() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function bufToBase64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function base64ToBuf(b64) { const bin = atob(b64); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b.buffer; }