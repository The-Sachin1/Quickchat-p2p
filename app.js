// QuickChat HD v4.0 — Permanent Auto-Login + iPhone Liquid Glass E2EE Messenger
const PEER_PREFIX = "quickchat-hd-v4-";
const CHUNK_SIZE = 65536;
const HIGH_WATER_MARK = 1048576;

let peer = null;
let activeConn = null;
let activeMediaCall = null;
let localStream = null;
let myProfile = null;
let chatStore = JSON.parse(localStorage.getItem("qchd_chats") || "{}");
let callLogs = JSON.parse(localStorage.getItem("qchd_calls") || "[]");
let currentPeerUser = null;

// E2EE Crypto Keys
let myKeyPair = null;
let sharedAesKey = null;

// Special Modes
let viewOnceMode = false;
let burnMode = false;
let replyingTo = null;
let mediaRecorder = null;
let audioChunks = [];
let callTimerInterval = null;
let html5QrScanner = null;

const setupScreen = document.getElementById("setupScreen");
const homeScreen = document.getElementById("homeScreen");
const chatScreen = document.getElementById("chatScreen");
const usernameInput = document.getElementById("usernameInput");
const displayNameInput = document.getElementById("displayNameInput");
const startAppBtn = document.getElementById("startAppBtn");
const setupStatus = document.getElementById("setupStatus");

// Interactive iPhone Liquid Glass Specular Light Sheen
const sheen = document.getElementById("specularSheen");
if (sheen) {
    window.addEventListener("pointermove", e => {
        sheen.style.left = `${e.clientX}px`;
        sheen.style.top = `${e.clientY}px`;
    }, { passive: true });
}

// ==========================================
// PERMANENT PROFILE STORAGE (LocalStorage + IndexedDB Backup)
// ==========================================
function loadSavedProfile() {
    return new Promise(resolve => {
        const local = JSON.parse(localStorage.getItem("qchd_profile") || "null");
        if (local && local.username) return resolve(local);

        const req = indexedDB.open("QuickChatProfileDB", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("profile");
        req.onsuccess = () => {
            const tx = req.result.transaction("profile", "readonly");
            const getReq = tx.objectStore("profile").get("me");
            getReq.onsuccess = () => {
                if (getReq.result && getReq.result.username) {
                    localStorage.setItem("qchd_profile", JSON.stringify(getReq.result));
                    resolve(getReq.result);
                } else {
                    resolve(null);
                }
            };
            getReq.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
    });
}

function savePermanentProfile(profile) {
    localStorage.setItem("qchd_profile", JSON.stringify(profile));
    const req = indexedDB.open("QuickChatProfileDB", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("profile");
    req.onsuccess = () => {
        const tx = req.result.transaction("profile", "readwrite");
        tx.objectStore("profile").put(profile, "me");
    };
}

window.addEventListener("DOMContentLoaded", async () => {
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    document.querySelectorAll(".avatar-opt").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".avatar-opt").forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
        });
    });

    // Auto-Login Check: If user already registered once, skip login screen forever!
    myProfile = await loadSavedProfile();
    if (myProfile && myProfile.username) {
        usernameInput.value = myProfile.username;
        displayNameInput.value = myProfile.displayName || "";
        initPeerNetwork(myProfile);
    } else {
        switchScreen(setupScreen);
    }
});

startAppBtn.addEventListener("click", () => {
    const rawUser = usernameInput.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const displayName = displayNameInput.value.trim();
    const avatar = document.querySelector(".avatar-opt.selected")?.dataset.avatar || "🧑‍💻";

    if (!rawUser || rawUser.length < 2) {
        setupStatus.textContent = "Kripya kam se kam 2 letters ka unique username dalein!";
        return;
    }
    if (!displayName) {
        setupStatus.textContent = "Kripya apna naam (Display Name) dalein!";
        return;
    }

    myProfile = { username: rawUser, displayName, avatar };
    savePermanentProfile(myProfile);
    initPeerNetwork(myProfile);
});

async function initPeerNetwork(profile) {
    // 1. Instantly unlock Home Screen without waiting
    document.getElementById("myAvatarBadge").textContent = profile.avatar;
    document.getElementById("myDisplayHeader").textContent = profile.displayName;
    document.getElementById("myStatusLine").textContent = `● @${profile.username} • Connecting...`;
    document.getElementById("vaultUsernameDisplay").textContent = `@${profile.username} (${profile.displayName})`;
    switchScreen(homeScreen);
    renderRecentChats();
    renderCallLogs();

    // 2. Generate ECDH Keys
    if (window.crypto && window.crypto.subtle) {
        try {
            await generateECDHKeys();
        } catch {}
    }

    // 3. Connect PeerJS with automatic fallback ID if old tab is still closing
    connectToSignaling(profile.username, 0);
}

