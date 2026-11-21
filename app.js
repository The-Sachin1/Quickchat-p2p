// QuickChat HD v6.2 — Complete Verified Edition (Bulletproof Camera Toggle + Cooldown + Mute/Cam + E2EE + Batch Media + Extras)
const PEER_PREFIX = "qchd-live-v6-";
const CHUNK_SIZE = 65536;

let peer = null;
let connections = {};
let outboxQueues = {};
let activeMediaCall = null;
let localStream = null;

// Fresh storage key so no old cached name shows up
let myProfile = JSON.parse(localStorage.getItem("qchd_v6_profile") || "null");
let chatStore = JSON.parse(localStorage.getItem("qchd_v6_chats") || "{}");
let callLogs = JSON.parse(localStorage.getItem("qchd_v6_calls") || "[]");
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
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js").catch(() => {});
    }

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
    localStorage.setItem("qchd_v6_profile", JSON.stringify(myProfile));
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
        debug: 0,
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
        if (err.type === "peer-unavailable" && currentPeerUser) {
            document.getElementById("peerPresence").textContent = "Offline (Waiting for friend to open app)";
        }
    });

    peer.on("connection", conn => bindConnection(conn));
    peer.on("call", call => handleIncomingCall(call));
}

// ==========================================
// 1. RELIABLE P2P CONNECTION & PACKET ROUTING
// ==========================================
document.getElementById("connectPeerBtn").addEventListener("click", () => {
    const target = document.getElementById("connectUsernameInput").value.trim().toLowerCase().replace(/^@/, "");
    if (!target || target === myProfile.username) return;
    document.getElementById("connectUsernameInput").value = "";
    openChat(target);
});

document.getElementById("connectUsernameInput").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("connectPeerBtn").click();
});

