// NumWorks device identifiers
const NUMWORKS_DEVICES = [
    { vendorId: 0x0483, productId: 0xDF11, name: "NumWorks (DFU Mode)" },
    { vendorId: 0x0483, productId: 0xA291, name: "NumWorks (DFU Mode Alt)" },
    { vendorId: 0x0483, productId: 0xA51A, name: "NumWorks (DFU Mode Alt2)" },
];

const DFU_INTERFACE = 0;
const DFU_DETACH = 0;
const DFU_DNLOAD = 1;
const DFU_UPLOAD = 2;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_GETSTATE = 5;
const DFU_ABORT = 6;

const DFU_STATE_DFU_IDLE = 0x02;
const DFU_STATE_DFU_DOWNLOAD_BUSY = 0x04;
const DFU_STATE_DFU_DOWNLOAD_IDLE = 0x05;
const DFU_STATE_DFU_MANIFEST = 0x07;

let connectedDevice = null;
let selectedFile = null;
let isUploading = false;
let wakeLock = null;

const detectBtn = document.getElementById('detectBtn');
const terminalLog = document.getElementById('terminalLog');
const devicesDiv = document.getElementById('devices');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const uploadControls = document.getElementById('uploadControls');
const uploadBtn = document.getElementById('uploadBtn');
const transferList = document.getElementById('transferList');

function resetConnectionState() {
    connectedDevice = null;
    // A physical disconnect breaks the ongoing WebUSB session: we permanently
    // grey out the buttons instead of offering an immediate reconnection
    // that would silently fail. The page needs to be reloaded.
    detectBtn.disabled = true;
    detectBtn.textContent = 'Disconnected';
    uploadBtn.disabled = true;
    selectedFile = null;
    fileInput.value = '';
    // We do NOT clear devicesDiv / transferList and do NOT hide the
    // sections: they stay displayed as-is to keep the history visible
    // (calculator info, progress of the last transfer) instead of making
    // everything disappear on disconnect.
    showStatus('Device disconnected. Reload the page to reconnect.', 'error');
}

function showStatus(message, type = 'info') {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const line = document.createElement('div');
    line.className = `log-line ${type}`;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = `[${time}]`;

    line.appendChild(timeSpan);
    line.appendChild(document.createTextNode(message));

    terminalLog.appendChild(line);
    terminalLog.scrollTop = terminalLog.scrollHeight;
}

function getModel(device) {
    const major = Number(device.deviceVersionMajor || 0);
    const minor = Number(device.deviceVersionMinor || 0);
    const subminor = Number(device.deviceVersionSubminor || 0);
    const bcd = (major << 8) | (minor << 4) | subminor;
    return `n${bcd.toString(16).padStart(4, '0')}`;
}

function displayDevice(device, index = 0) {
    const deviceEl = document.createElement('div');
    deviceEl.className = 'device-item';

    const model = getModel(device);
    const info = `
        <strong>Device #${index + 1}</strong><br>
        <div class="device-info">
            <strong>Model:</strong> ${model}<br>
            <strong>Name:</strong> ${device.productName || 'Unknown'}<br>
            <strong>Serial:</strong> ${device.serialNumber || 'N/A'}<br>
            <strong>Vendor ID:</strong> 0x${device.vendorId.toString(16).padStart(4, '0')}<br>
            <strong>Product ID:</strong> 0x${device.productId.toString(16).padStart(4, '0')}
        </div>
    `;

    deviceEl.innerHTML = info;
    devicesDiv.appendChild(deviceEl);
}

function showFileUpload() {
    dropZone.classList.remove('hidden');
    uploadControls.classList.add('hidden');
}

function handleFiles(files) {
    if (!files || !files.length) {
        return;
    }

    const file = files[0];
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.dfu') && !lower.endsWith('.bin')) {
        showStatus('Only .dfu or .bin files are accepted.', 'error');
        return;
    }

    selectedFile = file;
    uploadControls.classList.remove('hidden');
    showStatus(`File ready: ${file.name}`, 'success');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
        showStatus('Wake Lock not supported: keep the screen awake manually during the transfer.', 'info');
        return;
    }
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
        });
    } catch (error) {
        showStatus(`Could not keep the screen awake: ${error.message}`, 'info');
    }
}

async function releaseWakeLock() {
    if (wakeLock) {
        try {
            await wakeLock.release();
        } catch (error) {
            // Ignore, the lock might already be released (e.g. tab hidden then closed).
        }
        wakeLock = null;
    }
}