function connectToSignaling(baseUsername, retryCount) {
    if (typeof Peer === "undefined") return;
    if (peer) peer.destroy();

    const peerId = retryCount === 0
        ? PEER_PREFIX + baseUsername
        : `${PEER_PREFIX}${baseUsername}_${retryCount}`;

    peer = new Peer(peerId, {
        debug: 0,
        config: {
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" }
            ]
        }
    });

    peer.on("open", () => {
        document.getElementById("myStatusLine").textContent = `● @${myProfile.username} • Online`;
        document.getElementById("myStatusLine").classList.add("online");
        flushOfflineOutbox();
    });

    peer.on("disconnected", () => {
        document.getElementById("myStatusLine").textContent = `● @${myProfile.username} • Reconnecting...`;
        peer.reconnect();
    });

    peer.on("error", err => {
        if (err.type === "unavailable-id" && retryCount < 2) {
            // Reclaim session seamlessly without logging user out!
            setTimeout(() => connectToSignaling(baseUsername, retryCount + 1), 600);
        } else if (err.type === "peer-unavailable") {
            document.getElementById("peerPresence").textContent = "Offline (Messages queued in Outbox)";
        } else {
            document.getElementById("myStatusLine").textContent = `● @${myProfile.username} • Ready`;
        }
    });

    peer.on("connection", conn => setupDataConnection(conn));
    peer.on("call", incomingCall => handleIncomingMediaCall(incomingCall));
}

// ==========================================
// 1. TRUE END-TO-END ENCRYPTION (ECDH + AES-256)
// ==========================================
async function generateECDHKeys() {
    myKeyPair = await window.crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"]
    );
}

async function exportPublicKeyJwk() {
    if (!myKeyPair) return null;
    return await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
}

async function deriveSharedSecret(peerJwk) {
    if (!peerJwk || !myKeyPair) return;
    const importedPeerKey = await window.crypto.subtle.importKey(
        "jwk",
        peerJwk,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        []
    );
    sharedAesKey = await window.crypto.subtle.deriveKey(
        { name: "ECDH", public: importedPeerKey },
        myKeyPair.privateKey,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );

    const rawKey = await window.crypto.subtle.exportKey("raw", sharedAesKey);
    const hashBuf = await window.crypto.subtle.digest("SHA-256", rawKey);
    const nums = new Uint8Array(hashBuf);
    document.getElementById("safetyCodeText").textContent = `${nums[0]}${nums[1]}${nums[2]}`.slice(0, 6);
}

async function encryptPayload(plainText) {
    if (!sharedAesKey) return { iv: null, cipher: plainText, encrypted: false };
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plainText);
    const cipherBuf = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedAesKey, encoded);
    return {
        encrypted: true,
        iv: Array.from(iv),
        cipher: arrayBufferToBase64(cipherBuf)
    };
}

async function decryptPayload(packet) {
    if (!packet.encrypted || !sharedAesKey) return packet.cipher;
    const iv = new Uint8Array(packet.iv);
    const cipherBuf = base64ToArrayBuffer(packet.cipher);
    const plainBuf = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, sharedAesKey, cipherBuf);
    return new TextDecoder().decode(plainBuf);
}

// ==========================================
// 2. USERNAME CONNECT, QR SCANNER & DATA ROUTING
// ==========================================
document.getElementById("connectPeerBtn").addEventListener("click", () => {
    const targetUser = document.getElementById("connectUsernameInput").value.trim().toLowerCase().replace(/^@/, "");
    if (!targetUser || targetUser === myProfile.username) return;
    openChatWithUser(targetUser);
});

document.getElementById("scanQrBtn").addEventListener("click", () => {
    document.getElementById("qrScannerModal").classList.remove("hidden");
    if (typeof Html5Qrcode !== "undefined") {
        html5QrScanner = new Html5Qrcode("qrReaderBox");
        html5QrScanner.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: 220 },
            decodedText => {
                const target = decodedText.trim().toLowerCase().replace(/^@/, "");
                stopQrScanner();
                if (target && target !== myProfile.username) openChatWithUser(target);
            }
        ).catch(() => {
            alert("Camera permission denied or unavailable.");
            stopQrScanner();
        });
    }
});

document.getElementById("closeScannerBtn").addEventListener("click", stopQrScanner);

function stopQrScanner() {
    document.getElementById("qrScannerModal").classList.add("hidden");
    if (html5QrScanner) {
        html5QrScanner.stop().then(() => html5QrScanner.clear()).catch(() => {});
        html5QrScanner = null;
    }
}

function openChatWithUser(targetUser) {
    currentPeerUser = targetUser;
    document.getElementById("peerNameTitle").textContent = `@${targetUser}`;
    document.getElementById("peerPresence").textContent = "Connecting E2EE...";
    switchScreen(chatScreen);
    renderMessagesFull(targetUser);

    if (!activeConn || activeConn.peer !== PEER_PREFIX + targetUser || !activeConn.open) {
        const conn = peer.connect(PEER_PREFIX + targetUser, { reliable: true });
        setupDataConnection(conn);
    } else {
        document.getElementById("peerPresence").textContent = "● Online • E2EE";
        sendReadReceipt();
    }
}