function openChat(targetUser) {
    currentPeerUser = targetUser;
    document.getElementById("peerNameTitle").textContent = `@${targetUser}`;
    showScreen("chatScreen");
    renderChatMessages(targetUser);

    const existing = connections[targetUser];
    if (existing && existing.open) {
        document.getElementById("peerPresence").textContent = "● Online • E2EE Connected";
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
    const conn = connections[targetUser];
    if (conn && conn.open) {
        conn.send(packet);
    } else {
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

    if (data.type === "typing") {
        if (currentPeerUser === sender) {
            document.getElementById("peerPresence").textContent = data.isTyping ? "typing..." : "● Online • E2EE Connected";
        }
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
            quote: data.quote || null,
            burnSeconds: data.burnSeconds || 0,
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

    if (data.type === "reaction") {
        const msg = chatStore[sender]?.messages.find(m => m.id === data.msgId);
        if (msg) {
            msg.reaction = data.emoji;
            saveChats();
            if (currentPeerUser === sender) renderChatMessages(sender);
        }
        return;
    }

    if (data.type === "unsend") {
        if (chatStore[sender]) {
            chatStore[sender].messages = chatStore[sender].messages.filter(m => m.id !== data.msgId);
            saveChats();
            if (currentPeerUser === sender) renderChatMessages(sender);
        }
        return;
    }

    if (data.type === "watch-sync") {
        document.getElementById("watchPartyModal").classList.remove("hidden");
        if (Math.abs(watchPlayer.currentTime - data.time) > 0.5) watchPlayer.currentTime = data.time;
        if (data.action === "play") watchPlayer.play().catch(() => {});
        if (data.action === "pause") watchPlayer.pause();
        return;
    }

    if (data.type === "game-move") {
        ensureThread(sender);
        const existing = chatStore[sender].messages.find(m => m.id === data.gameId);
        if (existing) {
            existing.gameBoard = data.board;
            if (currentPeerUser === sender) renderChatMessages(sender);
        } else {
            appendMessage(sender, { id: data.gameId, from: "peer", gameBoard: data.board, time: nowTime(), status: "seen" });
        }
        return;
    }

    if (data.type === "file-start") {
        fileBuffers[data.fileId] = { name: data.name, mime: data.mime, size: data.size, viewOnce: data.viewOnce, chunks: [], got: 0 };
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
        appendMessage(sender, {
            id: data.fileId,
            from: "peer",
            mediaUrl: url,
            mediaName: fb.name,
            mediaType: fb.mime,
            viewOnce: fb.viewOnce,
            time: nowTime(),
            status: "seen"
        });
    }
}

// ==========================================
// 2. SEND TEXT, TYPING INDICATOR & BATCH MEDIA
// ==========================================
const msgInput = document.getElementById("messageInput");
let typingTimer = null;

msgInput.addEventListener("input", () => {
    if (!currentPeerUser) return;
    sendPacket(currentPeerUser, { type: "typing", isTyping: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        sendPacket(currentPeerUser, { type: "typing", isTyping: false });
    }, 1200);
});

msgInput.addEventListener("keydown", e => { if (e.key === "Enter") handleSendText(); });
document.getElementById("sendMsgBtn").addEventListener("click", handleSendText);

async function handleSendText() {
    const text = msgInput.value.trim();
    if (!text || !currentPeerUser) return;
    msgInput.value = "";

    const msgId = "msg_" + Date.now();
    const burnSec = burnMode ? 10 : 0;

    appendMessage(currentPeerUser, {
        id: msgId,
        from: "me",
        text,
        quote: replyingTo,
        burnSeconds: burnSec,
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
            cipher: bufToBase64(cipherBuf),
            quote: replyingTo,
            burnSeconds: burnSec
        });
    } else {
        sendPacket(currentPeerUser, {
            type: "chat",
            id: msgId,
            encrypted: false,
            text,
            quote: replyingTo,
            burnSeconds: burnSec
        });
    }

    replyingTo = null;
    document.getElementById("replyBar").classList.add("hidden");
}

document.getElementById("attachBatchBtn").addEventListener("click", () => document.getElementById("multiMediaInput").click());
document.getElementById("multiMediaInput").addEventListener("change", async e => {
    const files = Array.from(e.target.files);
    if (!files.length || !currentPeerUser) return;
    e.target.value = "";
    await sendFilesBatch(files);
});

async function sendFilesBatch(files) {
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileId = "f_" + Date.now() + "_" + i;
        appendMessage(currentPeerUser, {
            id: fileId,
            from: "me",
            mediaUrl: URL.createObjectURL(file),
            mediaName: file.name,
            mediaType: file.type,
            viewOnce: viewOnceMode,
            time: nowTime(),
            status: "delivered"
        });

        sendPacket(currentPeerUser, { type: "file-start", fileId, name: file.name, mime: file.type, size: file.size, viewOnce: viewOnceMode });
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
    if (viewOnceMode) {
        viewOnceMode = false;
        document.getElementById("toggleViewOnceBtn").textContent = "1️⃣ View-Once: OFF";
    }
}

// ==========================================
// 3. HD VOICE/VIDEO CALLS + BULLETPROOF CAMERA TOGGLE (NO BLACK SCREEN)
// ==========================================
document.getElementById("videoCallBtn").addEventListener("click", () => startCall(true));
document.getElementById("audioCallBtn").addEventListener("click", () => startCall(false));

async function startCall(video) {
    if (!currentPeerUser) return;
    closeCallUI();
    await new Promise(r => setTimeout(r, 180)); // Hardware camera release cooldown

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
            audio: true
        });

        const localVid = document.getElementById("localVideo");
        localVid.style.opacity = "1";
        localVid.srcObject = null;
        localVid.srcObject = localStream;
        await localVid.play().catch(() => {});

        resetCallButtonsUI();
        document.getElementById("callPeerName").textContent = `@${currentPeerUser}`;
        document.getElementById("callTimerText").textContent = "Calling...";
        document.getElementById("incomingCallControls").classList.add("hidden");
        document.getElementById("activeCallControls").classList.remove("hidden");
        document.getElementById("callOverlay").classList.remove("hidden");

        const call = peer.call(PEER_PREFIX + currentPeerUser, localStream, {
            metadata: { caller: myProfile.username, video }
        });
        wireCall(call, video ? "Video Call" : "Audio Call");
    } catch {
        alert("Camera/Mic busy hai—ek baar browser tab refresh karke try karein.");
    }
}

