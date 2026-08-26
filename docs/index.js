// NumWorks device identifiers
const NUMWORKS_DEVICES = [
    { vendorId: 0x0483, productId: 0xDF11, name: "NumWorks (DFU Mode)" },
    { vendorId: 0x0483, productId: 0xA291, name: "NumWorks (DFU Mode Alt)" },
    { vendorId: 0x0483, productId: 0xA51A, name: "NumWorks (DFU Mode Alt2)" },
];

const DFU_INTERFACE = 0;

let connectedDevice = null;

const detectBtn = document.getElementById('detectBtn');
const statusDiv = document.getElementById('status');
const devicesDiv = document.getElementById('devices');

function resetConnectionState() {
    connectedDevice = null;
    detectBtn.disabled = false;
    detectBtn.textContent = 'Connect calculator';
    devicesDiv.innerHTML = '';
    showStatus('Device disconnected.', 'info');
}

function showStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = type;
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

window.addEventListener('load', () => {
    if (!navigator.usb) {
        showStatus('WebUSB is not supported. Use Chrome, Edge or Brave.', 'error');
        detectBtn.disabled = true;
    }
});