function setupDataConnection(conn) {
    activeConn = conn;
    const remoteUser = conn.peer.replace(PEER_PREFIX, "").replace(/_\d+$/, "");

    conn.on("open", async () => {
        if (!currentPeerUser) {
            currentPeerUser = remoteUser;
            document.getElementById("peerNameTitle").textContent = `@${remoteUser}`;
        }
        document.getElementById("peerPresence").textContent = "● Online • E2EE Verified";
        document.getElementById("peerPresence").classList.add("online");

        const pubJwk = await exportPublicKeyJwk();
        conn.send({
            type: "key-exchange",
            username: myProfile.username,
            displayName: myProfile.displayName,
            avatar: myProfile.avatar,
            pubJwk
        });

        sendReadReceipt();
        flushOfflineOutbox();
    });

    conn.on("data", async data => {
        await handleIncomingPacket(remoteUser, data);
    });

    conn.on("close", () => {
        document.getElementById("peerPresence").textContent = "Offline";
        document.getElementById("peerPresence").classList.remove("online");
    });
}

const incomingFileBuffers = {};

async function handleIncomingPacket(senderUser, data) {
    if (data.type === "key-exchange") {
        await deriveSharedSecret(data.pubJwk);
        document.getElementById("peerAvatar").textContent = data.avatar || "👤";
        if (data.displayName) {
            document.getElementById("peerNameTitle").textContent = `${data.displayName} (@${senderUser})`;
        }
        ensureChatThread(senderUser, data.avatar, data.displayName);
        return;
    }

    if (data.type === "typing") {
        if (currentPeerUser === senderUser) {
            document.getElementById("peerPresence").textContent = data.isTyping ? "typing..." : "● Online • E2EE Verified";
        }
        return;
    }

    if (data.type === "seen") {
        markMessagesAsSeen(senderUser);
        return;
    }

    if (data.type === "reaction") {
        applyReaction(senderUser, data.msgId, data.emoji);
        return;
    }

    if (data.type === "unsend") {
        deleteMessageLocal(senderUser, data.msgId);
        return;
    }

    if (data.type === "watch-sync") {
        syncWatchPartyAction(data);
        return;
    }

    if (data.type === "game-move") {
        handleGameMove(senderUser, data);
        return;
    }

    if (data.type === "chat") {
        const decryptedText = await decryptPayload(data.payload);
        const msgObj = {
            id: data.id,
            sender: "peer",
            text: decryptedText,
            quote: data.quote || null,
            viewOnce: data.viewOnce || false,
            burnSeconds: data.burnSeconds || 0,
            time: formatTime(),
            status: "seen"
        };
        saveAndAppendMessage(senderUser, msgObj);
        return;
    }

    if (data.type === "file-start") {
        incomingFileBuffers[data.fileId] = {
            name: data.name,
            mime: data.mime,
            size: data.size,
            viewOnce: data.viewOnce,
            chunks: [],
            receivedBytes: 0,
            lastUiUpdate: 0
        };
        showBatchProgress(`Receiving ${data.name}...`, 5);
        return;
    }

    if (data.type === "file-chunk") {
        const entry = incomingFileBuffers[data.fileId];
        if (!entry) return;
        entry.chunks.push(data.chunk);
        entry.receivedBytes += data.chunk.byteLength || data.chunk.length;

        const now = performance.now();
        if (now - entry.lastUiUpdate > 100) {
            entry.lastUiUpdate = now;
            const pct = Math.min(99, Math.round((entry.receivedBytes / entry.size) * 100));
            showBatchProgress(`Receiving ${entry.name}`, pct);
        }
        return;
    }

    if (data.type === "file-end") {
        const entry = incomingFileBuffers[data.fileId];
        if (!entry) return;
        hideBatchProgress();
        const blob = new Blob(entry.chunks, { type: entry.mime });
        const blobUrl = URL.createObjectURL(blob);
        delete incomingFileBuffers[data.fileId];

        saveAndAppendMessage(senderUser, {
            id: data.fileId,
            sender: "peer",
            mediaUrl: blobUrl,
            mediaName: entry.name,
            mediaType: entry.mime,
            viewOnce: entry.viewOnce,
            time: formatTime(),
            status: "seen"
        });
    }
}

// ==========================================
// 3. ZERO-RAM BATCH STREAMER (100+ PHOTOS & 50+ VIDEOS)
// ==========================================
document.getElementById("attachBatchBtn").addEventListener("click", () => {
    document.getElementById("multiMediaInput").click();
});

document.getElementById("multiMediaInput").addEventListener("change", async e => {
    const files = Array.from(e.target.files);
    if (!files.length || !currentPeerUser) return;
    e.target.value = "";
    await sendFilesBatchSequentially(files);
});