// The Wake Lock is released by the browser if the tab is hidden; we
// automatically request it again when the tab becomes visible again while
// a transfer is still in progress, so the screen doesn't fall back asleep.
document.addEventListener('visibilitychange', () => {
    if (isUploading && document.visibilityState === 'visible' && !wakeLock) {
        acquireWakeLock();
    }
});

// Prevents the tab from being closed/reloaded by accident during a transfer:
// the USB transmission keeps running as long as the page stays loaded, and
// switching tabs doesn't interrupt it, but closing or reloading the page does.
window.addEventListener('beforeunload', (event) => {
    if (isUploading) {
        event.preventDefault();
        event.returnValue = '';
    }
});

async function controlTransferOut(device, params, data) {
    const transferParams = {
        requestType: params.requestType ?? 'class',
        recipient: params.recipient ?? 'interface',
        request: params.request,
        value: params.value ?? 0,
        index: params.index ?? 0,
    };

    const payload = data instanceof ArrayBuffer ? new Uint8Array(data) : (data ?? new Uint8Array());
    return device.controlTransferOut(transferParams, payload);
}

async function controlTransferIn(device, params, length) {
    const transferParams = {
        requestType: params.requestType ?? 'class',
        recipient: params.recipient ?? 'interface',
        request: params.request,
        value: params.value ?? 0,
        index: params.index ?? 0,
    };

    return device.controlTransferIn(transferParams, length);
}

async function getDfuStatus(device) {
    const result = await controlTransferIn(device, {
        requestType: 'class',
        recipient: 'interface',
        request: DFU_GETSTATUS,
        value: 0,
        index: 0,
    }, 6);

    if (!result.data || result.data.byteLength < 6) {
        throw new Error('DFU status read returned no data.');
    }

    const data = result.data;
    const status = data.getUint8(4);
    let pollTimeout = data.getUint8(1);
    pollTimeout |= data.getUint8(2) << 8;
    pollTimeout |= data.getUint8(3) << 16;
    await sleep(pollTimeout);
    return status;
}

async function setAddress(device, address) {
    const payload = new DataView(new ArrayBuffer(5));
    payload.setUint8(0, 0x21);
    payload.setUint32(1, address >>> 0, true);

    await controlTransferOut(device, {
        requestType: 'class',
        recipient: 'interface',
        request: DFU_DNLOAD,
        value: 0,
        index: 0,
    }, new Uint8Array(payload.buffer));

    if ((await getDfuStatus(device)) !== DFU_STATE_DFU_DOWNLOAD_BUSY) {
        throw new Error('DFU set address failed: busy state not reached');
    }
    if ((await getDfuStatus(device)) !== DFU_STATE_DFU_DOWNLOAD_IDLE) {
        throw new Error('DFU set address failed: idle state not reached');
    }
}

async function pageErase(device, address) {
    const payload = new DataView(new ArrayBuffer(5));
    payload.setUint8(0, 0x41);
    payload.setUint32(1, address >>> 0, true);

    await controlTransferOut(device, {
        requestType: 'class',
        recipient: 'interface',
        request: DFU_DNLOAD,
        value: 0,
        index: 0,
    }, new Uint8Array(payload.buffer));

    if ((await getDfuStatus(device)) !== DFU_STATE_DFU_DOWNLOAD_BUSY) {
        throw new Error('DFU erase failed: busy state not reached');
    }
    if ((await getDfuStatus(device)) !== DFU_STATE_DFU_DOWNLOAD_IDLE) {
        throw new Error('DFU erase failed: idle state not reached');
    }
}

async function writeMemory(device, address, data) {
    const chunkSize = 1024;
    let offset = 0;

    while (offset < data.length) {
        await setAddress(device, address + offset);
        const chunk = data.slice(offset, offset + chunkSize);

        await controlTransferOut(device, {
            requestType: 'class',
            recipient: 'interface',
            request: DFU_DNLOAD,
            value: 2,
            index: 0,
        }, new Uint8Array(chunk));

        if ((await getDfuStatus(device)) !== DFU_STATE_DFU_DOWNLOAD_BUSY) {
            throw new Error('DFU write failed: busy state not reached');
        }
        if ((await getDfuStatus(device)) !== DFU_STATE_DFU_DOWNLOAD_IDLE) {
            throw new Error('DFU write failed: idle state not reached');
        }

        offset += chunk.length;
    }
}