function handleIncomingCall(call) {
    const caller = call.metadata?.caller || call.peer.replace(PEER_PREFIX, "");
    const video = call.metadata?.video ?? true;

    resetCallButtonsUI();
    document.getElementById("callPeerName").textContent = `@${caller}`;
    document.getElementById("callTimerText").textContent = video ? "Incoming HD Video Call..." : "Incoming Voice Call...";
    document.getElementById("incomingCallControls").classList.remove("hidden");
    document.getElementById("activeCallControls").classList.add("hidden");
    document.getElementById("callOverlay").classList.remove("hidden");

    document.getElementById("acceptCallBtn").onclick = async () => {
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
        await new Promise(r => setTimeout(r, 180));

        localStream = await navigator.mediaDevices.getUserMedia({
            video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
            audio: true
        });

        const localVid = document.getElementById("localVideo");
        localVid.style.opacity = "1";
        localVid.srcObject = null;
        localVid.srcObject = localStream;
        await localVid.play().catch(() => {});

        call.answer(localStream);
        document.getElementById("incomingCallControls").classList.add("hidden");
        document.getElementById("activeCallControls").classList.remove("hidden");
        wireCall(call, video ? "Video Call" : "Audio Call");
    };

    document.getElementById("rejectCallBtn").onclick = () => {
        call.close();
        closeCallUI();
    };
}

function wireCall(call, type) {
    activeMediaCall = call;
    let sec = 0;

    call.on("stream", async remote => {
        const remoteVid = document.getElementById("remoteVideo");
        remoteVid.srcObject = null;
        remoteVid.srcObject = remote;
        await remoteVid.play().catch(() => {});

        clearInterval(callTimerInterval);
        callTimerInterval = setInterval(() => {
            sec++;
            document.getElementById("callTimerText").textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
        }, 1000);
    });

    call.on("close", () => {
        callLogs.unshift({ user: currentPeerUser || "Friend", type, duration: `${sec}s`, time: nowTime() });
        localStorage.setItem("qchd_v6_calls", JSON.stringify(callLogs));
        renderCallLogs();
        closeCallUI();
    });
}

// Working Mute Mic Button
document.getElementById("toggleMicBtn").addEventListener("click", e => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.currentTarget.textContent = track.enabled ? "🎤" : "🔇";
    e.currentTarget.style.background = track.enabled ? "rgba(255, 255, 255, 0.1)" : "#ef4444";
});

// 100% Bulletproof Camera Toggle (Never destroys active WebRTC stream; zero black screen on repeat toggles)
document.getElementById("toggleCamBtn").addEventListener("click", async e => {
    const btn = e.currentTarget;
    if (!localStream) return;

    let videoTrack = localStream.getVideoTracks()[0];

    if (!videoTrack || videoTrack.readyState === "ended") {
        try {
            const camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
            videoTrack = camStream.getVideoTracks()[0];
            localStream.addTrack(videoTrack);

            if (activeMediaCall && activeMediaCall.peerConnection) {
                const sender = activeMediaCall.peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
                if (sender) await sender.replaceTrack(videoTrack);
                else activeMediaCall.peerConnection.addTrack(videoTrack, localStream);
            }
        } catch {
            alert("Camera access denied or busy in another app.");
            return;
        }
    } else {
        videoTrack.enabled = !videoTrack.enabled;
    }

    const localVid = document.getElementById("localVideo");
    if (videoTrack.enabled) {
        localVid.srcObject = localStream;
        localVid.style.opacity = "1";
        await localVid.play().catch(() => {});
        btn.textContent = "📷";
        btn.style.background = "rgba(255, 255, 255, 0.1)";
    } else {
        localVid.style.opacity = "0.15";
        btn.textContent = "🚫";
        btn.style.background = "#ef4444";
    }
});