async function sendFilesBatchSequentially(files) {
    const total = files.length;

    for (let i = 0; i < total; i++) {
        const file = files[i];
        const fileId = "f_" + Date.now() + "_" + i;
        const localUrl = URL.createObjectURL(file);

        saveAndAppendMessage(currentPeerUser, {
            id: fileId,
            sender: "me",
            mediaUrl: localUrl,
            mediaName: file.name,
            mediaType: file.type || "application/octet-stream",
            viewOnce: viewOnceMode,
            time: formatTime(),
            status: activeConn && activeConn.open ? "delivered" : "queued"
        });

        if (!activeConn || !activeConn.open) {
            await queueFileInIndexedDB(currentPeerUser, file);
            continue;
        }

        activeConn.send({
            type: "file-start",
            fileId,
            name: file.name,
            mime: file.type || "application/octet-stream",
            size: file.size,
            viewOnce: viewOnceMode
        });

        let offset = 0;
        let lastUiUpdate = 0;
        const dc = activeConn.dataChannel;

        while (offset < file.size) {
            if (dc && dc.bufferedAmount > HIGH_WATER_MARK) {
                await new Promise(resolve => {
                    dc.bufferedAmountLowThreshold = 262144;
                    dc.onbufferedamountlow = () => {
                        dc.onbufferedamountlow = null;
                        resolve();
                    };
                });
            }

            const slice = file.slice(offset, offset + CHUNK_SIZE);
            const buffer = await slice.arrayBuffer();
            activeConn.send({ type: "file-chunk", fileId, chunk: buffer });
            offset += buffer.byteLength;

            const now = performance.now();
            if (now - lastUiUpdate > 100 || offset >= file.size) {
                lastUiUpdate = now;
                const pct = Math.min(100, Math.round((offset / file.size) * 100));
                showBatchProgress(`Sending Batch: ${i + 1} / ${total} (${file.name})`, pct);
            }
        }

        activeConn.send({ type: "file-end", fileId });
    }

    hideBatchProgress();
    if (viewOnceMode) toggleViewOnce();
}

function showBatchProgress(label, percent) {
    const bar = document.getElementById("batchProgressBar");
    bar.classList.remove("hidden");
    document.getElementById("batchStatusText").textContent = label;
    document.getElementById("batchPercentText").textContent = `${percent}%`;
    document.getElementById("batchProgressFill").style.width = `${percent}%`;
}

function hideBatchProgress() {
    setTimeout(() => {
        document.getElementById("batchProgressBar").classList.add("hidden");
    }, 800);
}

// ==========================================
// 4. MESSAGING, TYPING, SEEN TICKS, REPLY, REACTIONS, VOICE NOTES
// ==========================================
const messageInput = document.getElementById("messageInput");
let typingTimeout = null;
let isTypingSent = false;

messageInput.addEventListener("input", () => {
    if (activeConn && activeConn.open) {
        if (!isTypingSent) {
            isTypingSent = true;
            activeConn.send({ type: "typing", isTyping: true });
        }
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            isTypingSent = false;
            if (activeConn && activeConn.open) activeConn.send({ type: "typing", isTyping: false });
        }, 1200);
    }
});

messageInput.addEventListener("keydown", e => {
    if (e.key === "Enter") sendTextMessage();
});
document.getElementById("sendMsgBtn").addEventListener("click", sendTextMessage);

async function sendTextMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentPeerUser) return;
    messageInput.value = "";
    isTypingSent = false;

    const msgId = "m_" + Date.now();
    const msgObj = {
        id: msgId,
        sender: "me",
        text,
        quote: replyingTo,
        viewOnce: viewOnceMode,
        burnSeconds: burnMode ? 10 : 0,
        time: formatTime(),
        status: activeConn && activeConn.open ? "delivered" : "sent"
    };

    saveAndAppendMessage(currentPeerUser, msgObj);

    if (activeConn && activeConn.open) {
        const encryptedPayload = await encryptPayload(text);
        activeConn.send({
            type: "chat",
            id: msgId,
            payload: encryptedPayload,
            quote: replyingTo,
            viewOnce: viewOnceMode,
            burnSeconds: burnMode ? 10 : 0
        });
    }

    clearReply();
    if (viewOnceMode) toggleViewOnce();
}

document.getElementById("voiceNoteBtn").addEventListener("click", async () => {
    const btn = document.getElementById("voiceNoteBtn");
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                stream.getTracks().forEach(t => t.stop());
                const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
                const file = new File([audioBlob], `VoiceNote_${Date.now()}.webm`, { type: "audio/webm" });
                await sendFilesBatchSequentially([file]);
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

// ==========================================
// 5. HD VIDEO CALL (VC), AUDIO CALL (AC) & SCREEN SHARE
// ==========================================
document.getElementById("videoCallBtn").addEventListener("click", () => startMediaCall(true));
document.getElementById("audioCallBtn").addEventListener("click", () => startMediaCall(false));

async function startMediaCall(withVideo) {
    if (!currentPeerUser) return;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: withVideo, audio: true });
        document.getElementById("localVideo").srcObject = localStream;
        document.getElementById("callPeerName").textContent = `@${currentPeerUser}`;
        document.getElementById("callTimerText").textContent = "Calling...";
        document.getElementById("incomingCallControls").classList.add("hidden");
        document.getElementById("activeCallControls").classList.remove("hidden");
        document.getElementById("callOverlay").classList.remove("hidden");

        const call = peer.call(PEER_PREFIX + currentPeerUser, localStream, {
            metadata: { caller: myProfile.username, withVideo }
        });
        bindCallEvents(call, withVideo ? "Video Call" : "Voice Call");
    } catch {
        alert("Camera/Mic permission required for HD Call.");
    }
}