function parseDfuFile(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let offset = 0;

    const signature = String.fromCharCode(...bytes.slice(0, 5));
    if (signature !== 'DfuSe') {
        throw new Error('Invalid DFU file: missing DfuSe header.');
    }

    offset += 5;
    const version = bytes[offset++];
    const fileSize = view.getUint32(offset, true);
    offset += 4;
    const targetCount = bytes[offset++];

    const elements = [];

    for (let targetIndex = 0; targetIndex < targetCount; targetIndex++) {
        const targetSignature = String.fromCharCode(...bytes.slice(offset, offset + 6));
        if (targetSignature !== 'Target') {
            throw new Error(`Invalid DFU target header at index ${targetIndex}.`);
        }
        offset += 6;

        const altSetting = bytes[offset++];
        const named = view.getUint32(offset, true);
        offset += 4;
        const nameBytes = bytes.slice(offset, offset + 255);
        offset += 255;
        const imageSize = view.getUint32(offset, true);
        offset += 4;
        const elementCount = view.getUint32(offset, true);
        offset += 4;

        const targetDataStart = offset;
        const targetEnd = targetDataStart + imageSize;

        for (let elementIndex = 0; elementIndex < elementCount; elementIndex++) {
            const address = view.getUint32(offset, true);
            offset += 4;
            const size = view.getUint32(offset, true);
            offset += 4;

            const data = bytes.slice(offset, offset + size);
            offset += size;

            elements.push({ address, size, data });
        }

        if (offset !== targetEnd) {
            offset = targetEnd;
        }

        if (named) {
            void altSetting;
            void nameBytes;
        }
    }

    if (version !== 1) {
        console.warn(`DFU version is ${version}, expected 1.`);
    }

    void fileSize;
    return elements;
}

const PAGE_SIZE = 0x1000; // Assume 4KB pages (STM32F4xx/H7xx external flash)

// NB: we avoid bitwise operators (& / ~) to align addresses to a page,
// because they convert their operands to SIGNED int32 in JS. But the N0120's
// external QSPI addresses (e.g. 0x90000000, 0x907F0000...) exceed
// 0x7FFFFFFF and become negative once passed through `&`, which throws off
// every pagination calculation.
function pageAlignedAddr(addr) {
    return Math.floor(addr / PAGE_SIZE) * PAGE_SIZE;
}

function formatAddress(addr) {
    return `0x${addr.toString(16).padStart(8, '0')}`;
}

// Builds, for each element of the DFU file, a block in #transferList with
// two distinct progress bars: one for erasing the relevant flash pages, one
// for writing the data. Returns an array parallel to `elements`, with the
// DOM nodes and the set of pages specific to that element.
function buildTransferList(elements) {
    transferList.innerHTML = '';

    return elements.map((element) => {
        const firstPage = pageAlignedAddr(element.address);
        const lastPage = pageAlignedAddr(element.address + element.size - 1);
        const pages = new Set();
        for (let page = firstPage; page <= lastPage; page += PAGE_SIZE) {
            pages.add(page);
        }

        const item = document.createElement('div');
        item.className = 'transferItem';
        item.innerHTML = `
            <div class="transferItem-header">
                <span class="transferItem-address">${formatAddress(element.address)}</span>
                <span class="transferItem-size">${element.size.toLocaleString()} bytes</span>
            </div>
            <div class="transferItem-phase">
                <span class="phaseLabel" data-phase="erase">Erase</span>
                <div class="miniBar"><div class="miniBarFill" data-fill="erase"></div></div>
            </div>
            <div class="transferItem-phase">
                <span class="phaseLabel" data-phase="write">Write</span>
                <div class="miniBar"><div class="miniBarFill" data-fill="write"></div></div>
            </div>
        `;
        transferList.appendChild(item);

        return {
            pages,
            pagesErased: 0,
            eraseLabel: item.querySelector('[data-phase="erase"]'),
            eraseFill: item.querySelector('[data-fill="erase"]'),
            writeLabel: item.querySelector('[data-phase="write"]'),
            writeFill: item.querySelector('[data-fill="write"]'),
        };
    });
}

function setPhaseProgress(labelEl, fillEl, percent) {
    fillEl.style.width = `${percent}%`;
    if (percent >= 100) {
        labelEl.classList.remove('active');
        labelEl.classList.add('done');
        fillEl.classList.add('done');
    } else if (percent > 0) {
        labelEl.classList.add('active');
    }
}