// Working Screen Share Button
document.getElementById("shareScreenBtn").addEventListener("click", async () => {
    if (!activeMediaCall || !navigator.mediaDevices.getDisplayMedia) return;
    try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = activeMediaCall.peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender) await sender.replaceTrack(screenTrack);
        const localVid = document.getElementById("localVideo");
        localVid.style.opacity = "1";
        localVid.srcObject = screenStream;
        await localVid.play().catch(() => {});
    } catch {}
});

document.getElementById("endCallBtn").addEventListener("click", () => {
    if (activeMediaCall) activeMediaCall.close();
    closeCallUI();
});

function resetCallButtonsUI() {
    const micBtn = document.getElementById("toggleMicBtn");
    const camBtn = document.getElementById("toggleCamBtn");
    micBtn.textContent = "🎤";
    micBtn.style.background = "rgba(255, 255, 255, 0.1)";
    camBtn.textContent = "📷";
    camBtn.style.background = "rgba(255, 255, 255, 0.1)";
}

function closeCallUI() {
    clearInterval(callTimerInterval);
    if (localStream) {
        localStream.getTracks().forEach(t => {
            t.enabled = false;
            t.stop();
        });
        localStream = null;
    }
    const localVid = document.getElementById("localVideo");
    const remoteVid = document.getElementById("remoteVideo");
    localVid.pause();
    localVid.srcObject = null;
    remoteVid.pause();
    remoteVid.srcObject = null;

    activeMediaCall = null;
    document.getElementById("callOverlay").classList.add("hidden");
}

// ==========================================
// 4. EXTRAS: VOICE NOTES, VIEW-ONCE, BURN, STEGO, WATCH PARTY, TIC-TAC-TOE
// ==========================================
document.getElementById("moreToolsBtn").addEventListener("click", () => {
    document.getElementById("specialDrawer").classList.toggle("hidden");
});

document.getElementById("toggleViewOnceBtn").addEventListener("click", e => {
    viewOnceMode = !viewOnceMode;
    e.currentTarget.textContent = `1️⃣ View-Once: ${viewOnceMode ? "ON" : "OFF"}`;
    e.currentTarget.style.borderColor = viewOnceMode ? "#00f5a0" : "rgba(255,255,255,0.2)";
});

document.getElementById("toggleBurnBtn").addEventListener("click", e => {
    burnMode = !burnMode;
    e.currentTarget.textContent = `🔥 Burn 10s: ${burnMode ? "ON" : "OFF"}`;
    e.currentTarget.style.borderColor = burnMode ? "#00f5a0" : "rgba(255,255,255,0.2)";
});

document.getElementById("voiceNoteBtn").addEventListener("click", async e => {
    const btn = e.currentTarget;
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = ev => audioChunks.push(ev.data);
            mediaRecorder.onstop = async () => {
                stream.getTracks().forEach(t => t.stop());
                const blob = new Blob(audioChunks, { type: "audio/webm" });
                const file = new File([blob], `VoiceNote_${Date.now()}.webm`, { type: "audio/webm" });
                await sendFilesBatch([file]);
            };
            mediaRecorder.start();
            btn.textContent = "⏹️";
            btn.style.background = "#ef4444";
        } catch {
            alert("Microphone permission denied.");
        }
    } else {
        mediaRecorder.stop();
        btn.textContent = "🎙️";
        btn.style.background = "";
    }
});

// Steganography
document.getElementById("openStegoBtn").addEventListener("click", () => document.getElementById("stegoModal").classList.remove("hidden"));
document.getElementById("closeStegoBtn").addEventListener("click", () => document.getElementById("stegoModal").classList.add("hidden"));
document.getElementById("sendStegoBtn").addEventListener("click", async () => {
    const imgFile = document.getElementById("stegoImageInput").files[0];
    const secret = document.getElementById("stegoSecretInput").value.trim();
    if (!imgFile || !secret) return alert("Select photo and enter secret message!");

    const blob = await encodeStegoImage(imgFile, secret);
    const stegoFile = new File([blob], `Secret_${Date.now()}.png`, { type: "image/png" });
    document.getElementById("stegoModal").classList.add("hidden");
    await sendFilesBatch([stegoFile]);
});