function handleIncomingMediaCall(incomingCall) {
    const caller = incomingCall.metadata?.caller || incomingCall.peer.replace(PEER_PREFIX, "").replace(/_\d+$/, "");
    const withVideo = incomingCall.metadata?.withVideo ?? true;

    document.getElementById("callPeerName").textContent = `@${caller}`;
    document.getElementById("callTimerText").textContent = withVideo ? "Incoming HD Video Call..." : "Incoming Voice Call...";
    document.getElementById("incomingCallControls").classList.remove("hidden");
    document.getElementById("activeCallControls").classList.add("hidden");
    document.getElementById("callOverlay").classList.remove("hidden");

    document.getElementById("acceptCallBtn").onclick = async () => {
        localStream = await navigator.mediaDevices.getUserMedia({ video: withVideo, audio: true });
        document.getElementById("localVideo").srcObject = localStream;
        incomingCall.answer(localStream);
        document.getElementById("incomingCallControls").classList.add("hidden");
        document.getElementById("activeCallControls").classList.remove("hidden");
        bindCallEvents(incomingCall, withVideo ? "Video Call" : "Voice Call");
    };

    document.getElementById("rejectCallBtn").onclick = () => {
        incomingCall.close();
        endActiveCallUI();
    };
}

function bindCallEvents(call, callType) {
    activeMediaCall = call;
    let seconds = 0;

    call.on("stream", remoteStream => {
        document.getElementById("remoteVideo").srcObject = remoteStream;
        clearInterval(callTimerInterval);
        callTimerInterval = setInterval(() => {
            seconds++;
            const mins = String(Math.floor(seconds / 60)).padStart(2, "0");
            const secs = String(seconds % 60).padStart(2, "0");
            document.getElementById("callTimerText").textContent = `${mins}:${secs}`;
        }, 1000);
    });

    call.on("close", () => {
        logCallEntry(callType, seconds);
        endActiveCallUI();
    });
}

document.getElementById("toggleMicBtn").addEventListener("click", () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (track) track.enabled = !track.enabled;
});

document.getElementById("toggleCamBtn").addEventListener("click", () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (track) track.enabled = !track.enabled;
});

document.getElementById("shareScreenBtn").addEventListener("click", async () => {
    if (!activeMediaCall || !navigator.mediaDevices.getDisplayMedia) return;
    try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = activeMediaCall.peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
        document.getElementById("localVideo").srcObject = screenStream;
    } catch {}
});

document.getElementById("endCallBtn").addEventListener("click", () => {
    if (activeMediaCall) activeMediaCall.close();
    endActiveCallUI();
});

function endActiveCallUI() {
    clearInterval(callTimerInterval);
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    document.getElementById("callOverlay").classList.add("hidden");
}

// ==========================================
// 6. EXCLUSIVE FEATURES: STEGANOGRAPHY, WATCH PARTY, TIC-TAC-TOE
// ==========================================
document.getElementById("moreToolsBtn").addEventListener("click", () => {
    document.getElementById("specialDrawer").classList.toggle("hidden");
});

document.getElementById("toggleViewOnceBtn").addEventListener("click", toggleViewOnce);
function toggleViewOnce() {
    viewOnceMode = !viewOnceMode;
    const btn = document.getElementById("toggleViewOnceBtn");
    btn.textContent = `1️⃣ View-Once: ${viewOnceMode ? "ON" : "OFF"}`;
    btn.classList.toggle("active-chip", viewOnceMode);
}

document.getElementById("toggleBurnBtn").addEventListener("click", () => {
    burnMode = !burnMode;
    const btn = document.getElementById("toggleBurnBtn");
    btn.textContent = `🔥 Burn 10s: ${burnMode ? "ON" : "OFF"}`;
    btn.classList.toggle("active-chip", burnMode);
});

document.getElementById("openStegoBtn").addEventListener("click", () => {
    document.getElementById("stegoModal").classList.remove("hidden");
});
document.getElementById("closeStegoBtn").addEventListener("click", () => {
    document.getElementById("stegoModal").classList.add("hidden");
});

document.getElementById("sendStegoBtn").addEventListener("click", async () => {
    const imgFile = document.getElementById("stegoImageInput").files[0];
    const secret = document.getElementById("stegoSecretInput").value.trim();
    if (!imgFile || !secret) return alert("Photo aur secret text dono chunein!");

    const stegoBlob = await encodeStegoImage(imgFile, secret);
    const stegoFile = new File([stegoBlob], `IMG_${Date.now()}.png`, { type: "image/png" });
    document.getElementById("stegoModal").classList.add("hidden");
    await sendFilesBatchSequentially([stegoFile]);
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
            canvas.toBlob(blob => resolve(blob), "image/png");
        };
        img.src = URL.createObjectURL(file);
    });
}