async function uploadDfuFile(file) {
    if (!connectedDevice) {
        throw new Error('No device connected.');
    }

    const arrayBuffer = await file.arrayBuffer();
    const elements = parseDfuFile(arrayBuffer);
    if (!elements.length) {
        throw new Error('No DFU elements found in the file.');
    }

    const transferItems = buildTransferList(elements);

    // The first element (the largest, usually the userland executable) is
    // labeled "userland" in the log; any additional element (e.g. the
    // persisting_bytes_buffer section extracted separately by elf2dfu.py)
    // is labeled generically as "memory".
    const elementLabel = (index) => (index === 0 ? 'userland' : 'memory');

    // IMPORTANT: a DFU file often contains several "elements" that can
    // share the same 4KB flash page. If we erase a page that was already
    // erased for a previous element, we lose data already written -> the
    // userland gets corrupted -> crash on launch. So we keep a global
    // record of pages already erased, shared across elements, even though
    // we perform and log the erase element by element.
    const erasedPages = new Set();

    for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        const item = transferItems[i];
        const label = elementLabel(i);

        showStatus(`Erase ${label} (${element.size.toLocaleString()} bytes)`, 'info');

        for (const page of Array.from(item.pages).sort((a, b) => a - b)) {
            if (!erasedPages.has(page)) {
                await pageErase(connectedDevice, page);
                erasedPages.add(page);
            }
            item.pagesErased += 1;
            const percent = Math.round((item.pagesErased / item.pages.size) * 100);
            setPhaseProgress(item.eraseLabel, item.eraseFill, percent);
        }
    }

    for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        const item = transferItems[i];
        const label = elementLabel(i);

        showStatus(`Write ${label} (${element.size.toLocaleString()} bytes)`, 'info');

        let addr = element.address;
        let size = element.size;
        const data = new Uint8Array(element.data);
        let dataOffset = 0;
        let written = 0;
        const chunkSize = 1024;

        while (size > 0) {
            const writeSize = Math.min(size, chunkSize);
            const chunk = data.slice(dataOffset, dataOffset + writeSize);
            await writeMemory(connectedDevice, addr, chunk);

            written += writeSize;
            dataOffset += writeSize;
            addr += writeSize;
            size -= writeSize;

            const percent = Math.round((written / element.size) * 100);
            setPhaseProgress(item.writeLabel, item.writeFill, percent);
        }
    }

    showStatus(`Userland sent to slot B: ${file.name}`, 'success');
}

async function startUserlandUpload() {
    if (!selectedFile) {
        showStatus('No file selected.', 'error');
        return;
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Sending...';
    isUploading = true;
    await acquireWakeLock();

    try {
        await uploadDfuFile(selectedFile);
    } catch (error) {
        showStatus(`DFU upload failed: ${error.message}`, 'error');
    } finally {
        uploadBtn.textContent = 'Send userland to slot B';
        uploadBtn.disabled = false;
        isUploading = false;
        await releaseWakeLock();
    }
}

async function detectDevices() {
    if (connectedDevice) {
        return;
    }

    showStatus('Searching...', 'info');

    if (!navigator.usb) {
        showStatus('WebUSB is not supported in this browser.', 'error');
        return;
    }

    try {
        const device = await navigator.usb.requestDevice({ filters: NUMWORKS_DEVICES });

        if (!device) {
            showStatus('No device selected.', 'error');
            return;
        }

        connectedDevice = device;
        await initDevice();
        displayDevice(device);
        showFileUpload();
    } catch (error) {
        connectedDevice = null;
        if (error.name === 'NotFoundError') {
            showStatus('No device found.', 'error');
        } else {
            showStatus(`Error: ${error.message}`, 'error');
        }
    }
}

async function initDevice() {
    if (!connectedDevice) {
        showStatus('No device selected.', 'error');
        return;
    }

    try {
        showStatus('Initializing...', 'info');

        await connectedDevice.open();
        showStatus('USB connected.', 'success');

        const configurations = connectedDevice.configurations;
        if (configurations.length > 0) {
            await connectedDevice.selectConfiguration(configurations[0].configurationValue);
            showStatus('Configuration selected.', 'success');
        } else {
            showStatus('No configuration found.', 'error');
            return;
        }

        await connectedDevice.claimInterface(DFU_INTERFACE);
        detectBtn.disabled = true;
        detectBtn.textContent = 'Connected';
        showStatus('Device ready.', 'success');

        navigator.usb.ondisconnect = (event) => {
            if (connectedDevice && event.device === connectedDevice) {
                resetConnectionState();
            }
        };
    } catch (error) {
        connectedDevice = null;
        detectBtn.disabled = false;
        detectBtn.textContent = 'Connect calculator';
        showStatus(`Initialization error: ${error.message}`, 'error');
        console.error(error);
    }
}

detectBtn.addEventListener('click', detectDevices);
uploadBtn.addEventListener('click', startUserlandUpload);

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (event) => handleFiles(event.target.files));

dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(event.dataTransfer.files);
});

window.addEventListener('load', () => {
    if (!navigator.usb) {
        showStatus('WebUSB is not supported. Use Chrome, Edge or Brave.', 'error');
        detectBtn.disabled = true;
    }
});