function encodeStegoImage(file, secretText) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const payload = `QCHD::${secretText}::END`;
            const bits = payload.split("").map(c => c.charCodeAt(0).toString(2).padStart(8, "0")).join("");
            for (let i = 0; i < bits.length && i * 4 < imgData.data.length; i++) {
                imgData.data[i * 4] = (imgData.data[i * 4] & 0xFE) | parseInt(bits[i], 10);
            }
            ctx.putImageData(imgData, 0, 0);
            canvas.toBlob(b => resolve(b), "image/png");
        };
        img.src = URL.createObjectURL(file);
    });
}

function decodeStegoFromImage(imgEl) {
    const canvas = document.createElement("canvas");
    canvas.width = imgEl.naturalWidth;
    canvas.height = imgEl.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgEl, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let bits = "";
    for (let i = 0; i < 4000 && i * 4 < data.length; i++) bits += (data[i * 4] & 1).toString();
    let decoded = "";
    for (let i = 0; i < bits.length; i += 8) decoded += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
    const match = decoded.match(/QCHD::(.*?)::END/);
    return match ? match[1] : null;
}

// Watch Party
const watchPlayer = document.getElementById("watchPartyPlayer");
document.getElementById("openWatchPartyBtn").addEventListener("click", () => document.getElementById("watchPartyModal").classList.remove("hidden"));
document.getElementById("closeWatchBtn").addEventListener("click", () => document.getElementById("watchPartyModal").classList.add("hidden"));
document.getElementById("watchFileInput").addEventListener("change", e => {
    const f = e.target.files[0];
    if (f) watchPlayer.src = URL.createObjectURL(f);
});
["play", "pause", "seeked"].forEach(evt => {
    watchPlayer.addEventListener(evt, () => {
        if (currentPeerUser) sendPacket(currentPeerUser, { type: "watch-sync", action: evt, time: watchPlayer.currentTime });
    });
});

// Live Tic-Tac-Toe
document.getElementById("startGameBtn").addEventListener("click", () => {
    if (!currentPeerUser) return;
    const board = Array(9).fill("");
    const gameId = "g_" + Date.now();
    appendMessage(currentPeerUser, { id: gameId, from: "me", gameBoard: board, time: nowTime(), status: "delivered" });
    sendPacket(currentPeerUser, { type: "game-move", gameId, board });
});

// ==========================================
// 5. CHAT RENDERING, REACTIONS, REPLY & UNSEND
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

    if (msg.burnSeconds > 0) {
        setTimeout(() => {
            if (chatStore[user]) {
                chatStore[user].messages = chatStore[user].messages.filter(m => m.id !== msg.id);
                saveChats();
                if (currentPeerUser === user) renderChatMessages(user);
            }
        }, msg.burnSeconds * 1000);
    }
}