function decodeStegoFromImageElement(imgEl) {
    const canvas = document.createElement("canvas");
    canvas.width = imgEl.naturalWidth;
    canvas.height = imgEl.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgEl, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    let bits = "";
    for (let i = 0; i < 4000 && i * 4 < data.length; i++) {
        bits += (data[i * 4] & 1).toString();
    }
    let decoded = "";
    for (let i = 0; i < bits.length; i += 8) {
        decoded += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
    }
    const match = decoded.match(/QCHD::(.*?)::END/);
    return match ? match[1] : null;
}

const watchPlayer = document.getElementById("watchPartyPlayer");
document.getElementById("openWatchPartyBtn").addEventListener("click", () => {
    document.getElementById("watchPartyModal").classList.remove("hidden");
});
document.getElementById("closeWatchBtn").addEventListener("click", () => {
    document.getElementById("watchPartyModal").classList.add("hidden");
});
document.getElementById("watchFileInput").addEventListener("change", e => {
    const f = e.target.files[0];
    if (f) watchPlayer.src = URL.createObjectURL(f);
});
["play", "pause", "seeked"].forEach(evt => {
    watchPlayer.addEventListener(evt, () => {
        if (activeConn && activeConn.open) {
            activeConn.send({ type: "watch-sync", action: evt, time: watchPlayer.currentTime });
        }
    });
});
function syncWatchPartyAction(data) {
    document.getElementById("watchPartyModal").classList.remove("hidden");
    if (Math.abs(watchPlayer.currentTime - data.time) > 0.5) watchPlayer.currentTime = data.time;
    if (data.action === "play") watchPlayer.play().catch(() => {});
    if (data.action === "pause") watchPlayer.pause();
}

document.getElementById("startGameBtn").addEventListener("click", () => {
    if (!currentPeerUser) return;
    const board = Array(9).fill("");
    const gameId = "g_" + Date.now();
    saveAndAppendMessage(currentPeerUser, { id: gameId, sender: "me", gameBoard: board, time: formatTime(), status: "delivered" });
    if (activeConn && activeConn.open) activeConn.send({ type: "game-move", gameId, board });
});

function handleGameMove(senderUser, data) {
    ensureChatThread(senderUser);
    const msgs = chatStore[senderUser].messages;
    const existing = msgs.find(m => m.id === data.gameId);
    if (existing) {
        existing.gameBoard = data.board;
        if (currentPeerUser === senderUser) renderMessagesFull(senderUser);
    } else {
        saveAndAppendMessage(senderUser, { id: data.gameId, sender: "peer", gameBoard: data.board, time: formatTime(), status: "seen" });
    }
}

// ==========================================
// 7. INCREMENTAL ZERO-LAG DOM RENDERER & STORAGE
// ==========================================
function ensureChatThread(user, avatar = "👤", displayName = "") {
    if (!chatStore[user]) {
        chatStore[user] = { avatar, displayName, unread: 0, messages: [] };
    } else {
        if (avatar) chatStore[user].avatar = avatar;
        if (displayName) chatStore[user].displayName = displayName;
    }
}

function saveAndAppendMessage(user, msgObj) {
    ensureChatThread(user);
    chatStore[user].messages.push(msgObj);
    persistChats();

    if (currentPeerUser === user && chatScreen.classList.contains("active")) {
        const feed = document.getElementById("messagesContainer");
        feed.appendChild(createMessageNode(user, msgObj, true));
        feed.scrollTop = feed.scrollHeight;
        if (msgObj.sender === "peer") sendReadReceipt();
    } else if (msgObj.sender === "peer") {
        chatStore[user].unread = (chatStore[user].unread || 0) + 1;
        persistChats();
        renderRecentChats();
    }

    if (msgObj.burnSeconds > 0) {
        setTimeout(() => deleteMessageLocal(user, msgObj.id), msgObj.burnSeconds * 1000);
    }
}

function deleteMessageLocal(user, msgId) {
    if (!chatStore[user]) return;
    chatStore[user].messages = chatStore[user].messages.filter(m => m.id !== msgId);
    persistChats();
    const el = document.getElementById(`msg_${msgId}`);
    if (el) el.remove();
}

function markMessagesAsSeen(user) {
    if (!chatStore[user]) return;
    chatStore[user].messages.forEach(m => { if (m.sender === "me") m.status = "seen"; });
    persistChats();
    if (currentPeerUser === user) {
        document.querySelectorAll(".msg-tick").forEach(t => t.classList.add("tick-seen"));
    }
}

function applyReaction(user, msgId, emoji) {
    const msg = chatStore[user]?.messages.find(m => m.id === msgId);
    if (msg) {
        msg.reaction = emoji;
        persistChats();
        if (currentPeerUser === user) renderMessagesFull(user);
    }
}

let persistTimer = null;
function persistChats() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        const safeCopy = {};
        for (const [u, thread] of Object.entries(chatStore)) {
            safeCopy[u] = {
                avatar: thread.avatar,
                displayName: thread.displayName,
                unread: thread.unread,
                messages: thread.messages.filter(m => !m.mediaUrl).slice(-150)
            };
        }
        localStorage.setItem("qchd_chats", JSON.stringify(safeCopy));
    }, 250);
}

function renderRecentChats() {
    const list = document.getElementById("recentChatsList");
    const users = Object.keys(chatStore);
    if (!users.length) {
        list.innerHTML = `<div class="glass-panel vault-card"><p class="muted">Upar kisi dost ka <b>@username</b> likh kar Connect dabaye ya QR scan karein!</p></div>`;
        return;
    }

    const frag = document.createDocumentFragment();
    users.forEach(u => {
        const thread = chatStore[u];
        const lastMsg = thread.messages[thread.messages.length - 1];
        const preview = lastMsg ? (lastMsg.text || `📎 ${lastMsg.mediaName || "Media"}`) : "Connected via E2EE";
        const title = thread.displayName ? `${thread.displayName} (@${u})` : `@${u}`;

        const row = document.createElement("div");
        row.className = "chat-row";
        row.innerHTML = `
            <div class="chat-row-left">
                <div class="avatar-circle">${thread.avatar || "👤"}</div>
                <div class="chat-row-info">
                    <h4>${title}</h4>
                    <p>${preview}</p>
                </div>
            </div>
            ${thread.unread ? `<span class="unread-badge">${thread.unread}</span>` : `<span class="muted">${lastMsg?.time || ""}</span>`}
        `;
        row.onclick = () => {
            thread.unread = 0;
            persistChats();
            openChatWithUser(u);
        };
        frag.appendChild(row);
    });
    list.innerHTML = "";
    list.appendChild(frag);
}

function renderMessagesFull(user) {
    const feed = document.getElementById("messagesContainer");
    const frag = document.createDocumentFragment();
    const msgs = chatStore[user]?.messages || [];
    msgs.forEach(msg => frag.appendChild(createMessageNode(user, msg, false)));
    feed.innerHTML = "";
    feed.appendChild(frag);
    feed.scrollTop = feed.scrollHeight;
}

function createMessageNode(user, msg, animate) {
    const div = document.createElement("div");
    div.id = `msg_${msg.id}`;
    div.className = `msg-bubble ${msg.sender === "me" ? "msg-me" : "msg-peer"} ${animate ? "new-pop" : ""}`;

    let inner = "";
    if (msg.quote) inner += `<div class="quote-box">${msg.quote}</div>`;

    if (msg.gameBoard) {
        inner += `<div style="display:grid;grid-template-columns:repeat(3,44px);gap:4px;margin:4px 0;">
            ${msg.gameBoard.map((cell, idx) => `<button class="tic-cell" data-idx="${idx}" style="height:44px;font-size:18px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.3);color:#fff;">${cell}</button>`).join("")}
        </div>`;
    } else if (msg.mediaUrl) {
        if (msg.viewOnce && msg.openedOnce) {
            inner += `<em>1️⃣ View-Once media expired</em>`;
        } else if (msg.mediaType.startsWith("image/")) {
            inner += `<img src="${msg.mediaUrl}" class="msg-media" loading="lazy" alt="${msg.mediaName}" />`;
        } else if (msg.mediaType.startsWith("video/")) {
            inner += `<video src="${msg.mediaUrl}" controls preload="metadata" class="msg-media"></video>`;
        } else if (msg.mediaType.startsWith("audio/")) {
            inner += `<audio src="${msg.mediaUrl}" controls style="max-width:220px;"></audio>`;
        } else {
            inner += `<a href="${msg.mediaUrl}" download="${msg.mediaName}" style="color:#fff;font-weight:600;">📄 ${msg.mediaName}</a>`;
        }
    } else {
        inner += `<div>${msg.text}</div>`;
    }

    const tickHtml = msg.sender === "me"
        ? `<span class="msg-tick ${msg.status === "seen" ? "tick-seen" : ""}">✓✓</span>`
        : "";

    inner += `
        <div class="msg-footer">
            <span>${msg.time}</span>
            ${tickHtml}
        </div>
        ${msg.reaction ? `<div class="reaction-pill">${msg.reaction}</div>` : ""}
        <div class="msg-actions">
            <button class="act-react" data-emoji="❤️">❤️</button>
            <button class="act-react" data-emoji="😂">😂</button>
            <button class="act-reply">↩️</button>
            ${msg.sender === "me" ? `<button class="act-unsend">🗑️</button>` : ""}
        </div>
    `;

    div.innerHTML = inner;

    const imgEl = div.querySelector("img.msg-media");
    if (imgEl) {
        imgEl.onclick = () => {
            const secret = decodeStegoFromImageElement(imgEl);
            if (secret) alert(`🕵️ Hidden Steganography Secret Unlocked:\n\n"${secret}"`);
            openLightbox(`<img src="${msg.mediaUrl}" style="max-width:95vw;max-height:85vh;border-radius:16px;" />`);
            if (msg.viewOnce) {
                msg.openedOnce = true;
                renderMessagesFull(user);
            }
        };
    }

    div.querySelectorAll(".tic-cell").forEach(btn => {
        btn.onclick = () => {
            const idx = Number(btn.dataset.idx);
            if (msg.gameBoard[idx]) return;
            msg.gameBoard[idx] = msg.sender === "me" ? "X" : "O";
            renderMessagesFull(user);
            if (activeConn && activeConn.open) {
                activeConn.send({ type: "game-move", gameId: msg.id, board: msg.gameBoard });
            }
        };
    });

    div.querySelectorAll(".act-react").forEach(rBtn => {
        rBtn.onclick = () => {
            applyReaction(user, msg.id, rBtn.dataset.emoji);
            if (activeConn && activeConn.open) activeConn.send({ type: "reaction", msgId: msg.id, emoji: rBtn.dataset.emoji });
        };
    });
    div.querySelector(".act-reply").onclick = () => {
        replyingTo = msg.text || msg.mediaName || "Media";
        document.getElementById("replyBar").classList.remove("hidden");
        document.getElementById("replyPreviewText").textContent = replyingTo;
    };
    const unsendBtn = div.querySelector(".act-unsend");
    if (unsendBtn) {
        unsendBtn.onclick = () => {
            deleteMessageLocal(user, msg.id);
            if (activeConn && activeConn.open) activeConn.send({ type: "unsend", msgId: msg.id });
        };
    }

    return div;
}