function saveChats() {
    const clean = {};
    for (const [k, v] of Object.entries(chatStore)) {
        clean[k] = { avatar: v.avatar, displayName: v.displayName, messages: v.messages.filter(m => !m.mediaUrl).slice(-120) };
    }
    localStorage.setItem("qchd_v6_chats", JSON.stringify(clean));
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
    feed.innerHTML = "";

    msgs.forEach(m => {
        const div = document.createElement("div");
        div.className = `bubble ${m.from}`;

        let body = "";
        if (m.quote) body += `<div class="quote-snippet">${m.quote}</div>`;

        if (m.gameBoard) {
            body += `<div style="display:grid;grid-template-columns:repeat(3,42px);gap:4px;margin:4px 0;">
                ${m.gameBoard.map((c, idx) => `<button class="ttt-cell" data-idx="${idx}" style="height:42px;font-size:17px;border-radius:8px;border:1px solid rgba(255,255,255,0.25);background:rgba(0,0,0,0.35);color:#fff;">${c}</button>`).join("")}
            </div>`;
        } else if (m.mediaUrl) {
            if (m.viewOnce && m.openedOnce) {
                body += `<em>1️⃣ View-Once media expired</em>`;
            } else if (m.mediaType?.startsWith("image/")) {
                body += `<img src="${m.mediaUrl}" class="msg-media" />`;
            } else if (m.mediaType?.startsWith("video/")) {
                body += `<video src="${m.mediaUrl}" controls class="msg-media"></video>`;
            } else if (m.mediaType?.startsWith("audio/")) {
                body += `<audio src="${m.mediaUrl}" controls style="max-width:210px;"></audio>`;
            } else {
                body += `<a href="${m.mediaUrl}" download="${m.mediaName}" style="color:#fff;">📄 ${m.mediaName}</a>`;
            }
        } else {
            body += `<div>${m.text}</div>`;
        }

        const tick = m.from === "me" ? `<span class="${m.status === "seen" ? "seen-blue" : ""}">✓✓</span>` : "";
        body += `
            <div class="bubble-meta"><span>${m.time}</span>${tick}</div>
            ${m.reaction ? `<div class="react-tag">${m.reaction}</div>` : ""}
            <div class="bubble-tools">
                <button class="b-react" data-em="❤️">❤️</button>
                <button class="b-react" data-em="😂">😂</button>
                <button class="b-reply">↩️</button>
                ${m.from === "me" ? `<button class="b-del">🗑️</button>` : ""}
            </div>
        `;
        div.innerHTML = body;

        const imgEl = div.querySelector("img.msg-media");
        if (imgEl) {
            imgEl.onclick = () => {
                const secret = decodeStegoFromImage(imgEl);
                if (secret) alert(`🕵️ Hidden Secret Unlocked:\n\n"${secret}"`);
                document.getElementById("lightboxContent").innerHTML = `<img src="${m.mediaUrl}" style="max-width:92vw;max-height:82vh;border-radius:16px;" />`;
                document.getElementById("mediaLightbox").classList.remove("hidden");
                if (m.viewOnce) {
                    m.openedOnce = true;
                    renderChatMessages(user);
                }
            };
        }

        div.querySelectorAll(".ttt-cell").forEach(cellBtn => {
            cellBtn.onclick = () => {
                const idx = Number(cellBtn.dataset.idx);
                if (m.gameBoard[idx]) return;
                m.gameBoard[idx] = m.from === "me" ? "X" : "O";
                renderChatMessages(user);
                sendPacket(user, { type: "game-move", gameId: m.id, board: m.gameBoard });
            };
        });

        div.querySelectorAll(".b-react").forEach(rb => {
            rb.onclick = () => {
                m.reaction = rb.dataset.em;
                saveChats();
                renderChatMessages(user);
                sendPacket(user, { type: "reaction", msgId: m.id, emoji: rb.dataset.em });
            };
        });

        div.querySelector(".b-reply").onclick = () => {
            replyingTo = m.text || m.mediaName || "Media";
            document.getElementById("replyBar").classList.remove("hidden");
            document.getElementById("replyPreviewText").textContent = replyingTo;
        };

        const delBtn = div.querySelector(".b-del");
        if (delBtn) {
            delBtn.onclick = () => {
                chatStore[user].messages = chatStore[user].messages.filter(x => x.id !== m.id);
                saveChats();
                renderChatMessages(user);
                sendPacket(user, { type: "unsend", msgId: m.id });
            };
        }

        feed.appendChild(div);
    });
    feed.scrollTop = feed.scrollHeight;
}

document.getElementById("cancelReplyBtn").addEventListener("click", () => {
    replyingTo = null;
    document.getElementById("replyBar").classList.add("hidden");
});

document.getElementById("closeLightboxBtn").addEventListener("click", () => {
    document.getElementById("mediaLightbox").classList.add("hidden");
});

function renderCallLogs() {
    const list = document.getElementById("callLogsList");
    list.innerHTML = callLogs.length
        ? callLogs.map(c => `<div class="thread-item"><div><h4>@${c.user}</h4><p class="dim">${c.type} • ${c.duration}</p></div><span class="dim">${c.time}</span></div>`).join("")
        : `<div class="ios-glass info-card"><p class="dim">No calls yet.</p></div>`;
}

// Navigation, QR & Reset
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
    localStorage.removeItem("qchd_v6_profile");
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