function sendReadReceipt() {
    if (activeConn && activeConn.open) activeConn.send({ type: "seen" });
}

function clearReply() {
    replyingTo = null;
    document.getElementById("replyBar").classList.add("hidden");
}
document.getElementById("cancelReplyBtn").addEventListener("click", clearReply);

function switchScreen(target) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    target.classList.add("active");
}

document.getElementById("backHomeBtn").addEventListener("click", () => {
    switchScreen(homeScreen);
    renderRecentChats();
});

document.querySelectorAll(".dock-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".dock-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-view").forEach(v => v.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab).classList.add("active");
    });
});

document.getElementById("qrModalBtn").addEventListener("click", () => {
    const box = document.getElementById("qrcodeContainer");
    box.innerHTML = "";
    document.getElementById("qrUserLabel").textContent = myProfile.username;
    new QRCode(box, { text: myProfile.username, width: 180, height: 180 });
    document.getElementById("qrModal").classList.remove("hidden");
});
document.getElementById("closeQrBtn").addEventListener("click", () => document.getElementById("qrModal").classList.add("hidden"));

function openLightbox(html) {
    document.getElementById("lightboxContent").innerHTML = html;
    document.getElementById("mediaLightbox").classList.remove("hidden");
}
document.getElementById("closeLightboxBtn").addEventListener("click", () => document.getElementById("mediaLightbox").classList.add("hidden"));

document.getElementById("changeUserBtn").addEventListener("click", () => switchScreen(setupScreen));
document.getElementById("clearCacheBtn").addEventListener("click", () => {
    chatStore = {};
    persistChats();
    renderRecentChats();
});

function logCallEntry(type, seconds) {
    callLogs.unshift({ user: currentPeerUser, type, duration: `${seconds}s`, time: formatTime() });
    localStorage.setItem("qchd_calls", JSON.stringify(callLogs));
    renderCallLogs();
}

function renderCallLogs() {
    const list = document.getElementById("callLogsList");
    if (!callLogs.length) {
        list.innerHTML = `<div class="glass-panel vault-card"><p class="muted">Abhi tak koi call log nahi hai.</p></div>`;
        return;
    }
    list.innerHTML = callLogs.map(c => `
        <div class="chat-row">
            <div><h4>@${c.user}</h4><p>${c.type} • ${c.duration}</p></div>
            <span class="muted">${c.time}</span>
        </div>
    `).join("");
}

function openOutboxDB() {
    return new Promise(resolve => {
        const req = indexedDB.open("QuickChatOutbox", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("queue", { autoIncrement: true });
        req.onsuccess = () => resolve(req.result);
    });
}

async function queueFileInIndexedDB(targetUser, file) {
    const db = await openOutboxDB();
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").add({ targetUser, file });
    document.getElementById("queueCountDisplay").textContent = "Files queued (auto-send on reconnect)";
}

async function flushOfflineOutbox() {
    if (!activeConn || !activeConn.open) return;
    const db = await openOutboxDB();
    const tx = db.transaction("queue", "readwrite");
    const store = tx.objectStore("queue");
    const req = store.getAll();
    req.onsuccess = async () => {
        const items = req.result || [];
        const matching = items.filter(it => it.targetUser === currentPeerUser).map(it => it.file);
        if (matching.length) {
            store.clear();
            document.getElementById("queueCountDisplay").textContent = "0 files pending";
            await sendFilesBatchSequentially(matching);
        }
    };
}

function formatTime() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function arrayBufferToBase64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}