/**
 *
 *      iobroker extron (SIS) Adapter
 *
 *      Copyright (c) 2020-2025, Bannsaenger <bannsaenger@gmx.de>
 *
 *      CC-NC-BY 4.0 License
 *
 *      last edit 20250907 Bannsaenger
 */

// The adapter-core module gives you access to the core ioBroker functions
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
const fs = require('fs');
const Client = require('ssh2').Client;
const Net = require('net');
const ping = require('net-ping');
const path = require('path');

const errCodes = {
    E01: 'Invalid input channel number (out of range)',
    E10: 'Unrecognized command',
    E11: 'Invalid preset number (out of range)',
    E12: 'Invalid port/output number (out of range)',
    E13: 'Invalid parameter (number is out of range)',
    E14: 'Not valid for this configuration',
    E17: 'Invalid command for signal type / system timed out',
    E18: 'System/command timed out',
    E22: 'Busy',
    E24: 'Privilege violation',
    E25: 'Device not present',
    E26: 'Maximum number of connections exceeded',
    E27: 'Invalid event number',
    E28: 'Bad filename or file not found',
    E30: 'Hardware failure',
    E31: 'Attempt to break port passthrough when not set',
};

const invalidChars = ['+', '~', ',', '@', '=', "'", '[', ']', '{', '}', '<', '>', '`', '"', ':', ';', '|', '\\', '?'];

class Extron extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] Options from js-controller
     */
    constructor(options) {
        super({
            ...options,
            name: 'extron',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        try {
            // Initialize your adapter here
            const startTime = Date.now();

            // read Objects template for object generation
            this.objectTemplates = JSON.parse(fs.readFileSync(`${__dirname}/lib/object_templates.json`, 'utf8'));
            // read devices for device check
            this.devices = JSON.parse(fs.readFileSync(`${__dirname}/lib/device_mapping.json`, 'utf8'));

            this.initVars();

            // Reset the connection indicator during startup
            this.setState('info.connection', false, true);

            // Check whether the device type is already chosen. If not, skip the initialisation process and run in offline mode
            // only for the messageBox
            if (this.config.device === '') {
                this.log.warn(`No device type specified. Running in Offline Mode`);
            } else {
                // The adapters config (in the instance object everything under the attribute "native") is accessible via
                // this.config:
                this.log.info(`onReady(): configured host/port: ${this.config.host}:${this.config.port}`);

                /*
                 * For every state in the system there has to be also an object of type state
                 */
                await this.setInstanceNameAsync();
                await this.createDeviceCommonAsync();
                await this.createDatabaseAsync();
                for (const device of this.config.remoteDevices) {
                    await this.createDeviceCommonAsync(device.danteName);
                    //await this.createDatabaseAsync(device.danteName);
                }
                await this.createStatesListAsync();

                // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
                // this.subscribeStates('testVariable');
                this.subscribeStates('*'); // subscribe to all states

                // Client callbacks
                switch (this.config.type) {
                    case 'ssh':
                        this.client.on('keyboard-interactive', this.onClientKeyboard.bind(this));
                        this.client.on('ready', this.onClientReady.bind(this));
                        //this.client.on('banner', this.onClientBanner.bind(this));
                        this.client.on('close', this.onClientClose.bind(this));
                        this.client.on('error', this.onClientError.bind(this));
                        this.client.on('end', this.onClientEnd.bind(this));
                        break;

                    case 'telnet':
                        this.net.on('connectionAttempt', () => {
                            this.log.debug(`this.net.on: Telnet: connectionAttempt started`);
                        });
                        this.net.on('connectionAttemptTimeout', () => {
                            this.log.warn(`this.net.on: Telnet: connectionAttemptTimeout`);
                            this.device.connectionState = 'FAILED';
                        });
                        this.net.on('connectionAttemptFailed', () => {
                            this.log.warn(`this.net.on: Telnet: connectionAttemptFailed`);
                            this.device.connectionState = 'FAILED';
                        });
                        this.net.on('timeout', () => {
                            this.log.warn(`this.net.on: Telnet: connection idle timeout`);
                        });
                        this.net.on('connect', () => {
                            this.log.debug(`this.net.on: Telnet: connected`);
                        });
                        this.net.on('ready', this.onClientReady.bind(this));
                        this.net.on('error', this.onClientError.bind(this));
                        this.net.on('end', this.onClientEnd.bind(this));
                        this.net.on('close', () => {
                            this.log.debug(`this.net.on: Telnet: socket closed`);
                            this.device.connectionState = 'CLOSED';
                            //this.clientReConnect();
                        });
                        break;
                }
                this.log.info(`onReady(): Extron took ${Date.now() - startTime}ms to initialize and setup db`);

                // start central timer/interval handler
                // @ts-expect-error Types missmatch, but works
                this.centralIntervalTimer = setInterval(this.centralIntervalTimer.bind(this), this.tmrRes);
            }
        } catch (err) {
            this.errorHandler(err, 'onReady');
        }
    }

    /**
     * called to initialize internal variables
     */
    initVars() {
        this.log.debug('initVars(): Extron initializing internal variables');
        this.sendBuffer = []; // Send buffer (Array of commands to send)
        this.fileBuffer = new Uint8Array(); // buffer for file data
        this.grpCmdBuf = new Array(65).fill([]); // buffer for group command while a group deletion is pending
        // Status variables
        this.isDeviceChecked = false; // will be true if device sends banner and will be verified
        this.isLoggedIn = false; // will be true once telnet login completed
        this.isVerboseMode = false; // will be true if verbose mode 3 is active
        this.initDone = false; // will be true if all init is done
        this.device = {
            model: '',
            name: '',
            version: '',
            description: '',
            connectionState: 'NEW',
            ipAddress: this.config.host,
            port: this.config.port,
            active: true,
        }; // will be filled according to device responses
        this.statusRequested = false; // will be true once device status has been requested after init
        this.statusSent = false; // will be true once database settings have been sent to device
        this.clientReady = false; // will be true if device connection is ready
        //this.timers = {};               // Some timers and intervalls
        this.debugSSH = false; // debug option for full ssh debug log on adapter.log.silly
        this.client = new Client(); // Create a ssh lient socket to connect to the device
        this.net = new Net.Socket({ readable: true, writable: true, allowHalfOpen: false }); // Create a client socket to connect to the device
        this.net.setKeepAlive(true);
        this.net.setNoDelay(true);
        this.stream = undefined; // placeholder for the stream
        this.streamAvailable = true; // if false wait for continue event
        this.stateList = []; // will be filled with all existing states
        this.maxPollCount = typeof this.config.maxPollCount != 'undefined' ? this.config.maxPollCount : 10; // set maxPollCount if undefined set 10
        this.pollCount = 0; // count sent status query
        this.playerLoaded = [false, false, false, false, false, false, false, false]; // remember which player has a file assigned
        this.auxOutEnabled = [false, false, false, false, false, false, false, false]; // remember which aux output is enabled
        this.groupTypes = new Array(65); // prepare array to hold the type of groups
        this.groupTypes.fill(0);
        this.groupMembers = new Array(65); // prepare array to hold actual group members
        this.groupMembers.fill([]);
        this.grpDelPnd = new Array(65).fill(false); // prepare array to flag group deletions pending
        this.fileSend = false; // flag to signal a file is currently sended
        this.requestDir = false; // flag to signal a list user files command has been issued and a directory list is to be received
        this.file = { fileName: '', timeStamp: '', fileSize: 0 }; // file object
        this.fileList = { freeSpace: 0, files: [this.file] }; // array to hold current file list
        this.stateBuf = [{ id: '', timestamp: 0 }]; // array to hold state changes with timestamp
        this.presetList = ''; // list of SMD202 preset channels
        this.requestPresets = false; // flag to signal thet device preset list has been requested (applies to SMD202)
        this.deviceList = ''; // list of DANTE devices as reported
        this.rcvDanteDeviceList = false; // flag on receiving DANTE device list
        this.danteDevices = {}; // store subdevices controlled via DANTE
        this.tmrRes = this.config.tmrRes || 100; // timer resolution, default 100 ms
        this.preCheckWithICMP = this.config.preCheckWithICMP === undefined ? true : this.config.preCheckWithICMP; // check the availability of the device with ping
        this.tryICMPAfterRetries = this.config.tryICMPAfterRetries || 2; // switch to ICMP (ping) availability check after n tries, -1 = off
        this.connectTimeout = this.config.connectTimeout || 3000; // time to wait for connection to complet in ms (defalt 3s)
        this.reConnectTimeout = this.config.reconnectDelay || 10000; // time to wait after a connection failure for a new attempt (default: 10 s)

        // -------------------------------------------------------------------------------------
        // create a ping session for connection checking
        this.ping_options = {
            networkProtocol: ping.NetworkProtocol.IPv4,
            packetSize: 16,
            retries: 1,
            timeout: 1000,
            ttl: 128,
        };
        this.pingSession = ping.createSession(this.ping_options);

        // ping session events
        this.pingSession.on('close', this.onPingClose.bind(this));
        this.pingSession.on('error', this.onPingError.bind(this));

        // start central timer/interval handler
        //this.centralIntervalTimer = setInterval(this.centralIntervalTimer.bind(this), this.tmrRes);
    }

    /**
     * Intervaltimer tmrRes (default: 1) per Second to handle all timeouts and reconnets etc.
     */
    centralIntervalTimer() {
        try {
            // iterate through all devices
            //for (const device of this.devices) {
            const device = this.device;
            switch (device.connectionState) {
                case 'NEW': // Initialize timers etc.
                    if (this.preCheckWithICMP) {
                        device.connectionState = 'ICMP_CHECKING';
                        device.timeToWait = this.connectTimeout / this.tmrRes;
                        this.pingSession.pingHost(device.ipAddress, this.onPingCallback.bind(this));
                    } else {
                        device.connectionState = 'CONNECTING';
                        device.timeToWait = this.connectTimeout / this.tmrRes;
                        device.connectionAttempt = this.tryICMPAfterRetries;
                        this.clientConnect();
                    }
                    break;

                case 'CONNECTED': // Handle timers for Alive and GetStatus
                    if (device.timeoutPolling > 0) {
                        device.timeoutPolling--;
                    } else {
                        device.timeoutPolling = this.config.pollDelay / this.tmrRes;
                        this.queryStatus();
                    }
                    break;

                case 'CLOSED':
                case 'FAILED':
                    device.timeToWait = 0; // handle closed or failed connections immediately
                    device.connectionState = 'CONNECTING';
                    break;

                case 'CONNECTING': // Check whether the connection timneout has exeeded
                    if (device.timeToWait > 0) {
                        device.timeToWait--;
                    } else {
                        //if (this.callback) this.callback('OFFLINE', {'message': `Device ${device.ipAddress} is offline`, 'macAddress': device.device, 'senderIp': device.ipAddress});
                        //if (device.net) device.net.destroy();
                        //device.net = undefined;
                        device.timeToWait = this.reConnectTimeout / this.tmrRes;
                        if (device.connectionAttempt > 0) {
                            device.connectionAttempt--;
                            //this.log.warn(`noch ${device.connectionAttempt} übrig`)
                            device.connectionState = 'RECONNECT_WAITING';
                        } else {
                            //this.log.warn(`gehe zu ICMP check`)
                            device.connectionState = 'ICMP_CHECKING';
                        }
                    }
                    break;

                case 'RECONNECT_WAITING': // try to reconnect when timer expired
                    if (device.timeToWait > 0) {
                        device.timeToWait--;
                    } else {
                        device.connectionState = 'CONNECTING';
                        device.timeToWait = this.connectTimeout / this.tmrRes;
                        this.clientConnect();
                    }
                    break;

                case 'ICMP_CHECKING':
                    if (device.timeToWait > 0) {
                        device.timeToWait--;
                    } else {
                        device.timeToWait = this.reConnectTimeout / this.tmrRes;
                        this.log.debug(`centralIntervalTimer(): pinging ${device.ipAddress}`);
                        this.pingSession.pingHost(device.ipAddress, this.onPingCallback.bind(this));
                    }
                    break;

                case 'ICMP_AVAILABLE':
                    device.connectionState = 'CONNECTING';
                    device.timeToWait = this.connectTimeout / this.tmrRes;
                    device.connectionAttempt = this.tryICMPAfterRetries;
                    this.clientConnect();
                    break;
            }
            //}
        } catch (err) {
            this.errorHandler(err, 'centralIntervalTimer');
        }
    }

    /**
     * try to connect to the device
     */
    clientConnect() {
        try {
            this.log.info(
                `clientConnect(): Extron connecting via ${this.config.type} to: ${this.config.host}:${this.config.port}`,
            );
            switch (this.config.type) {
                case 'ssh':
                    this.client.connect({
                        host: this.config.host,
                        port: Number(this.config.port),
                        username: this.config.user,
                        password: this.config.pass,
                        keepaliveInterval: 5000,
                        debug: this.debugSSH ? this.log.silly.bind(this) : undefined,
                        //'debug': true,
                        readyTimeout: 5000,
                        tryKeyboard: true,
                    });
                    break;

                case 'telnet':
                    this.stream = this.net.connect(Number(this.config.port), this.config.host);
                    break;
            }
        } catch (err) {
            this.errorHandler(err, 'clientConnect');
        }
    }

    /**
     * called if keyboard authentication must be fullfilled
     *
     * @param {string} _name Name for fullfilment
     * @param {string} _instructions Instructions for fullfilment
     * @param {string} _instructionsLang Language for fullfilment
     * @param {Array} _prompts Prompts for fullfilment
     * @param {Function} finish Finisch for fullfilment
     */
    onClientKeyboard(_name, _instructions, _instructionsLang, _prompts, finish) {
        try {
            this.log.info('onClientKeyboard(): Extron keyboard autentication in progress. Send back password');
            finish([this.config.pass]);
        } catch (err) {
            this.errorHandler(err, 'onClientKeyboard');
        }
    }

    /**
     * called if client is successfully connected
     */
    onClientReady() {
        try {
            switch (this.config.type) {
                case 'ssh':
                    this.log.info('onClientReady(): Extron is authenticated successfully, now open the stream');
                    this.client.shell(function (error, channel) {
                        try {
                            if (error) {
                                throw error;
                            }
                            // @ts-expect-error this is valid in real
                            this.log.info('onClientReady(): Extron shell established channel');
                            this.stream = channel;
                        } catch (err) {
                            // @ts-expect-error this is valid in real
                            this.errorHandler(err, 'onClientReady');
                        }
                    });
                    break;
                case 'telnet':
                    this.log.info('onClientReady(): Extron established Telnet connection');
                    break;
            }
            this.stream.on('error', this.onStreamError.bind(this));
            this.stream.on('close', this.onStreamClose.bind(this));
            this.stream.on('data', this.onStreamData.bind(this));
            this.stream.on('drain', this.onStreamContinue.bind(this));
            // Set the connection indicator after authentication and an open stream
            this.log.info('onClientReady(): Extron connected');
            this.device.connectionState = 'CONNECTED';
            this.device.timeToWait = 0;
            this.device.timeoutPolling = 0; // next timercycle there will be a polling
            // this.setState('info.connection', true, true);
            // this.timers.timeoutQueryStatus = setTimeout(this.queryStatus.bind(this), this.config.pollDelay);    // start polling the device
        } catch (err) {
            this.errorHandler(err, 'onClientReady');
        }
    }

    /**
     * called if client has recieved a banner
     *
     * @param {string} message
     * @param {string} language
     */
    /*
    onClientBanner(message, language) {
        this.log.info(`onClientBanner(): Extron sent back banner: "${message}" in language: "${language}"`);
    }*/

    /**
     * called if client is closed
     */
    onClientClose() {
        try {
            this.log.info('onClientClose(): Extron SSH client closed');
            // Reset the connection indicator
            this.setState('info.connection', false, true);
            this.clientReady = false;
            this.isDeviceChecked = false; // will be true if device sends banner and will be verified
            this.isVerboseMode = false; // will be true if verbose mode 3 is active
            this.initDone = false; // will be true if all init is done
            this.statusRequested = false; // will be true if device status has been requested after init
            this.statusSent = false; // will be true once database settings have been sent to device
            this.stream = undefined;
            this.device.connectionState = 'CLOSED';
        } catch (err) {
            this.errorHandler(err, 'onClientClose');
        }
    }

    /**
     * called if the socket is disconnected
     */
    onClientEnd() {
        try {
            this.log.info('onClientEnd(): Extron client socket got disconnected');
            this.setState('info.connection', false, true);
            this.device.connectionState = 'CLOSED';
        } catch (err) {
            this.errorHandler(err, 'onClientEnd');
        }
    }

    /**
     * reconnect Client after error
     */
    clientReConnect() {
        // clear poll timer
        //clearTimeout(this.timers.timeoutQueryStatus); // stop the query timer
        // Status variables to be reset
        this.setState('info.connection', false, true);
        this.isLoggedIn = false; // will be true once telnet login completed
        this.isVerboseMode = false; // will be true if verbose mode 3 is active
        this.isDeviceChecked = false; // will be true if device sends banner and will be verified
        this.log.info(`clientReConnect(): reconnecting after ${this.config.reconnectDelay}ms`);
        //this.timers.timeoutReconnectClient = setTimeout(this.clientConnect.bind(this),this.config.reconnectDelay);
    }

    /**
     * called if client receives an error
     *
     * @param {any} err Error
     */
    onClientError(err) {
        switch (this.config.type) {
            case 'ssh':
                break;
            case 'telnet':
                if (this.net.connect) {
                    this.log.debug(`onClientError(): telnet connection pending ...`);
                    return;
                }
                break;
        }
        this.device.connectionState = 'FAILED';
        this.log.error(`onClientError(): error detected ${err}`);
        this.errorHandler(err, 'onClientError');
    }

    /**
     * Is called if a session error occurs
     *
     * @param {any} err Error
     */
    onPingError(err) {
        try {
            this.log.error(`ICMP session Server got Error: <${err.toString()}> closing server.`);
            this.pingSession.close();
        } catch (err) {
            this.errorHandler(err, 'onPingError');
        }
    }

    /**
     * Is called when the session is closed via session.close
     */
    onPingClose() {
        this.log.info('onPingClose(): ICMP session is closed');
    }

    /**
     * Is used as callback for session.ping
     *
     *  @param {Error} error  Instance of the Error class or a sub-class, or null if no error occurred
     *  @param {any}   target The target parameter as specified in the request still be the target host and NOT the responding gateway
     *  @param {Date}  sent   An instance of the Date class specifying when the first ping was sent for this request (refer to the Round Trip Time section for more information)
     *  @param {Date}  rcvd   An instance of the Date class specifying when the request completed (refer to the Round Trip Time section for more information)
     */
    onPingCallback(error, target, sent, rcvd) {
        try {
            // @ts-expect-error this can be done
            const ms = rcvd - sent;
            if (error) {
                this.log.debug(`ping: ${target}: ${error.toString()}`);
            } else {
                this.log.debug(`ping: ${target}: Alive (ms=${ms})`);
                // const device = this.devices.find(item => item.ipAddress === target);
                this.device.connectionState = 'ICMP_AVAILABLE';
                // reconnect is done in the timer routine
            }
        } catch (err) {
            this.errorHandler(err, 'onPingCallback');
        }
    }

    /**
     * called to send data to the stream
     *
     * @param {string | Uint8Array | any} data the data to send
     * @param {string | void} device the device which will receive the data
     */
    streamSend(data, device = '') {
        try {
            if (device != '') {
                if (
                    this.devices[this.config.device].model.includes('Plus') ||
                    this.devices[this.config.device].model.includes('XMP')
                ) {
                    // DANTE control only on DMP plus / XMP series
                    data = data.replace('\r', '|'); // for DANTE relayed messages replace '\r' with '|'
                    data = `{dante@${device}:${data}}\r`; // format DANTE relay message
                }
            }
            if (this.streamAvailable) {
                this.setState(device != '' ? `dante.${device}.info.connection` : 'info.connection', true, true);
                if (!this.fileSend) {
                    this.log.debug(
                        `streamSend(): Extron sends data to the ${this.config.type} stream: "${this.decodeBufferToLog(data)}"`,
                    );
                }
                this.streamAvailable = this.stream.write(data);
            } else {
                this.setState(device != '' ? `dante.${device}.info.connection` : 'info.connection', false, true);
                if (!this.fileSend) {
                    const bufSize = this.sendBuffer.push(data);
                    this.log.warn(
                        `streamSend(): Extron push data to the send buffer: "${this.decodeBufferToLog(data)}" new buffersize:${bufSize}`,
                    );
                } else {
                    const bufSize = Array.from(this.fileBuffer).push(data);
                    this.log.warn(`streamSend(): Extron push data to the file buffer: new buffersize:${bufSize}`);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'streamSend');
            this.device.connectionState = 'FAILED';
            //this.clientReConnect();
        }
    }

    /**
     * called if stream receives data
     *
     * @param {string | Uint8Array} data the received data
     */
    async onStreamData(data) {
        let members = [];
        const userFileList = [];
        const device = this.devices[this.config.device].short;

        this.streamAvailable = true; // if we receive data the stream is available
        if (this.fileSend) {
            return;
        } // do nothing during file transmission
        try {
            this.log.debug(`onStreamData(): received buffer: "${this.decodeBufferToLog(data)}"`);
            data = data.toString(); // convert buffer to String
            //this.log.debug(`onStreamData(): received data: "${this.decodeBufferToLog(data)}"`);

            if (!this.isDeviceChecked) {
                // the first data has to be the banner with device info
                if (data.includes(this.devices[this.config.device].pno)) {
                    this.isDeviceChecked = true;
                    this.log.info(`onStreamData(): Device "${this.devices[this.config.device].model}" verified`);
                    // this.setState('info.connection', true, true);
                    if (this.config.type === 'ssh') {
                        if (!this.isVerboseMode) {
                            // enter the verbose mode
                            this.sendVerboseMode();
                            return;
                        }
                    }
                } else {
                    throw {
                        message: 'Device mismatch error',
                        stack: 'Please recreate the instance or connect to the correct device',
                    };
                }
                //return;
            }
            if (this.config.type === 'telnet') {
                if (data.includes('Password:')) {
                    this.isLoggedIn = false;
                    this.isVerboseMode = false;
                    this.setState('info.connection', false, true);
                    this.log.info('onStreamData(): Extron received Telnet Password request');
                    this.streamSend(`${this.config.pass}\r`);
                    return;
                }
                if (data.includes('Login Administrator')) {
                    this.isLoggedIn = true;
                    this.log.info('onStreamData(): Extron Telnet logged in');
                    this.setState('info.connection', true, true);
                    if (!this.isVerboseMode) {
                        this.sendVerboseMode();
                    } // enter the verbose mode
                    return;
                }
            }
            const deviceMatch = data.match(/(?:Expr[al]) ((.+\r\n)+)\r\n/gim); // check for multiline devicelist
            if (deviceMatch) {
                this.log.debug(`onStreamData(): deviceMatch ${JSON.stringify(deviceMatch)}`);
                for (const matchLst of deviceMatch) {
                    this.log.debug(`onStreamData(): matchLst: ${matchLst}`);
                    let replaceLst = matchLst.replace(/\r\n/g, '*'); // reformat devicelist
                    replaceLst = replaceLst.replace('**', '\r\n'); // to a single line item
                    this.log.debug(`onStreamData(): replaceLst: ${replaceLst}`);
                    data = data.replace(matchLst, replaceLst); // replace multiline devicelist with single line item
                }
            }
            // iterate through multiple answers connected via [LF]
            const answers = data.split('\n');
            this.log.debug(`onStreamData(): received answers: ${JSON.stringify(answers)}`);
            for (let answer of answers) {
                answer = answer.replace(/[\r\n]/gm, ''); // remove [CR] and [LF] from string

                if (answer.match(/\.\w{3} /) || this.requestDir) {
                    if (answer.endsWith('Bytes Left')) {
                        this.log.info(`onStreamData(): received freespace: "${answer.match(/\d+/)}"`);
                        this.requestDir = false; // directory list has been received, clear flag
                        this.fileList.freeSpace = Number(answer.match(/\d+/)); // set freeSpace in list
                        this.setUserFilesAsync(userFileList); // call subroutine to set database values
                    } else {
                        this.requestDir = true;
                        this.log.info(`onStreamData(): received file data: "${answer}"`);
                        userFileList.push(answer);
                    }
                } else if (answer.startsWith('TvprG') || this.requestPresets) {
                    this.requestPresets = true;
                    this.presetList += answer;
                    if (answer.match(/"name":".*"\}\]$/) || answer.match(/TvprG\[\]/)) {
                        this.log.debug(`onStreamData: end of presetList detected`);
                        this.requestPresets = false;
                        this.presetList = this.presetList.match(/(?!TvprG)(\[({".*"})*\])|(\[\])/)[0];
                        this.setPresets(this.presetList);
                    }
                } else {
                    // lookup the command
                    // const matchArray = answer.match(/([A-Z][a-z]+[A-Z]|\w{3})(\d*)\*?,? ?(.*)/i);    // initial separation detecting eg. "DsG60000*-10"
                    const matchArray = answer.match(
                        /({(dante)@(.*)})?([A-Z][a-z]{1,3}[A-Z]|E|\w{3})([\w-]*|\d*),?\*? ?(.*)/i,
                    ); // extended to detect DANTE remote responses eg. "{dante@AXI44-92efe7}DsG60000*-10"
                    //matchArray[           0        1    2      3                 4                      5              6
                    if (matchArray) {
                        // if any match
                        this.log.debug(`onStreamData() matchArray: "${matchArray}"`);
                        const command = matchArray[4].toUpperCase();
                        const dante = matchArray[2] ? matchArray[2] == 'dante' : false;
                        const danteDevice = matchArray[3];
                        const ext1 = matchArray[5] ? matchArray[5] : '';
                        const ext2 = matchArray[6] ? matchArray[6] : '';

                        this.log.debug(
                            `onStreamData(): ${dante ? `"${danteDevice}" ` : ''}command "${command}", ext1 "${ext1}", ext2 "${ext2}"`,
                        );

                        this.pollCount = 0; // reset pollcounter as valid data has been received

                        switch (command) {
                            case 'E': // Error handling
                                this.log.warn(
                                    `onStreamData(): Error response from ${dante ? `danteDevice ${danteDevice}` : 'device'} '${command}${ext1}': ${errCodes[command + ext1]}}`,
                                );
                                break;

                            case 'VRB': // verbose mode change
                                this.log.info(
                                    `onStreamData(): ${dante ? `danteDevice ${danteDevice}` : 'device'} entered verbose mode: "${ext1}"`,
                                );
                                if (dante) {
                                    this.setVerboseMode(danteDevice);
                                } else {
                                    this.setVerboseMode();
                                }
                                break;

                            case 'VER': // received a Version (answer to status query)
                                switch (ext1) {
                                    case '00':
                                        this.log.debug(
                                            `onStreamData(): received ${dante ? `"${danteDevice}" ` : ''}detailed firmware version: "${ext2}"`,
                                        );
                                        break;

                                    case '01':
                                        this.log.debug(
                                            `onStreamData(): received ${dante ? `"${danteDevice}" ` : ''}firmware version: "${ext2}"`,
                                        );
                                        if (dante) {
                                            this.danteDevices[danteDevice].version = `${ext2}`;
                                        } else {
                                            this.device.version = `${ext2}`;
                                        }
                                        this.log.debug(
                                            `onStreamData(): set ${dante ? `dante.${danteDevice}.` : ''}device.version: "${ext2}"`,
                                        );
                                        if (dante) {
                                            this.setState(`dante.${danteDevice}.device.version`, ext2, true);
                                        } else {
                                            this.setState(`device.version`, ext2, true);
                                        }
                                        break;

                                    case '02':
                                        this.log.debug(
                                            `onStreamData(): received ${dante ? `"${danteDevice}" ` : ''}device description: "${ext2}"`,
                                        );
                                        break;

                                    case '03':
                                        this.log.debug(
                                            `onStreamData(): received ${dante ? `"${danteDevice}" ` : ''}device memory usage: "${ext2}"`,
                                        );
                                        break;

                                    case '04':
                                        this.log.debug(
                                            `onStreamData(): received ${dante ? `"${danteDevice}" ` : ''}user memory usage: "${ext2}"`,
                                        );
                                        break;

                                    case '14':
                                        this.log.debug(
                                            `onStreamData(): received ${dante ? `"${danteDevice}" ` : ''}embedded OS type and version: "${ext2}"`,
                                        );
                                        break;

                                    case '20':
                                        this.log.debug(
                                            `onStreamData(): received ${dante ? `"${danteDevice}" ` : ''}firmware version with build: "${ext2}"`,
                                        );
                                        break;

                                    default:
                                        this.log.warn(
                                            `onStreamData(): received ${dante ? `"${danteDevice}" ` : ''}unknown version information: "${ext2}"`,
                                        );
                                }
                                break;

                            case 'INF': // received device information
                                switch (ext1) {
                                    case '01':
                                        this.log.info(
                                            `onStreamData(): received ${dante ? `dante.${danteDevice}` : 'device'}} model: "${ext2}"`,
                                        );
                                        if (dante) {
                                            this.danteDevices[danteDevice].model = `${ext2}`;
                                        } else {
                                            this.device.model = `${ext2}`;
                                        }
                                        this.log.debug(
                                            `onStreamData(): set ${dante ? `dante.${danteDevice}.` : ''}device.model: "${ext2}"`,
                                        );
                                        this.setState(
                                            `${dante ? `dante.${danteDevice}.` : ''}device.model`,
                                            ext2,
                                            true,
                                        );
                                        break;
                                    case '02':
                                        this.log.info(
                                            `onStreamData(): received ${dante ? `dante.${danteDevice}` : 'device'}  description: "${ext2}"`,
                                        );
                                        if (dante) {
                                            this.danteDevices[danteDevice].description = `${ext2}`;
                                        } else {
                                            this.device.description = `${ext2}`;
                                        }
                                        this.log.debug(
                                            `onStreamData(): set ${dante ? `dante.${danteDevice}.` : ''}device.description: "${ext2}"`,
                                        );
                                        this.setState(
                                            `${dante ? `dante.${danteDevice}.` : ''}device.description`,
                                            ext2,
                                            true,
                                        );
                                        break;
                                    default:
                                        this.log.warn(
                                            `onStreamData(): received ${dante ? `"${danteDevice}" ` : ''}unknown information: "${ext2}"`,
                                        );
                                }
                                break;

                            case 'IPN': // received a device name
                                this.log.info(`onStreamData(): received ${dante ? 'dante ' : ''}devicename: "${ext2}"`);
                                if (dante) {
                                    this.danteDevices[danteDevice].name = `${ext2}`;
                                } else {
                                    this.device.name = `${ext2}`;
                                }
                                this.log.debug(
                                    `onStreamData(): set ${dante ? `dante.${danteDevice}.` : ''}device.name: "${ext2}"`,
                                );
                                this.setState(`${dante ? `dante.${danteDevice}.` : ''}device.name`, ext2, true);
                                break;

                            case 'PNO': // received Part Number
                                this.log.info(
                                    `onStreamData(): received ${dante ? `dante ${danteDevice} ` : 'device '}partnumber: "${ext1}"`,
                                );
                                this.setDevicePartnumber(dante ? danteDevice : '', ext1);
                                break;

                            // DSP SIS commands
                            case 'DSA': // dynamics attack
                                this.log.info(
                                    `onStreamData(): received attack time change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                );
                                break;

                            case 'DSB':
                                if (ext1.startsWith('460')) {
                                    // AEC Block
                                    this.log.info(
                                        `onStreamData(): received AEC config  change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            case 'DSC':
                                if (ext1.startsWith('460')) {
                                    // AEC Block
                                    this.log.info(
                                        `onStreamData(): received AEC config  change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            case 'DSD':
                                if (ext1.startsWith('400')) {
                                    // input source control
                                    this.log.info(
                                        `onStreamData(): received source ${command} from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setSource(ext1, ext2);
                                } else if (ext1.startsWith('450')) {
                                    // input delay value change
                                    this.log.info(
                                        `onStreamData(): received delay value change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}samples"`,
                                    );
                                } else if (ext1.startsWith('590')) {
                                    // input automixer group change
                                    this.log.info(
                                        `onStreamData(): received automix group change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('600')) {
                                    // aux output target change
                                    this.log.info(
                                        `onStreamData(): received aux output target change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setSource(ext1, ext2);
                                } else if (ext1.startsWith('650')) {
                                    // output delay value change
                                    this.log.info(
                                        `onStreamData(): received delay value change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}samples"`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            case 'DSE': // DSP block bypass change
                                if (ext1.startsWith('41')) {
                                    // input filter block
                                    this.log.info(
                                        `onStreamData(): received input filter block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDspBlockStatus(ext1, ext2);
                                } else if (ext1.startsWith('44')) {
                                    // input dynamics block
                                    this.log.info(
                                        `onStreamData(): received input dynamics block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDspBlockStatus(ext1, ext2);
                                } else if (ext1.startsWith('450')) {
                                    // input delay block
                                    this.log.info(
                                        `onStreamData(): received input delay block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDspBlockStatus(ext1, ext2);
                                } else if (ext1.startsWith('460')) {
                                    // input aec block
                                    this.log.info(
                                        `onStreamData(): received input aec block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDspBlockStatus(ext1, ext2);
                                } else if (ext1.startsWith('480')) {
                                    // input ducker block
                                    this.log.info(
                                        `onStreamData(): received input ducker block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDspBlockStatus(ext1, ext2);
                                } else if (ext1.startsWith('51')) {
                                    // output filter block
                                    this.log.info(
                                        `onStreamData(): received output filter block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDspBlockStatus(ext1, ext2);
                                } else if (ext1.startsWith('52')) {
                                    // output feedback suppressor filter block
                                    this.log.info(
                                        `onStreamData(): received output feedback suppressor filter block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDspBlockStatus(ext1, ext2);
                                } else if (ext1.startsWith('530')) {
                                    // output feedback suppressor block
                                    this.log.info(
                                        `onStreamData(): received output feedback suppressor block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDspBlockStatus(ext1, ext2);
                                } else if (ext1.startsWith('540')) {
                                    // output dynamics filter block
                                    this.log.info(
                                        `onStreamData(): received output dynamics block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDspBlockStatus(ext1, ext2);
                                } else if (ext1.startsWith('550')) {
                                    // output delay block
                                    this.log.info(
                                        `onStreamData(): received output delay block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDspBlockStatus(ext1, ext2);
                                } else if (ext1.startsWith('56')) {
                                    // input ducker source block
                                    this.log.info(
                                        `onStreamData(): received input ducker source enabled change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('57')) {
                                    // input ducker source block
                                    this.log.info(
                                        `onStreamData(): received input ducker source enabled block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('590')) {
                                    // input automix block
                                    this.log.info(
                                        `onStreamData(): received input automix block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('61')) {
                                    // output filter block
                                    this.log.info(
                                        `onStreamData(): received output filter block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('640')) {
                                    // output dynamics block
                                    this.log.info(
                                        `onStreamData(): received output dynamics block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('650')) {
                                    // output delay block
                                    this.log.info(
                                        `onStreamData(): received output delay block bypass change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            case 'DSF': // filter frequency change
                                this.log.info(
                                    `onStreamData(): received filter frequency change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                );
                                break;

                            case 'DSG': // received a gain level change
                                this.log.info(
                                    `onStreamData(): received mute/gain ${command} from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                );
                                this.setGain(command, ext1, ext2);
                                break;

                            case 'DSH':
                                if (ext1.startsWith('400')) {
                                    // digital input gain level change
                                    this.log.info(
                                        `onStreamData(): received gain ${command} from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                    );
                                    this.setGain(command, ext1, ext2);
                                } else if (ext1.startsWith('440')) {
                                    // input dynamics hold time change
                                    this.log.info(
                                        `onStreamData(): received hold time change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('540')) {
                                    // input dynamics hold time change
                                    this.log.info(
                                        `onStreamData(): received hold time change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('640')) {
                                    // output dynamics hold time change
                                    this.log.info(
                                        `onStreamData(): received hold time change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            case 'DSJ':
                                if (ext1.startsWith('400')) {
                                    // input config change
                                    this.log.info(
                                        `onStreamData(): received input config change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                    );
                                } else if (ext1.startsWith('590')) {
                                    // input DSP config change
                                    this.log.info(
                                        `onStreamData(): received DSP block config change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                    );
                                } else if (ext1.startsWith('600')) {
                                    // output config change
                                    this.log.info(
                                        `onStreamData(): received output config change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            case 'DSK': // dynamics knee
                                this.log.info(
                                    `onStreamData(): received dynamic knee change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                );
                                break;

                            case 'DSL': // dynamics release
                                this.log.info(
                                    `onStreamData(): received release time change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                );
                                break;

                            case 'DSM': // received a mute command
                                this.log.info(
                                    `onStreamData(): received mute ${command} from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                );
                                this.setGain(command, ext1, ext2);
                                break;

                            case 'DSN':
                                if (ext1.startsWith('460')) {
                                    // digital input AEC config change
                                    this.log.info(
                                        `onStreamData(): received input AEC config change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                    );
                                } else if (ext1.startsWith('590')) {
                                    // input automix config change
                                    this.log.info(
                                        `onStreamData(): received input automix config change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            case 'DSO': // filter slope 0=6dB/O, 1=12dB/O ... 7=48dB/O
                                this.log.info(
                                    `onStreamData(): received filter slope change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${6 + Number(ext2) * 6}dB/O"`,
                                );
                                break;

                            case 'DSP':
                                if (ext1.startsWith('2')) {
                                    // mixpoint automixer status change
                                    this.log.info(
                                        `onStreamData(): received mixpoint automixer status change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('400')) {
                                    // input polarity change
                                    this.log.info(
                                        `onStreamData(): received input polarity change change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('590')) {
                                    // input automixer last mic change
                                    this.log.info(
                                        `onStreamData(): received automix last mic change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('600')) {
                                    // output polarity change
                                    this.log.info(
                                        `onStreamData(): received output polarity change change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: "${ext2}"`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            case 'DSQ': // filter q-factor change
                                this.log.info(
                                    `onStreamData(): received filter Q-factor change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${Number(ext2) / 1000}"`,
                                );
                                break;

                            case 'DSR': // dynamics ratio
                                this.log.info(
                                    `onStreamData(): received ratio change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                );
                                break;

                            case 'DST':
                                if (ext1.startsWith('44')) {
                                    // input dynamics threshold change
                                    this.log.info(
                                        `onStreamData(): received a threshold change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                    this.setDynamicsThreshold(ext1, ext2);
                                } else if (ext1.startsWith('450')) {
                                    // input delay reference temperature change
                                    this.log.info(
                                        `onStreamData(): received a delay ref temperature change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}°F"`,
                                    );
                                } else if (ext1.startsWith('480')) {
                                    // input dynamics threshold change
                                    this.log.info(
                                        `onStreamData(): received a threshold change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}°F"`,
                                    );
                                } else if (ext1.startsWith('540')) {
                                    // input dynamics threshold change
                                    this.log.info(
                                        `onStreamData(): received a threshold change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}°F"`,
                                    );
                                } else if (ext1.startsWith('550')) {
                                    // input delay reference temperature change
                                    this.log.info(
                                        `onStreamData(): received a delay ref temperature change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}°F"`,
                                    );
                                } else if (ext1.startsWith('590')) {
                                    // input dynamics threshold change
                                    this.log.info(
                                        `onStreamData(): received a threshold change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}°F"`,
                                    );
                                } else if (ext1.startsWith('640')) {
                                    // output dynamics block
                                    this.log.info(
                                        `onStreamData(): received output dynamics threshold change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('650')) {
                                    // output delay reference temperature change
                                    this.log.info(
                                        `onStreamData(): received a delay ref temperature change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}°F"`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            case 'DSU': // delay unit change 0=samples, 1=ms, 2=fuß, 3=m
                                this.log.info(
                                    `onStreamData(): received delay unit change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                );
                                break;

                            case 'DSV': // unsolicited volume/meter level
                                break;

                            case 'DSW': // AGC target window
                                if (ext1.startsWith('44')) {
                                    // input dynamics block
                                    this.log.info(
                                        `onStreamData(): received input AGC window change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('540')) {
                                    // virtual return dynamics block
                                    this.log.info(
                                        `onStreamData(): received virtual return AGC window change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                } else if (ext1.startsWith('640')) {
                                    // output dynamics block
                                    this.log.info(
                                        `onStreamData(): received output AGC window change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value: "${ext2}"`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            case 'DSY': // DSP block type change
                                // dyn 0=no, 1=cmp, 2=lim, 3=gate, 4=agc
                                // filter 0=no, 1= HP Butterworth, 2 = LP Butterworth, 3= Bass/Treble, 4= pra. EQ, 5= notvh EQ, 6=HP Bessel, 7= LP Bessel, 8= HP Linkwitz, 9= LP Linkwitz, 10 = Loudness
                                this.log.info(
                                    `onStreamData(): received DSP block type change from ${dante ? `"${danteDevice}" ` : ''}OID : "${ext1}" value "${ext2}"`,
                                );
                                this.setDspBlockType(ext1, ext2);
                                break;

                            case 'DSZ':
                                if (ext1.startsWith('2')) {
                                    // mixPoint processing bypass change
                                    this.log.info(
                                        `onStreamData(): processing bypass status change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                    );
                                } else if (ext1.startsWith('400')) {
                                    // input phantom power change
                                    this.log.info(
                                        `onStreamData(): Phantom power status change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                    );
                                } else if (ext1.startsWith('590')) {
                                    // input automixer status change
                                    this.log.info(
                                        `onStreamData(): automixer status change from ${dante ? `"${danteDevice}" ` : ''}OID: "${ext1}" value: ${ext2}`,
                                    );
                                } else {
                                    this.log.warn(
                                        `onStreamData(): unknown OID: "${ext1}" for ${dante ? `"${danteDevice}" ` : ''}command: "${command}"`,
                                    );
                                }
                                break;

                            // player commands
                            case 'PLAY': //received a play mode command
                                this.log.info(
                                    `onStreamData(): received play mode ${command} for Player: "${ext1}" value: "${ext2}"`,
                                );
                                this.setPlayMode(ext1, ext2);
                                break;

                            case 'CPLYA': //received a file association change
                                this.log.info(
                                    `onStreamData(): received filename for Player: "${ext1}" value: "${ext2}"`,
                                );
                                this.setFileName(ext1, ext2);
                                break;

                            case 'CPLYM': //received a set repeat mode change
                                this.log.info(
                                    `onStreamData(): received repeat mode ${command} for Player: "${ext1}" value: "${ext2}"`,
                                );
                                this.setRepeatMode(ext1, ext2);
                                break;

                            case 'IN0': // received HDMI Input Signal status change
                                if (device === 'sme211') {
                                    this.log.info(`onStreamData(): received HDMI input signal change: "${ext2}"`);
                                    this.setState('player.hdmistatus', Number(ext2), true);
                                }
                                break;
                            case 'IN1': // received a tie change from CrossPoint
                            case 'IN2':
                            case 'IN3':
                            case 'IN4':
                            case 'IN5':
                            case 'IN6':
                            case 'IN7':
                            case 'IN8':
                                this.log.info(`onStreamData(): received tie command ${command} for output: ${ext2}`);
                                this.setTie(command, ext2);
                                break;

                            case 'LOUT': // received a tie change for loop out
                                this.log.info(`onStreamData(): received tie command input "${ext1}" to loop output`);
                                this.setState(`connections.3.tie`, Number(ext1), true);
                                break;

                            case 'VMT': // received a video mute change
                                if (device === 'sme211') {
                                    this.log.info(`onStreamData(): received video mute change "${ext1}"`);
                                    this.setState(`connections.1.mute`, Number(ext1), true);
                                } else {
                                    this.log.info(
                                        `onStreamData(): received video mute change for output "${ext1}" value "${ext2}"`,
                                    );
                                    this.setState(`connections.${ext1}.mute`, Number(ext2), true);
                                }
                                break;

                            // Begin SMD202 specific commands
                            case 'PLYRS': // received video play change
                                this.log.info(
                                    `onStreamData(): received video playmode for player "${ext1}" value "${ext2}"`,
                                );
                                this.setPlayVideo(`player.`, ext1, 2 - Number(ext2));
                                break;

                            case 'PLYRE': // received Video pause change
                                this.log.info(
                                    `onStreamData(): received video paused for player "${ext1}" value "${ext2}"`,
                                );
                                this.setPlayVideo(`player.`, ext1, 2);
                                break;

                            case 'PLYRO': // received video stopped
                                this.log.info(
                                    `onStreamData(): received video stopped for player "${ext1}" value "${ext2}"`,
                                );
                                this.setPlayVideo(`player.`, ext1, 0);
                                break;

                            case 'PLYRR': // received loop state change
                                this.log.info(
                                    `onStreamData(): received video loop mode for player "${ext1}" value "${ext2}"`,
                                );
                                this.setLoopVideo(`player.`, ext1, ext2);
                                break;

                            case 'PLYRU': // received video filepath change
                                this.log.info(
                                    `onStreamData(): received video video filepath for player "${ext1}" value "${ext2}"`,
                                );
                                this.setVideoFile(`player.`, ext2);
                                this.getChannel();
                                break;

                            case 'PLYRY': // received paymode change
                                this.log.info(
                                    `onStreamData(): received video playmode for player "${ext1}" value "${ext2}"`,
                                );
                                this.setPlayVideo(`player.`, ext1, Number(ext2));
                                break;

                            case 'PLYRL': // received playlist change
                                this.log.info(
                                    `onStreamData(): received current playlist for player "${ext1}" value "${ext2}", requesting filepath`,
                                );
                                this.getVideoFile();
                                break;

                            case 'TVPRT': // received TV channelchange
                                this.log.info(
                                    `onStreamData(): received current channel for player "${ext1}" value "${ext2}"`,
                                );
                                this.setChannel(`player.`, ext2);
                                break;

                            case 'TVPRG': // received channel list change
                                this.log.info(`onStreamData(): received Preset list`);
                                this.setPresets(ext2);
                                break;

                            case 'AMT': // received audio mue change
                                this.log.info(`onStreamData(): received Audio Output mute status value "${ext1}"`);
                                this.setMute('output.attenuation.', Number(ext1));
                                break;

                            case 'VOL': // received audio attenuation chnange
                                this.log.info(
                                    `onStreamData(): received Audio Output attenuation level value "${Number(`${ext1}${ext2}`)}"`,
                                );
                                this.setVol(
                                    'output.attenuation.',
                                    this.calculateFaderValue(Number(`${ext1}${ext2}`), 'logAtt'),
                                );
                                break;

                            case 'SUBTE': // received subtitle display change
                                break;

                            // End SMD202 specific commands
                            // SME211 specific commands
                            case 'STRM':
                            case 'STRMY':
                                this.log.info(`onStreamData(): received streammode "${ext1}"`);
                                this.setStreamMode(`player.`, Number(ext1));
                                break;

                            case 'STRCE':
                                this.log.info(`onStreamData(): received stream state change "${ext1}", "${ext2}"`);
                                this.setStreamState(Number(ext1), Number(ext2));
                                break;

                            // end SME211 specific commands
                            // Begin FIle transmission commands
                            case 'DEL':
                                this.log.info(
                                    `onStreamData(): received file deletion confirmation command "${ext1}" name: "${ext2}"`,
                                );
                                this.setState('fs.del', '', true); // clear filename for deletion
                                this.setState('fs.dir', true, false); // request directory update
                                break;
                            case 'UPL':
                                this.fileSend = false; // reset file transmission flag
                                this.log.info(
                                    `onStreamData(): received upload file confirmation command size: "${ext1}" name: "${ext2}"`,
                                );
                                this.setState('fs.upl', '', true); // reset upload file
                                this.setState('fs.dir', true, false); // request directory update
                                break;

                            case 'WDF':
                                this.log.info(`onStreamData(): received list directory command`);
                                //this.requestDir = true;     // set directory transmission flag
                                break;

                            case 'W+UF':
                                this.log.info(`onStreamData(): received upload file command: ${ext1} ${ext2}`);
                                this.fileSend = true; // set file transmission flag
                                break;

                            // End file transmission commands
                            // begin group commands
                            case 'GRPMZ': // delete Group command
                                this.log.info(`onStreamData(): received group #${ext1} deleted`);
                                this.grpDelPnd[Number(ext1)] = false; // flag group deletion confirmation
                                this.setState(`groups.${ext1.padStart(2, '0')}.deleted`, true, true); // confirm group deletion in database
                                this.setGroupMembers(Number(ext1), []);
                                this.sendGrpCmdBuf(Number(ext1)); // process group commands queued during pending deletion
                                break;

                            case 'GRPMD': // set Group fader value
                                this.log.info(
                                    `onStreamData(): received group #${ext1} ${this.groupTypes[Number(ext1)] == 12 ? 'Mute' : 'fader'} value:"${ext2}"`,
                                );
                                this.setGroupLevel(Number(ext1), Number(ext2));
                                break;

                            case 'GRPMP': // set Group type
                                this.log.info(`onStreamData(): received group #${ext1} type: "${ext2}"`);
                                this.setGroupType(Number(ext1), Number(ext2));
                                break;

                            case 'GRPMO': // add group member
                                members = ext2.split('*');
                                this.log.info(`onStreamData(): received group #${ext1} member(s): "${members}"`);
                                this.setGroupMembers(Number(ext1), members);
                                break;

                            case 'GRPML': // set group limits
                                this.log.info(
                                    `onStreamData(): received group #${ext1} limits upper: "${ext2.split('*')[0]}" lower: "${ext2.split('*')[1]}""`,
                                );
                                this.setGroupLimits(
                                    Number(ext1),
                                    Number(ext2.split('*')[0]),
                                    Number(ext2.split('*')[1]),
                                );
                                break;

                            case 'GRPMN': // group name
                                this.log.info(`onStreamData(): received group #${ext1} name: "${ext2}"`);
                                this.setGroupName(Number(ext1), ext2);
                                break;

                            // I/O naming commands
                            case 'NMI': // I/O Name
                            case 'NML':
                            case 'NEI':
                            case 'NMO':
                            case 'NEX':
                            case 'EXPDA':
                                this.log.info(
                                    `onStreamData(): received I/O Name "${ext2}" for I/O: "${this.oid2id(`${command}${ext1}`)}"`,
                                );
                                this.setIOName(`${command}${ext1}`, ext2);
                                break;

                            case 'CNFG': // configuration
                                switch (ext2) {
                                    case '0': // configuration restored
                                        this.log.info(
                                            `onStreamData(): IP configuration ${ext1 == '0' ? 'restored' : 'saved'}`,
                                        );
                                        break;
                                    case '2': // configuration saved
                                        this.log.info(
                                            `onStreamData(): device configuration ${ext1 == '0' ? 'restored' : 'saved'}`,
                                        );
                                        break;
                                    default:
                                        this.log.warn(`onStreamData(): unknown configuration ${ext1}, ${ext2} `);
                                }
                                break;

                            case 'PSAV': // Power / Standby status
                                this.log.info(
                                    `onStreamData(): received power mode: "${ext1}", standby mode: "${ext2}"`,
                                );
                                break;

                            // Dante control and configuration commands
                            case 'NEXPD': // DANTE devicename
                                this.log.info(`onStremData(): received Dante deviceName "${ext2}"`);
                                break;

                            case 'EXPRA': // available DANTE devices
                                this.log.info(
                                    `onStreamData(): received available remote devices: [${ext2.split('*')}]`,
                                );
                                this.setDanteDevices(ext2.split('*'));
                                this.checkConfiguredRemoteDevices();
                                break;

                            case 'EXPDK': // device status
                                this.log.info(
                                    `onStreamData(): received ${dante ? `"${danteDevice}" ` : ''}device status: "${ext2}"`,
                                );
                                break;

                            case 'EXPRC': // DANTE connection status
                                this.log.info(
                                    `onStreamData(): DANTE connection to remote device: ${ext1}, ${ext2 == '1' ? 'established' : 'disconnected'} `,
                                );
                                this.setDanteConnection(ext1, ext2 == '1');
                                if (ext2 == '1') {
                                    this.sendVerboseMode(ext1); // switch device to verbose mode
                                    this.getDevicePartnumber(ext1); // request device part number
                                }
                                this.listDanteConnections();
                                break;

                            case 'EXPRL': // list of DANTE connected devices
                                this.log.info(
                                    `onStreamData(): Extron listening to remote devices: [${ext2.split('*')}]`,
                                );
                                this.setDanteConnections(ext2.split('*'));
                                if (ext2.length) {
                                    for (const device of ext2.split('*')) {
                                        this.getDevicePartnumber(device);
                                    }
                                }
                                break;

                            case 'DANTE':
                                this.log.info(
                                    `onStreamData(): received DANTE relay command response: device:"${ext1}", command:"${ext2}"`,
                                );
                                break;
                        }
                    } else {
                        if (
                            answer != 'Q' &&
                            answer != '' &&
                            this.fileSend === false &&
                            !answer.match(/\d\*\d\w+/) &&
                            !answer.match(/\d\w/)
                        ) {
                            this.log.warn(`onStreamData(): Extron received data which cannot be handled "${answer}"`);
                        }
                    }
                }
            }
        } catch (err) {
            this.errorHandler(err, 'onStreamData');
            // @ts-expect-error err.message exists
            if (err.message === 'Device mismatch error') {
                this.log.debug('onStreamData(): device mismatch ... terminating');
                if (typeof this.terminate === 'function') {
                    this.terminate(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
                } else {
                    process.exit(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
                }
            }
        }
    }

    /**
     * called if stream receives data
     *
     * @param {string | Uint8Array} data the data to decode
     */
    decodeBufferToLog(data) {
        try {
            let retString = '';
            let dataString = '';
            if (typeof data === 'string') {
                dataString = data;
            } else {
                dataString = data.toString();
            }
            for (let i = 0; i < dataString.length; i++) {
                switch (dataString.charCodeAt(i)) {
                    case 10:
                        retString += '[LF]';
                        break;

                    case 13:
                        retString += '[CR]';
                        break;

                    case 27:
                        retString += '[ESC]';
                        break;

                    case 127:
                        retString += '[DEL]';
                        break;

                    default:
                        retString += dataString[i];
                        break;
                }
            }
            return retString;
        } catch (err) {
            this.errorHandler(err, 'decodeBufferToLog');
        }
    }

    /**
     * called if stream is ready to send new data
     */
    async onStreamContinue() {
        try {
            this.log.debug('onStreamContinue(): Extron stream can continue');
            this.streamAvailable = true;
            this.setState('info.connection', true, true);
            if (this.fileSend) {
                this.log.debug(`onStreamContinue(): flushing sendBuffer "${this.sendBuffer.length}"`);
                while (this.sendBuffer.length && this.streamAvailable) {
                    this.streamSend(this.sendBuffer.shift());
                }
            } else {
                this.log.debug(`onStreamContinue(): flushing fileBuffer "${this.fileBuffer.byteLength}"`);
                while (Array.from(this.fileBuffer).length && this.streamAvailable) {
                    this.streamSend(Array.from(this.fileBuffer).shift());
                }
            }
        } catch (err) {
            this.errorHandler(err, 'onStreamContinue');
        }
    }

    /**
     * called if stream receives an error
     *
     * @param {any} err the error occured
     */
    onStreamError(err) {
        this.errorHandler(err, 'onStreamError');
        this.log.warn('onStreamError(): Extron is calling clientReConnect');
        this.device.connectionState = 'FAILED';
        //this.clientReConnect();
    }

    /**
     * called if stream is closed
     */
    onStreamClose() {
        this.log.debug('onStreamClose(): stream closed');
    }

    /**
     * called to switch the verbose mode
     *
     * @param {string | void} device
     * cmd = 3CV
     */
    sendVerboseMode(device = '') {
        try {
            this.log.debug(`sendVerboseMode(): Extron switching ${device} to verbose mode 3`);
            this.streamSend('W3CV\r', device);
            if (this.devices[this.config.device].short === 'smd202') {
                this.log.debug(`sendVerboseMode(): Extron disabling subtitle display`);
                this.streamSend('WE1*0SUBT\r');
            }
        } catch (err) {
            this.errorHandler(err, 'sendVerboseMode');
        }
    }

    /**
     * called to request the verbose mode
     *
     * @param {string | void} device
     * cmd = CV
     */
    getVerboseMode(device = '') {
        try {
            this.log.debug(`getVerboseMode(): requesting ${device} verbose mode 3`);
            this.streamSend('WCV\r', device);
        } catch (err) {
            this.errorHandler(err, 'getVerboseMode');
        }
    }

    /**
     * called when device entered verbose mode
     *
     * @param {string | void} device the device to set the verbode mode
     */
    async setVerboseMode(device = '') {
        try {
            if (device != '') {
                this.log.debug(`setVerboseMode(): DANTE device "${device}" set verbose mode`);
                this.danteDevices[device].isVerboseMode = true;
            } else {
                this.log.debug('setVerboseMode(): Extron device set verbose mode');
                this.isVerboseMode = true;
                if (!this.initDone) {
                    this.streamSend('Q'); // query Version
                    this.getModel(); // query Model
                    this.getDescription(); // query Description
                    this.getDeviceName(); // query deviceName
                    this.getDevicePartnumber(); // query partnumber
                    this.initDone = true;
                    //this.timers.timeoutQueryStatus.refresh();
                    if (this.config.pushDeviceStatus === true) {
                        await this.setDeviceStatusAsync();
                    } else {
                        await this.getDeviceStatusAsync();
                        //this.log.info('Extron get device status diabled ');
                    }
                }
            }
        } catch (err) {
            this.errorHandler(err, 'setVerboseMode');
        }
    }

    /**
     * called to request device model
     *
     * @param {string | void} device
     * cmd = 1I
     */
    getModel(device = '') {
        try {
            this.log.debug(`getModel(): requesting ${device} model`);
            this.streamSend('1I\r', device);
        } catch (err) {
            this.errorHandler(err, 'getModel');
        }
    }

    /**
     * called to request devicename
     *
     * @param {string | void} device
     * cmd = CN, NEXPD when DANTE
     */
    getDeviceName(device = '') {
        try {
            this.log.debug(`getDeviceName(): requesting ${device} name`);
            if (device != '') {
                this.streamSend('WNEXPD\r', device);
            } else {
                this.streamSend('WCN\r');
            }
        } catch (err) {
            this.errorHandler(err, 'getDeviceName');
        }
    }

    /**
     * called to request device description
     *
     * @param {string | void} device
     * cmd = 2I
     */
    getDescription(device = '') {
        if (device != '' && !this.danteDevices[device].model.startsWith('AXI')) {
            // AXI devices do not support "2I" SIS command
            try {
                this.log.debug(`getDescription(): requesting ${device} description`);
                this.streamSend('2I\r', device);
            } catch (err) {
                this.errorHandler(err, 'getDescription');
            }
        }
    }

    /**
     * called to send a status query
     * cmd = Q
     */
    queryStatus() {
        try {
            if (this.pollCount > this.maxPollCount) {
                this.log.warn('queryStatus(): maxPollCount exceeded, closing connection');
                this.pollCount = 0;
                /*switch (this.config.type) {
                    case 'telnet':
                        this.net.destroy();     // close the connection
                        break;
                    case 'ssh' :
                        break;
                }*/
                this.device.connectionState = 'FAILED';
            } else {
                //if (typeof this.timers.timeoutQueryStatus !== 'undefined') this.timers.timeoutQueryStatus.refresh();
                if (!this.fileSend) {
                    if (this.pollCount) {
                        this.log.debug(`queryStatus(): Extron send query poll #${this.pollCount}`);
                    }
                    this.streamSend('Q');
                    for (const device of Object.keys(this.danteDevices)) {
                        if (this.danteDevices[device].connectionState == 'CONNECTED') {
                            this.streamSend('Q', device);
                        }
                    }
                    this.pollCount += 1;
                }
            }
        } catch (err) {
            this.errorHandler(err, 'queryStatus');
        }
    }

    /**
     * called to set instance name in database
     */
    async setInstanceNameAsync() {
        try {
            // get current instance object
            const instanceObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            //this.log.info(`setInstanceNameAsync(): ${JSON.stringify(instanceObj)}`);

            if (typeof instanceObj.common.title != 'undefined') {
                delete instanceObj.common.title;
            } // marked as deprecated so delete if present
            // add deviceName to instance object common.titleLang
            switch (typeof instanceObj.common.titleLang) {
                case 'string': // shold never occur, js-controller issue filed 20240606
                    if (!instanceObj.common.titleLang.includes(this.devices[this.config.device].model)) {
                        instanceObj.common.titleLang = `${this.devices[this.config.device].model}`;
                        this.setForeignObject(`system.adapter.${this.namespace}`, instanceObj);
                        this.log.debug(`setInstanceName(): set titleLang`);
                    }
                    break;
                case 'object':
                    if (!instanceObj.common.titleLang.de.includes(this.devices[this.config.device].model)) {
                        for (const key of Object.keys(instanceObj.common.titleLang)) {
                            instanceObj.common.titleLang[key] = `${this.devices[this.config.device].model}`;
                        }
                        this.setForeignObject(`system.adapter.${this.namespace}`, instanceObj);
                        this.log.debug(`setInstanceName(): set titleLang.xx`);
                    }
                    break;
            }
        } catch (err) {
            this.errorHandler(err, 'setInstanceName');
        }
        this.log.debug(`setInstanceNamec(): completed`);
    }

    /**
     * called to create a device in database
     *
     * @param {string | void } deviceName  // default this.devices[this.config.device].model;
     */
    async createDeviceCommonAsync(deviceName) {
        const baseId = deviceName ? `dante.${deviceName}.` : '';
        const infoObj = JSON.parse(JSON.stringify(this.objectTemplates.info));

        this.log.info(
            `createDeviceCommonAsync(): for device: "${deviceName ? deviceName : this.devices[this.config.device].model}"`,
        );
        try {
            // create the common section
            const deviceObj = JSON.parse(JSON.stringify(this.objectTemplates.common));
            //this.log.warn(`createDeviceCommonAsync(): deviceObj: ${JSON.stringify(deviceObj)}`);
            //if (!deviceName) deviceObj.name = this.devices[this.config.device].model;
            for (const element of deviceObj) {
                await this.setObjectAsync(`${baseId}${element._id}`, element);
            }
            this.log.info(`createDeviceCommonAsync(): created common section`);
            if (baseId.includes('dante.')) {
                for (const element of infoObj) {
                    element._id = `${baseId}${element._id}`;
                    await this.setObjectAsync(element._id, element);
                }
                this.log.info(`createDeviceCommonAsync(): created ${deviceName} info section`);
            }
            if (deviceName) {
                this.log.warn(
                    `createDeviceCommon(): creating ${deviceName} "${JSON.stringify(this.config.remoteDevices.find(device => (device.danteName = deviceName)))}"`,
                );
                this.danteDevices[deviceName] = JSON.parse(
                    JSON.stringify(this.config.remoteDevices.find(device => (device.danteName = deviceName))),
                );
            }
        } catch (err) {
            this.errorHandler(err, 'createDeviceCommonAsync');
        }
    }

    /**
     * called to set up the database according device type
     *
     * @param {string | void } deviceName  // default this.devices[this.config.device].model;
     * {string | void } deviceType  // default this.devices[this.config.device].short;
     */
    async createDatabaseAsync(deviceName) {
        const device = deviceName
            ? Object.keys(this.devices).find(device => this.devices[device].pno == this.danteDevices[deviceName].pno)
            : this.config.device;
        this.log.warn(`createDatabase(): for "${device}"`);
        const deviceType = this.devices[device].short;
        this.log.warn(`createDatabase(): for "${device}", "${deviceType}"`);
        //const deviceObjName = this.devices[device].model;
        const baseId = deviceName ? `dante.${deviceName}.` : '';

        this.log.info(`createDatabaseAsync(): ${deviceName ? deviceName : ''}start`);
        try {
            // add deviceName to database
            //const deviceObj = this.getObjectAsync(`${this.instance}${deviceName?`dante.${deviceName}`:'device'}`);
            //const deviceObj = this.objectTemplates.common[0];
            //deviceObj.common.name = this.devices[device].model;
            //deviceObj.common.name = deviceObjName;
            //await this.setObjectAsync(`${baseId?baseId:'device.'}`, deviceObj);
            this.log.debug(`createDatabaseAsync(): set deviceModel`);

            // if cp82 or sme211 : create video inputs and outputs
            if (deviceType === 'cp82' || deviceType === 'sme211') {
                for (const element of this.objectTemplates[this.devices[device].objects[1]].connections) {
                    await this.setObjectAsync(`${baseId}${element._id}`, element);
                }
            }
            // if smd202 : create video player
            if (deviceType === 'smd202') {
                for (const element of this.objectTemplates[this.devices[device].objects[1]].players) {
                    await this.setObjectAsync(`${baseId}${element._id}`, element);
                }
                for (const element of this.objectTemplates[this.devices[device].objects[1]].outputs) {
                    await this.setObjectAsync(`${baseId}${element._id}`, element);
                }
            }
            // if sme211 : create streaming player
            if (deviceType === 'sme211') {
                for (const element of this.objectTemplates[this.devices[device].objects[1]].players) {
                    await this.setObjectAsync(`${baseId}${element._id}`, element);
                }
            }
            // if we have a user filesystem on the device
            if (this.devices[device] && this.devices[device].objects.includes('userflash')) {
                this.log.info(`createDatabaseAsync(): set user fileSystem`);
                for (const element of this.objectTemplates.userflash) {
                    await this.setObjectAsync(`${baseId}${element._id}`, element);
                }
                this.setState('fs.dir', false, true); // reset directory request flag
            }
            // if we have outputs on the device
            if (this.devices[device] && this.devices[device].out) {
                // at this point the device has outputs
                this.log.info(`createDatabaseAsync(): set outputs`);
                await this.setObjectAsync(`${baseId}out`, {
                    type: 'folder',
                    common: {
                        name: 'All outputs',
                    },
                    native: {},
                });
                for (const outputs of Object.keys(this.devices[device].out)) {
                    // create outputs folder, key name is the folder id
                    await this.setObjectAsync(`${baseId}out.${outputs}`, {
                        type: 'folder',
                        common: {
                            name: this.devices[device].out[outputs].name,
                        },
                        native: {},
                    });
                    // create the amount of outputs
                    for (let i = 1; i <= this.devices[device].out[outputs].amount; i++) {
                        const actOutput = `${baseId}out.${outputs}.${i.toString().padStart(2, '0')}`;
                        // create the output folder
                        await this.setObjectAsync(
                            actOutput,
                            this.objectTemplates[this.devices[device].objects[1]].output,
                        );
                        // and the common structure of a output
                        switch (outputs) {
                            case 'outputs':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]].outputs) {
                                    await this.setObjectAsync(`${actOutput}.${element._id}`, element);
                                }
                                /**
                                if (this.devices[device].out[outputs].dspfunc) {    // if we have DSP blocks on the output
                                    for (const dspfunc of this.devices[device].out[outputs].dspfunc) {
                                        if (dspfunc == 'dsp_flt') {
                                            //
                                        } else {
                                            for (const element of this.objectTemplates[dspfunc]) {
                                                const element_id = actOutput+'.'+element._id;
                                                await this.setObjectAsync(element_id, element);
                                            }
                                        }
                                    }
                                }*
                                 */
                                break;

                            case 'auxOutputs':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]]
                                    .auxOutputs) {
                                    await this.setObjectAsync(`${actOutput}.${element._id}`, element);
                                }
                                break;

                            case 'expansionOutputs':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]]
                                    .expansionOutputs) {
                                    await this.setObjectAsync(`${actOutput}.${element._id}`, element);
                                }
                                break;
                        }
                    }
                }
            }
            // if we have inputs on the device
            if (this.devices[device] && this.devices[device].in) {
                // at this point the device has inputs
                this.log.info(`createDatabaseAsync(): set inputs`);
                await this.setObjectAsync(`${baseId}in`, {
                    type: 'folder',
                    common: {
                        name: 'All input types',
                    },
                    native: {},
                });
                for (const inputs of Object.keys(this.devices[device].in)) {
                    // create input folder, key name is the folder id
                    await this.setObjectAsync(`${baseId}in.${inputs}`, {
                        type: 'folder',
                        common: {
                            name: this.devices[device].in[inputs].name,
                        },
                        native: {},
                    });
                    // for each input type create the amount of inputs
                    for (let i = 1; i <= this.devices[device].in[inputs].amount; i++) {
                        const actInput = `${baseId}in.${inputs}.${i.toString().padStart(2, '0')}`;
                        // create the input folder
                        await this.setObjectAsync(
                            actInput,
                            this.objectTemplates[this.devices[device].objects[1]].input,
                        );
                        // and the common structure of an input depending on type
                        switch (inputs) {
                            case 'inputs':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]].inputs) {
                                    await this.setObjectAsync(`${actInput}.${element._id}`, element);
                                }
                                break;

                            case 'lineInputs':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]]
                                    .lineInputs) {
                                    await this.setObjectAsync(`${actInput}.${element._id}`, element);
                                }
                                break;

                            case 'playerInputs':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]]
                                    .playerInputs) {
                                    await this.setObjectAsync(`${actInput}.${element._id}`, element);
                                }
                                break;

                            case 'programInputs':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]]
                                    .programInputs) {
                                    await this.setObjectAsync(`${actInput}.${element._id}`, element);
                                }
                                break;

                            case 'videoInputs':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]]
                                    .videoInputs) {
                                    await this.setObjectAsync(`${actInput}.${element._id}`, element);
                                }
                                break;

                            case 'auxInputs':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]].auxInputs) {
                                    await this.setObjectAsync(`${actInput}.${element._id}`, element);
                                }
                                break;

                            case 'virtualReturns':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]]
                                    .virtualReturns) {
                                    await this.setObjectAsync(`${actInput}.${element._id}`, element);
                                }
                                break;

                            case 'expansionInputs':
                                for (const element of this.objectTemplates[this.devices[device].objects[1]]
                                    .expansionInputs) {
                                    await this.setObjectAsync(`${actInput}.${element._id}`, element);
                                }
                                break;
                        }
                        // now the mixpoints are created
                        if (this.devices[device] && this.devices[device].mp) {
                            // if we have mixpoints
                            if (inputs != 'videoInputs') {
                                // this.log.debug(`createDatabaseAsync(): set mixpoints`);
                                for (const outType of Object.keys(this.devices[device].out)) {
                                    for (let j = 1; j <= this.devices[device].out[outType].amount; j++) {
                                        if (i === j && outType === 'virtualSendBus') {
                                            continue; // these points cannot be set
                                        }
                                        const actMixPoint = `${actInput}.mixPoints.${
                                            this.devices[device].out[outType].short
                                        }${j.toString().padStart(2, '0')}`;
                                        await this.setObjectAsync(actMixPoint, {
                                            type: 'channel',
                                            common: {
                                                role: 'input.channel',
                                                name: `Mixpoint ${outType} ${j}`,
                                            },
                                            native: {},
                                        });
                                        for (const element of this.objectTemplates.mixPoints) {
                                            await this.setObjectAsync(`${actMixPoint}.${element._id}`, element);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // if we have players on the device
            if (this.devices[device] && this.devices[device].ply) {
                // at this point the device has players
                this.log.info(`createDatabaseAsync(): set players`);
                await this.setObjectAsync(`${baseId}ply`, {
                    type: 'folder',
                    common: {
                        name: 'All players',
                    },
                    native: {},
                });
                for (const players of Object.keys(this.devices[device].ply)) {
                    // create player folder, key name is the folder id
                    await this.setObjectAsync(`${baseId}ply.${players}`, {
                        type: 'folder',
                        common: {
                            name: this.devices[device].ply[players].name,
                        },
                        native: {},
                    });
                    // create the amount of players
                    for (let i = 1; i <= this.devices[device].ply[players].amount; i++) {
                        const actPlayer = `${baseId}ply.${players}.${i}`;
                        // create the player folder
                        await this.setObjectAsync(
                            actPlayer,
                            this.objectTemplates[this.devices[device].objects[1]].player,
                        );
                        // and the common structure of a player
                        for (const element of this.objectTemplates[this.devices[device].objects[1]].players) {
                            await this.setObjectAsync(`${actPlayer}.${element._id}`, element);
                        }
                    }
                }
            }
            // if we have groups on the device
            if (this.devices[device] && this.devices[device].grp) {
                this.log.info(`createDatabaseAsync(): set groups`);
                await this.setObjectAsync(`${baseId}groups`, {
                    type: 'folder',
                    common: {
                        name: 'All Groups',
                    },
                    native: {},
                });
                // create the amount of groups
                for (let i = 1; i <= this.devices[device].grp.groups.amount; i++) {
                    const actGroup = `${baseId}groups.${i.toString().padStart(2, '0')}`;
                    // create the group folder
                    await this.setObjectAsync(actGroup, this.objectTemplates[this.devices[device].objects[1]].group);
                    // and the common structure of a group
                    for (const element of this.objectTemplates[this.devices[device].objects[1]].groups) {
                        await this.setObjectAsync(`${actGroup}.${element._id}`, element);
                    }
                }
            }
            // if we have a DANTE relay device
            if (this.devices[device] && this.devices[device].objects.includes('danterelay')) {
                this.log.info(`createDatabaseAsync(): create dante relay`);
                for (const element of this.objectTemplates.danterelay) {
                    await this.setObjectAsync(element._id, element);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'createDatabase');
        }
        if (deviceName) {
            this.danteDevices[deviceName].grpCmdBuf = new Array(65).fill([]); // buffer for group command while a group deletion is pending
            this.danteDevices[deviceName].groupTypes = new Array(65); // prepare array to hold the type of groups
            this.danteDevices[deviceName].groupTypes.fill(0);
            this.danteDevices[deviceName].groupMembers = new Array(65); // prepare array to hold actual group members
            this.danteDevices[deviceName].groupMembers.fill([]);
            this.danteDevices[deviceName].grpDelPnd = new Array(65).fill(false); // prepare array to flag group deletions pending
        }
        this.log.info(`createDatabaseAsync(): ${deviceName} completed`);
    }

    /**
     * called to create a list of all states in the database
     */
    async createStatesListAsync() {
        this.log.debug(`createStatesListAsync(): requesting device states from database`);
        this.stateList = Object.keys(await this.getStatesAsync('*'));
    }

    /**
     * called to create a DANTE device statelist
     *
     * @param {string} deviceName the device to create the states list for
     * @returns {Promise <any[]>} this has to return a promise
     */
    async createDanteStatesListAsync(deviceName) {
        if (deviceName) {
            this.log.info(`createDanteStatesListAsync(): requesting dante device states from database`);
            return Object.keys(await this.getStatesAsync(`dante.${deviceName}.*`));
        }
        this.log.warn(`createDanteStatesListAsync(): no device specified`);
        return [];
    }

    /**
     * called to get all statelist items status from device
     *
     * @param {Array} stateList list of items to retrieve
     */
    async getDeviceStatusAsync(stateList = this.stateList) {
        const device = this.devices[this.config.device].short;
        let dynamics = {};
        try {
            // if status has not been requested
            if (!this.statusRequested && this.isVerboseMode) {
                this.log.info('Extron request device status started');
                // iterate through stateList to request status from device
                //for (let index = 0; index < stateList.length; index++) {
                for (const id of stateList) {
                    //const id = stateList[index];
                    this.log.debug(`getDeviceStatus(): ${id}`);
                    // extron.[n].[idType].[grpId].[number].[block]
                    //   0     1     2        3       4        5
                    // extron.[n].in.auxInputs.01.mixPoints.A01
                    // extron.[n].out.outputs.01.attenuation.level
                    // extron.[n].groups.[n].level
                    // extron.[n].dante.available
                    // extron.[n].dante.[deviceName].[fld].[type].[number].[block]
                    //   0     1    2       3          4     5       6        7
                    const baseId = id.slice(0, id.lastIndexOf('.'));
                    const stateName = id.slice(id.lastIndexOf('.') + 1);
                    const idArray = id.split('.');
                    const dante = idArray[2] == 'dante' && !['available', 'connections'].includes(idArray[3]);
                    const idType = !dante ? idArray[2] : idArray[4];
                    const grpId = Number(!dante ? idArray[3] : idArray[5]);
                    let source = {};

                    if (typeof baseId !== 'undefined' && baseId !== null) {
                        if (!(['device', 'info'].includes(idArray[2]) || dante)) {
                            // those sections don't need to be handled here
                            switch (stateName) {
                                case 'mute':
                                    if (device === 'smd202') {
                                        this.getMute();
                                    } else if (idType === 'connections') {
                                        this.getVideoMute(id);
                                    } else {
                                        this.getMuteStatus(id);
                                    }
                                    break;

                                case 'source':
                                    if (device === 'cp82' && !id.match(/videoInputs\.1[3456]\./)) {
                                        break;
                                    } // on CP82 only video line inputs 12..15 have a source attribute indicating signal presence
                                    this.getSource(id);
                                    break;

                                case 'type':
                                    if (idType === 'groups') {
                                        this.getGroupType(grpId);
                                    } else {
                                        this.getDspBlockType(id);
                                    }
                                    break;

                                case 'level':
                                    if (device === 'smd202') {
                                        this.getVol();
                                    } else if (idType === 'groups') {
                                        this.getGroupLevel(grpId);
                                    } else {
                                        if (
                                            id.match(/\.inputs\.\d+\.gain\./) &&
                                            (source = await this.getStateAsync(`${baseId}.source`)) &&
                                            source.val > 0
                                        ) {
                                            this.getDigGainLevel(id); // if analog input assigned to a digital source
                                        } else {
                                            this.getGainLevel(id);
                                        }
                                    }
                                    break;

                                case 'level_db': // doesn't need to be handled as already covered by level
                                    break;

                                case 'playmode':
                                    if (device === 'smd202') {
                                        this.getPlayVideo();
                                    } else {
                                        this.getPlayMode(id);
                                    }
                                    break;

                                case 'repeatmode':
                                    this.getRepeatMode(id);
                                    break;

                                case 'filename':
                                    this.getFileName(id);
                                    break;

                                case 'filepath':
                                    if (device === 'sme211') {
                                        break;
                                    } // not supported on SME211
                                    this.getVideoFile();
                                    break;

                                case 'filenames':
                                case 'filecount':
                                case 'freespace':
                                case 'upl':
                                case 'del':
                                    break; // will be handled when processing 'dir' state

                                case 'loopmode':
                                    this.getLoopVideo();
                                    break;

                                case 'streammode':
                                    this.getStreamMode();
                                    break;

                                case 'dir':
                                    this.listUserFiles();
                                    break;

                                case 'status':
                                    if (device === 'sme211') {
                                        // extron.[n].player.stream.[m].status
                                        //    0    1     2     3     4     5
                                        this.getStreamState(Number(idArray[4]));
                                    } else {
                                        dynamics = await this.getStateAsync(`${baseId}.type`);
                                        if (dynamics) {
                                            //this.log.info(`getDeviceStatus(): "${baseId}.type": ${dynamics.val}`);
                                            if (Number(dynamics.val) != 0) {
                                                this.getDspBlockStatus(id);
                                            } else {
                                                this.log.info(`getDeviceStatus(): "${baseId}" not configured`);
                                            }
                                        }
                                    }
                                    break;

                                case 'hdmistatus':
                                    this.getHDMIStatus();
                                    break;

                                case 'threshold':
                                    dynamics = await this.getStateAsync(`${baseId}.type`);
                                    if (dynamics) {
                                        //this.log.info(`getDeviceStatus(): dynamics for ${baseId}: ${dynamics.val}`);
                                        if (Number(dynamics.val) != 0) {
                                            this.getDynamicsThreshold(id);
                                        } else {
                                            this.log.info(`getDeviceStatus(): "${baseId}" not configured`);
                                        }
                                    }
                                    break;

                                case 'attack':
                                case 'knee':
                                case 'ratio':
                                case 'hold':
                                case 'release':
                                    this.log.info(`getDeviceStatus(): dynamics "${stateName}" not yet implemented`);
                                    break;

                                case 'slope':
                                case 'cutboost':
                                case 'frequency':
                                case 'qfactor':
                                    this.log.info(`getDeviceStatus(): filter "${stateName}" not yet implemented`);
                                    break;

                                case 'automix':
                                case 'processing':
                                    // this.log.info(`getDeviceStatus(): mixpoint "${stateName}" not yet implemented`);
                                    break;

                                case 'name':
                                    if (idType === 'groups') {
                                        this.getGroupName(grpId);
                                    } else {
                                        this.getIOName(id);
                                    }
                                    break;

                                case 'deleted': // no need to handle this here
                                    break;

                                case 'upperLimit':
                                case 'lowerLimit':
                                    this.getGroupLimits(grpId);
                                    break;

                                case 'members':
                                    this.getGroupMembers(grpId);
                                    break;

                                case 'channel':
                                    this.getChannel();
                                    break;

                                case 'presets':
                                    this.getPresets();
                                    break;

                                case 'available':
                                    this.getDanteDevices();
                                    break;

                                case 'connected':
                                    this.listDanteConnections();
                                    break;

                                default:
                                    this.log.warn(
                                        `getDeviceStatus(): baseId "${baseId}", stateName "${stateName}" unknown`,
                                    );
                            }
                        }
                    }
                }
                this.statusRequested = true;
                this.log.info('Extron request device status completed');
                this.queryStatus();
            }
        } catch (err) {
            this.errorHandler(err, 'getDeviceStatus');
        }
    }

    /**
     * called to set all statelist item states to device
     *
     * @param {Array} stateList list of states to set
     */
    async setDeviceStatusAsync(stateList = this.stateList) {
        try {
            // if status has not been requested
            if (!this.statusSent && this.isVerboseMode) {
                this.log.info('Extron set device status started');
                // iterate through stateList to send status to device
                for (const id of stateList) {
                    const state = await this.getStateAsync(id);
                    state.ack = false;
                    this.onStateChange(id, state);
                }
                this.statusSent = true;
                this.log.info('Extron set device status completed');
            }
        } catch (err) {
            this.errorHandler(err, 'setDeviceStatus');
        }
    }

    /**
     * check names for invalid characters
     *
     * @param {string} name the name to check
     * @returns {boolean} true = name is valid
     */
    checkName(name) {
        for (const char of invalidChars) {
            if (name.includes(char)) {
                return false;
            }
        }
        return true;
    }

    /**
     * calculate linValue -> logValue -> devValue and back
     *
     * @param {number | string | undefined} value the value to calculate
     * @param {string} type the type of calculation
     * Type of value provided:
     * dev,  lin, log (-1000 .. 120, 0 .. 1000, -100 .. 12)
     * devGain, linGain, logGain (-180 .. 800, 0 .. 1000, -18 .. 80)
     * devAux, linAux, logAux (-180 .. 240, 0.. 1000, -18 .. 24)
     * devDig, linDig, logDig (-180 .. 240, 0.. 1000, -18 .. 24)
     * devTrim, linTrim, logTrim (-120 .. 120, 0 .. 1000, -12 .. 12)
     * devAtt, linAtt, logAtt (-1000 .. 0, 0 .. 1000, -100 .. 0)
     * devAxi, linAxi, logAxi (0 .. 420, 0 ..1000, 0.. 42) only 3dB steps allowed
     * devNpa, linNpa, logNpa (-180 .. 600, 0 .. 1000, -18 .. 60)
     * returns: Object with all 3 value types
     * @returns {object} object with all 3 value types
     */
    calculateFaderValue(value, type) {
        const locObj = {};

        try {
            if (typeof value === 'undefined') {
                return {};
            }
            if (typeof value === 'string') {
                value = Number(value);
            }

            switch (type) {
                case 'lin': // linear value 0 .. 1000 from database
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);

                    if (value === 764) {
                        locObj.logValue = '0.0';
                        locObj.devValue = '0';
                    } else if (value > 764) {
                        locObj.logValue = (((value - 764) / 236) * 12).toFixed(1);
                        locObj.devValue = (((value - 764) / 236) * 120).toFixed(0);
                    } else if (value >= 650) {
                        locObj.logValue = (((value - 764) / 114) * 5).toFixed(1);
                        locObj.devValue = (((value - 764) / 114) * 50).toFixed(0);
                    } else if (value >= 250) {
                        locObj.logValue = (((value - 650) / 400) * 25 - 5).toFixed(1);
                        locObj.devValue = (((value - 650) / 400) * 250 - 50).toFixed(0);
                    } else if (value >= 2) {
                        locObj.logValue = (((value - 250) / 250) * 40 - 30).toFixed(1);
                        locObj.devValue = (((value - 250) / 250) * 400 - 300).toFixed(0);
                    } else {
                        locObj.logValue = '-100.0';
                        locObj.devValue = '-1000';
                    }
                    break;

                case 'log': // value from database -100.0 .. 12.0
                case 'dev': // value from device -1000 .. 120
                    if (type === 'log') {
                        value = value * 10;
                    }
                    value = value > 120 ? 120 : value;
                    value = value < -1000 ? -1000 : value;

                    if (value < 0) {
                        locObj.linValue = (((value + 1000) * 764) / 1000).toFixed(0);
                    } else {
                        locObj.linValue = ((value * 236) / 120 + 764).toFixed(0);
                    }
                    locObj.devValue = value.toFixed(0);
                    locObj.logValue = (value / 10).toFixed(1);
                    break;

                case 'linGain': // linear value from database 0 .. 1000 for Input
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 980) / 1000 - 180).toFixed(0);
                    locObj.logValue = ((value * 98) / 1000 - 18).toFixed(1);
                    break;

                case 'logGain': // value from database -18.0 .. 80.0 for input
                case 'devGain': // value from device -180 .. 800 for input
                    if (type === 'logGain') {
                        value = value * 10;
                    }
                    value = value > 800 ? 800 : value;
                    value = value < -180 ? -180 : value;

                    locObj.linValue = (((value + 180) * 1000) / 980).toFixed(0);
                    locObj.devValue = value.toFixed(0);
                    locObj.logValue = (value / 10).toFixed(1);
                    break;

                case 'linAux': //linear value from database 0 .. 1000 for AuxInput
                case 'linDig': //linear value from database 0 .. 1000 for input with digital source
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 420) / 1000 - 180).toFixed(0);
                    locObj.logValue = ((value * 42) / 1000 - 18).toFixed(1);
                    break;

                case 'logAux': // value from database -18.0 .. 24.0 for input
                case 'logDig': // value from database -18.0 .. 24.0 for digital input
                case 'devAux': // value from device -180 .. 240 for input
                case 'devDig': // value from device -180 .. 240 for input with digital source
                    if (type === 'logAux') {
                        value = value * 10;
                    }
                    value = value > 240 ? 240 : value;
                    value = value < -180 ? -180 : value;

                    locObj.linValue = (((value + 180) * 1000) / 420).toFixed(0);
                    locObj.devValue = value.toFixed(0);
                    locObj.logValue = (value / 10).toFixed(1);
                    break;

                case 'logTrim': // value from database -12.0 .. 12.0 for PostMix Trim
                case 'devTrim': // value from device -120 .. 120 for PostMix Trim
                    if (type === 'logTrim') {
                        value = value * 10;
                    }
                    value = value > 120 ? 120 : value;
                    value = value < -120 ? -120 : value;

                    locObj.linValue = (((value + 120) * 1000) / 240).toFixed(0);
                    locObj.devValue = value.toFixed(0);
                    locObj.logValue = (value / 10).toFixed(1);
                    break;

                case 'linTrim': // linear value from database 0 ..1000 for PostMix Trim
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 240) / 1000 - 120).toFixed(0);
                    locObj.logValue = ((value * 24) / 1000 - 12).toFixed(1);
                    break;

                case 'logAtt': // value from database -100 .. 0 for output attenuation
                case 'devAtt': //  value from device -1000 .. 0 for output attenuation
                    if (type === 'logAtt') {
                        value = value * 10;
                    }
                    value = value > 0 ? 0 : value;
                    value = value < -1000 ? -1000 : value;

                    locObj.linValue = (value + 1000).toFixed(0);
                    locObj.devValue = value.toFixed(0);
                    locObj.logValue = (value / 10).toFixed(1);
                    break;

                case 'linAtt': // value from database 0 .. 1000 for output attenuation
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = (value - 1000).toFixed(0);
                    locObj.logValue = (value / 10 - 100).toFixed(1);
                    break;

                case 'logAxi': // value from database 0 .. 42 for input gain
                case 'devAxi': // value from device 0 .. 420 for input gain
                    if (type === 'logAxi') {
                        value = value * 10;
                    }
                    value = value > 420 ? 420 : value;
                    value = value < 0 ? 0 : value;

                    value = Math.trunc(value / 3) * (42 / 3); // AXI only allowing 3dB steps

                    locObj.linValue = ((value * 1000) / 420).toFixed(0);
                    locObj.devValue = value.toFixed(0);
                    locObj.logValue = (value / 10).toFixed(1);
                    break;

                case 'linAxi':
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 420) / 1000).toFixed(0);
                    locObj.logValue = ((value * 42) / 1000).toFixed(1);
                    break;

                case 'devNpa':
                case 'logNpa':
                    if (type === 'logNpa') {
                        value = value * 10;
                    }
                    value = value > 600 ? 600 : value;
                    value = value < -180 ? -180 : value;

                    locObj.linValue = (((value + 180) * 1000) / 780).toFixed(0);
                    locObj.devValue = value.toFixed(0);
                    locObj.logValue = (value / 10).toFixed(1);
                    break;

                case 'linNpa':
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 780) / 1000 - 180).toFixed(0);
                    locObj.logValue = ((value * 78) / 1000 - 18).toFixed(1);
                    break;
            }
        } catch (err) {
            this.errorHandler(err, 'calculateFaderValue');
        }

        return locObj;
    }

    /** BEGIN device config control */
    /**
     * save device config to local filesystem
     * cmd = 1*2XF
     */
    saveDeviceConfig() {
        try {
            this.streamSend(`W1*2XF\r`);
        } catch (err) {
            this.errorHandler(err, 'saveDeviceConfig');
        }
    }

    /**
     * restore device config from local filesystem
     * cmd = 0*2XF
     */
    restoreDeviceConfig() {
        try {
            this.streamSend(`W0*2XF\r`);
        } catch (err) {
            this.errorHandler(err, 'restoreDeviceConfig');
        }
    }

    /**
     * request device part number
     * cmd = N
     *
     * @param {string | void} device the device to get the partnumber from
     */
    getDevicePartnumber(device = '') {
        try {
            this.log.debug(`getDevicePartnumber(): requesting ${device} partnumber`);
            this.streamSend(`N\r`, device);
        } catch (err) {
            this.errorHandler(err, 'getDevicePartnumber');
        }
    }

    /**
     * set device part number
     * cmd = PNO
     *
     * @param {string} deviceName device name to set the part number
     * @param {string} partNumber the part number to set
     */
    setDevicePartnumber(deviceName, partNumber) {
        if (deviceName != '') {
            // () => for (const device of this.devices) if (device.pno == partNumber) return device.model;
            this.danteDevices[deviceName].pno = partNumber;
            this.danteDevices[deviceName].deviceType = Object.keys(this.devices).find(
                device => this.devices[device].pno == partNumber,
            );
            this.danteDevices[deviceName].remoteDeviceType = Object.keys(this.devices).find(
                device => this.devices[device].pno == partNumber,
            );
            this.danteDevices[deviceName].model = this.devices[this.danteDevices[deviceName].deviceType].model;
            this.setState(`dante.${deviceName}.device.pno`, partNumber, true);
            this.setState(`dante.${deviceName}.device.model`, this.danteDevices[deviceName].model, true);
            //this.setState(`dante.${deviceName}.device.type`, this.danteDevices[deviceName].deviceType, true);
        } else {
            this.device.pno = partNumber;
            this.setState(`device.pno`, partNumber, true);
        }
        this.log.debug(`setDevicePartnumber(): ${deviceName} "${partNumber}"`);
    }

    /**
     * request device model
     * cmd = 1I
     *
     * @param {string | void} device device to retrieve
     */
    getDeviceModel(device = '') {
        try {
            this.log.debug(`getPno(): requesting ${device} model`);
            this.streamSend(`1I\r`, device);
        } catch (err) {
            this.errorHandler(err, 'getDeviceModel');
        }
    }

    /**
     * set device model
     * cmd = INF01
     *
     * @param {string} deviceName name of the device to set the model
     * @param {string} deviceModel the model to set
     */
    setDeviceModel(deviceName, deviceModel) {
        if (deviceName != '') {
            this.danteDevices[deviceName].model = deviceModel;
            this.setState(`dante.${deviceName}.device.model`, deviceModel, true);
        } else {
            this.device.model = deviceModel;
            this.setState(`device.model`, deviceModel, true);
        }
        this.log.debug(`setDeviceModel(): ${deviceName} "${deviceModel}"`);
    }

    /** END device config control */

    /** BEGIN Input and Mix control */
    /**
     * Set the database values for a mixpoint or channel
     *
     * @param {string} cmd the command to execute
     * @param {string} oid the oid on which to execute the command
     * @param {string | boolean} value the value to set
     * cmd = DSM (mute), DSG (gain)
     */
    setGain(cmd, oid, value) {
        try {
            const id = this.oid2id(oid);
            const idArray = id.split('.');
            // [fld].[type].[number].[block]
            //   0     1        2       3
            // in.auxInputs.01.mixPoints.A01.gain
            // out.outputs.01.filter.1.gain
            // dante.available
            // dante.[deviceName].[fld].[type].[number].[block]
            //   0     1            2      3        4     5
            let idType = '';
            let idBlock = '';
            let device = this.devices[this.config.device].short;
            if (idArray[0] == 'dante') {
                idType = idArray[3];
                idBlock = idArray[5];
                device = this.devices[Object.keys(this.danteDevices).find(device => device == idArray[1])].short;
            } else {
                idType = idArray[1];
                idBlock = idArray[3];
            }
            let calcMode = 'dev';
            if (cmd === 'DSM') {
                this.setState(`${id}mute`, Number(value) > 0 ? true : false, true);
            } else {
                switch (idBlock) {
                    case 'gain':
                        calcMode = 'devGain';
                        if (idType === 'auxInputs') {
                            calcMode = 'devAux';
                        }
                        if (device === 'sme211') {
                            calcMode = 'devAux';
                        }
                        if (device.startsWith('AXI')) {
                            calcMode = 'devAxi';
                        }
                        if (device.startsWith('NetPA')) {
                            calcMode = 'devXpa';
                        }
                        if (cmd === 'DSH') {
                            calcMode = 'devDig';
                        }
                        break;

                    case 'postmix':
                        calcMode = 'devTrim';
                        break;

                    case 'attenuation':
                        calcMode = 'devAtt';
                        break;
                }

                const faderVal = this.calculateFaderValue(value.toString(), calcMode);
                if (faderVal) {
                    this.setState(`${id}level_db`, Number(faderVal.logValue), true);
                    this.setState(`${id}level`, Number(faderVal.linValue), true);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'setGain');
        }
    }

    /**
     * Send the mute status to the device
     *
     * @param {string} baseId the base id of the database path
     * @param {string | boolean | number} value the value to set
     * @param {string | void} device the device to set the value on
     * cmd = M[oid]*[0/1]AU
     */
    sendMuteStatus(baseId, value, device = '') {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                const sendData = `WM${oid}*${Number(value) > 0 ? '1' : '0'}AU\r`;
                const grpId = this.checkGrpMember(oid, device);
                if (grpId && this.grpDelPnd[grpId]) {
                    this.queueGrpCmd(grpId, sendData, device);
                } else {
                    this.streamSend(sendData, device);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'sendMuteStatus');
        }
    }

    /**
     * request the mute status from device
     *
     * @param {string} baseId the base id of the database path
     * @param {string | void} device the device to get the mute status from
     * cmd = M[oid]AU
     */
    getMuteStatus(baseId, device = '') {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WM${oid}AU\r`, device);
            }
        } catch (err) {
            this.errorHandler(err, 'getMuteStatus');
        }
    }

    /**
     * Send the gain level to the device
     *
     * @param {string} id the id to set the gain level on
     * @param {string | any} value the value to set
     * @param {string | void} deviceName the device name to which the data will be sent
     * cmd = G[oid]*[value]AU
     * cmd = H[oid]*[value]AU on inputs with digital source
     */
    sendGainLevel(id, value, deviceName = '') {
        try {
            let oid = this.id2oid(id);
            const device = this.devices[this.config.device].short;
            if (oid) {
                let sendData = `WG${oid}*${value.devValue}AU\r`;
                const grpId = this.checkGrpMember(oid);
                if (grpId && this.grpDelPnd[grpId]) {
                    this.queueGrpCmd(grpId, sendData);
                } else {
                    this.streamSend(sendData, deviceName);
                }
                if (device === 'sme211') {
                    // on SME211 we have stereo controls
                    switch (Number(oid)) {
                        case 40000:
                            oid = '40001';
                            break;
                        case 40001:
                            oid = '40000';
                            break;
                        case 40002:
                            oid = '40003';
                            break;
                        case 40003:
                            oid = '40002';
                            break;
                    }
                    sendData = `WG${oid}*${value.devValue}AU\r`;
                    this.streamSend(sendData, deviceName);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'sendGainLevel');
        }
    }

    /**
     * Send the gain level to the device
     *
     * @param {string} id the id to change
     * @param {string | any} value the value to send
     * @param {string | void} deviceName the device name to which the data will be sent
     * cmd = H[oid]*[value]AU on inputs with digital source
     */
    sendDigGainLevel(id, value, deviceName = '') {
        try {
            let oid = this.id2oid(id);
            const device = this.devices[this.config.device].short;
            if (oid) {
                let sendData = `WH${oid}*${value.devValue}AU\r`;
                this.streamSend(sendData, deviceName);
                if (device === 'sme211') {
                    // on SME211 we have stereo controls
                    switch (Number(oid)) {
                        case 40000:
                            oid = '40001';
                            break;
                        case 40001:
                            oid = '40000';
                            break;
                        case 40002:
                            oid = '40003';
                            break;
                        case 40003:
                            oid = '40002';
                            break;
                    }
                    sendData = `WH${oid}*${value.devValue}AU\r`;
                    this.streamSend(sendData, deviceName);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'sendDigGainLevel');
        }
    }

    /**
     * get the gain level from device
     *
     * @param {string} id the id to get the gain level from
     * @param {string | void} device the device name to which the data will be sent
     * cmd = G[oid]AU
     * cmd = H[oid]AU on inputs with digital source
     */
    getGainLevel(id, device = '') {
        try {
            const oid = this.id2oid(id);
            if (oid) {
                this.streamSend(`WG${oid}AU\r`, device);
            }
        } catch (err) {
            this.errorHandler(err, 'getGainLevel');
        }
    }

    /**
     * get the gain level from device
     *
     * @param {string} id the id to get the gain level from
     * @param {string | void} device the device name to which the data will be sent
     * cmd = H[oid]AU on inputs with digital source
     */
    getDigGainLevel(id, device = '') {
        try {
            const oid = this.id2oid(id);
            if (oid) {
                this.streamSend(`WH${oid}AU\r`, device);
            }
        } catch (err) {
            this.errorHandler(err, 'getDigGainLevel');
        }
    }

    /**
     * Set the source for a auxinput
     *
     * @param {string} oid oid of the auxinput to set
     * @param {string | number} value the value to set
     * cmd = DSD (source)
     */
    setSource(oid, value) {
        try {
            const channel = this.oid2id(oid);
            this.setState(`${channel}source`, Number(value), true);
        } catch (err) {
            this.errorHandler(err, 'setSource');
        }
    }

    /**
     * Send the source mode to the device
     *
     * @param {string} baseId the base id of the database path
     * @param {string | number} value the value to send
     * cmd = D[oid]*[value]AU
     */
    sendSource(baseId, value) {
        try {
            const oid = this.id2oid(`${baseId}.source`);
            if (oid) {
                this.streamSend(`WD${oid}*${value === '' ? 0 : value}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendSource');
        }
    }

    /**
     * get the source mode from device
     *
     * @param {string} baseId the base id of the database path
     * cmd = D[oid]AU
     */
    getSource(baseId) {
        try {
            const oid = this.id2oid(`${baseId}.source`);
            if (oid) {
                this.streamSend(`WD${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getSource');
        }
    }

    /**
     * get the i/o name from device
     *
     * @param {string} Id id of the name to get
     * @param {string | void} device the device name to which the data will be sent
     * cmd = [ioNumber]{ioType}
     */
    getIOName(Id, device = '') {
        try {
            const ioType = Id.split('.')[3];
            const ioNumber = Number(Id.split('.')[4]);
            switch (ioType) {
                case 'inputs':
                    this.streamSend(`W${ioNumber}NI\r`, device);
                    break;
                case 'auxInputs':
                    this.streamSend(`W${ioNumber + 12}NI\r`, device);
                    break;
                case 'virtualReturns':
                    this.streamSend(`W${ioNumber}NL\r`, device);
                    break;
                case 'expansionInputs':
                    this.streamSend(`WA${ioNumber}EXPD\r`, device);
                    //this.streamSend(`W${ioNumber}NE\r`);
                    break;
                case 'outputs':
                    this.streamSend(`W${ioNumber}NO\r`, device);
                    break;
                case 'auxOutputs':
                    this.streamSend(`W${ioNumber + 8}NO\r`, device);
                    break;
                case 'expansionOutputs':
                    this.streamSend(`W${ioNumber}NX\r`, device);
                    break;
            }
        } catch (err) {
            this.errorHandler(err, 'getIOName');
        }
    }

    /**
     * send the i/o name to device
     *
     * @param {string} Id id of the name to set
     * @param {string} name the name to send
     * @param {string | void} device the device name to which the data will be sent
     * cmd = [ioNumber],[ioName]{ioType}
     */
    sendIOName(Id, name, device = '') {
        try {
            const ioType = Id.split('.')[3];
            const ioNumber = Number(Id.split('.')[4]);
            switch (ioType) {
                case 'inputs':
                    this.streamSend(`W${ioNumber},${name}NI\r`, device);
                    break;
                case 'auxInputs':
                    this.streamSend(`W${ioNumber + 12},${name}NI\r`, device);
                    break;
                case 'virtualReturns':
                    this.streamSend(`W${ioNumber},${name}NL\r`, device);
                    break;
                case 'expansionInputs':
                    this.streamSend(`WA${ioNumber}*${name}EXPD\r`, device);
                    break;
                case 'outputs':
                    this.streamSend(`W${ioNumber},${name}NO\r`, device);
                    break;
                case 'auxOutputs':
                    this.streamSend(`W${ioNumber + 8},${name}NO\r`, device);
                    break;
                case 'expansionOutputs':
                    this.streamSend(`W${ioNumber},${name}NX\r`, device);
                    break;
            }
        } catch (err) {
            this.errorHandler(err, 'sendIOName');
        }
    }

    /**
     * set the i/o name from device
     *
     * @param {string} IO the io for which the name will be set
     * @param {string} name the name to set
     * @param {string | void} device the device name to which the data will be sent
     */
    setIOName(IO, name, device = '') {
        try {
            const id = this.oid2id(IO, device);
            if (id) {
                this.setState(`${id}`, `${name}`, true);
            }
        } catch (err) {
            this.errorHandler(err, 'setIOName');
        }
    }

    /**
     * get Dynamics type
     *
     * @param {string} baseId the base id of the database path
     * cmd = Y[oid]AU
     */
    getDspBlockType(baseId) {
        try {
            const oid = this.id2oid(`${baseId}.status`);
            if (oid) {
                this.streamSend(`WY${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getDynamicsType');
        }
    }

    /**
     * send Dynamics type to device
     *
     * @param {string} baseId the base id of the database path
     * @param {number} value the value to send
     * cmd = Y[oid]*[value]AU
     */
    sendDspBlockType(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WY${oid}*${value}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendDynamicsType');
        }
    }

    /**
     * set dynamics type in database
     *
     * @param {string} oid the oid of the dsp block to set
     * @param {string | number} value the type to set
     */
    setDspBlockType(oid, value) {
        try {
            const channel = this.oid2id(oid);
            this.setState(`${channel}type`, Number(value), true);
        } catch (err) {
            this.errorHandler(err, 'setDynamicsStatus');
        }
    }

    /**
     * set dynamics status in database
     *
     * @param {string} oid the oid of the dsp block to set
     * @param {string | number} value the status to set
     */
    setDspBlockStatus(oid, value) {
        try {
            const channel = this.oid2id(oid);
            this.setState(`${channel}status`, Number(value) > 0 ? true : false, true);
        } catch (err) {
            this.errorHandler(err, 'setDynamicsStatus');
        }
    }

    /**
     * get Dynamics status
     *
     * @param {string} baseId the base id of the database path
     * cmd = E[oid]AU
     */
    getDspBlockStatus(baseId) {
        try {
            const oid = this.id2oid(`${baseId}.status`);
            if (oid) {
                this.streamSend(`WE${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getDynamicsStatus');
        }
    }

    /**
     * send DSP Block status to device
     *
     * @param {string} baseId the base id of the database path
     * @param {string | any} value the status to send
     * cmd = E[oid]*[0/1]AU
     */
    sendDspBlockStatus(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WE${oid}*${value ? '1' : '0'}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendDynamicsStatus');
        }
    }

    /**
     * set Dynamics threshold in database
     *
     * @param {string} oid oid of the the dsp block to set
     * @param {string | any} value the value to set
     */
    setDynamicsThreshold(oid, value) {
        try {
            const channel = this.oid2id(oid);
            this.setState(`${channel}threshold`, Number(0 - value), true);
        } catch (err) {
            this.errorHandler(err, 'setDynamicsThreshold');
        }
    }

    /**
     * get Dynamics threshold from device
     *
     * @param {string} baseId the base id of the database path
     * cmd = T[oid]AU
     */
    getDynamicsThreshold(baseId) {
        try {
            const oid = this.id2oid(`${baseId}.status`);
            if (oid) {
                this.streamSend(`WT${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getDynamicsThreshold');
        }
    }

    /**
     * send new Dynamics Threshold to device
     *
     * @param {string} baseId the base id of the database path
     * @param {string | any} value the value to send
     * cmd = T[oid]*[value]AU
     */
    sendDynamicsThreshold(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WT${oid}*${value}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendDynamicsThreshold');
        }
    }
    /** END Input and Mix control */

    /** BEGIN integrated audio player control */
    /**
     * Set the database values for a player
     *
     * @param {string} oid the oid of the player
     * @param {string | boolean} value the value to set
     * cmd = PLAY (playmode)
     */
    setPlayMode(oid, value) {
        try {
            const player = this.oid2id(oid);
            this.setState(`${player}playmode`, value === '1' ? true : false, true);
        } catch (err) {
            this.errorHandler(err, 'setPlayMode');
        }
    }

    /**
     * control playback on the device.player
     *
     * @param {string} baseId the base id of the database path
     * @param {string | any} value the value to send
     * cmd = [ply]*[1|0]PLAY
     */
    sendPlayMode(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`W${oid}*${value ? '1' : '0'}PLAY\r`);
                if (!this.playerLoaded[Number(oid) - 1]) {
                    this.log.warn(`sendPlayMode(): player ${oid} has no file assigned`);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'sendPlayMode');
        }
    }

    /**
     * request playback mode from the device.player
     *
     * @param {string} baseId the base id of the database path
     * cmd = [ply]PLAY
     */
    getPlayMode(baseId) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`W${oid}PLAY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getPlayMode');
        }
    }

    /**
     * Set the database values for a player
     *
     * @param {string} oid the oid of the player
     * @param {string | boolean} value the value to set
     * cmd = CPLYM (repeatmode)
     */
    setRepeatMode(oid, value) {
        try {
            const player = this.oid2id(oid);
            this.setState(`${player}repeatmode`, value === '1' ? true : false, true);
        } catch (err) {
            this.errorHandler(err, 'setRepeatMode');
        }
    }

    /**
     * control repeatmode on the device.player
     *
     * @param {string} baseId the base id of the database path
     * @param {string | any} value the value to send
     * cmd=M[ply]*[0|1]CPLY
     */
    sendRepeatMode(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                if (this.playerLoaded[Number(oid) - 1]) {
                    this.streamSend(`WM${oid}*${value ? '1' : '0'}CPLY\r`);
                } else {
                    this.log.error(`sendRepeatMode(): player ${oid} has no file assigned`);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'sendRepeatMode');
        }
    }

    /**
     * request repeatmode on the device.player
     *
     * @param {string} baseId the base id of the database path
     * cmd = M[ply]CPLY
     */
    getRepeatMode(baseId) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WM${oid}CPLY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getRepeatMode');
        }
    }

    /**
     * Send the Player filename to device
     *
     * @param {string} baseId the base id of the database path
     * @param {string} value the value to send
     * cmd = A[ply]*[filename]CPLY
     */
    sendFileName(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                const streamData = `WA${oid}*${value === '' ? ' ' : value}CPLY\r`;
                this.streamSend(streamData);
            }
        } catch (err) {
            this.errorHandler(err, 'sendFileName');
        }
    }

    /**
     * Send clear Player filename to device
     *
     * @param {string} baseId the base id of the database path
     * cmd = A[ply]* CPLY
     */
    clearFileName(baseId) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WA${oid}* CPLY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'clearFileName');
        }
    }

    /**
     * Set the Player filename in the database
     *
     * @param {string} oid the oid of the filename
     * @param {string} value the name to set
     * cmd = CPLYA (associate file to player)
     */
    setFileName(oid, value) {
        try {
            const player = this.oid2id(oid);
            this.setState(`${player}filename`, value, true);
            this.playerLoaded[Number(oid) - 1] = value != '' ? true : false;
        } catch (err) {
            this.errorHandler(err, 'setFileName');
        }
    }

    /**
     * request current filename from player
     *
     * @param {string} baseId the base id of the database path
     * cmd = A[ply]CPLY
     */
    getFileName(baseId) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WA${oid}CPLY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getFileName');
        }
    }
    /** END integrated audio player control */

    /** BEGIN user flash memory file management */

    /**
     * called to load a file into device user flash memory
     *
     * @param {string} filePath the path to load from
     * cmd = +UF[fileSize]*2 [month] [day] [year] [hour] [minute] [second],[fileName]
     */
    loadUserFile(filePath) {
        let fileExist = false;
        try {
            fs.accessSync(filePath); // check if given path is accessible
            const fileName = path.basename(filePath); // extract filename
            const fileExt = path.extname(filePath); // extract file extension
            const fileStats = fs.statSync(filePath); // load file statistics
            const fileTimeStamp = fileStats.mtime.toJSON(); // parse file timestamp
            const year = fileTimeStamp.slice(0, 4); // split timestamp information ...
            const month = fileTimeStamp.slice(5, 7);
            const day = fileTimeStamp.slice(8, 10);
            const hour = fileTimeStamp.slice(11, 13);
            const minute = fileTimeStamp.slice(14, 16);
            const second = fileTimeStamp.slice(17, 19);
            for (const file of this.fileList.files) {
                if (file.fileName == fileName) {
                    fileExist = true;
                }
            }
            if (!fileExist) {
                this.log.debug(`loadUserFile(): filetype: ${fileExt}`);
                if (fileExt.toLowerCase() == '.raw') {
                    if (fileStats.size < this.fileList.freeSpace) {
                        const streamData = `W+UF${fileStats.size}*2 ${month} ${day} ${year} ${hour} ${minute} ${second},${fileName}\r`;
                        this.log.debug('loadUserFile(): starting file transmission');
                        this.streamSend(streamData); // issue upload command to device
                        this.fileSend = true; // flag file transmission
                        fs.readFile(filePath, (err, data) => {
                            if (err) {
                                throw err;
                            }
                            this.streamSend(data); // transmit file to device
                        });
                        this.fileSend = false; // unflag file transmission
                        this.log.debug('loadUserFile(): file transmission completed');
                    } else {
                        this.log.error(
                            `loadUserFile(): filesize "${fileStats.size}" of "${fileName}" exceeds remaining freespace "${this.fileList.freeSpace}" on device`,
                        );
                    }
                } else {
                    this.log.error(`loadUserFile(): invalid filetype: "${fileExt}"`);
                }
            } else {
                this.log.error(`loadUserFile(): file ${fileName} already on device`);
            }
        } catch (err) {
            this.fileSend = false;
            this.errorHandler(err, 'loadUserFile');
        }
    }

    /**
     * delete the user file from device
     *
     * @param {string} fileName the filename of the file to erase
     * cmd = [fileName]EF
     */
    eraseUserFile(fileName) {
        try {
            const streamData = `W${fileName === '' ? ' ' : fileName}EF\r`;
            this.streamSend(streamData);
        } catch (err) {
            this.errorHandler(err, 'eraseUserFile');
        }
    }

    /**
     * called to list current files in device user flash memory
     * cmd = DF
     */
    listUserFiles() {
        try {
            this.streamSend(`WDF\r`);
            //this.requestDir = true;     // flag directory request
        } catch (err) {
            this.requestDir = false; // unflag directory request
            this.errorHandler(err, 'listUserFiles');
        }
    }

    /**
     * called to set current files from device user flash memory in database
     *
     * @param {Array} userFileList the list to write into the database
     */
    async setUserFilesAsync(userFileList) {
        const filenames = [];
        try {
            let i = 0;
            userFileList.sort(); // sort list alphabetically to resemble DSP configurator display
            for (const userFile of userFileList) {
                // check each line
                if (userFile.match(/(\d+\b Bytes Left)/g)) {
                    this.fileList.freeSpace = Number(userFile.match(/\d+/));
                    this.log.debug(`setUserFiles(): freespace ${this.fileList.freeSpace}`);
                }
                this.file.fileName = userFile.match(/^(.+\.\w{3}\b)/g) ? `${userFile.match(/^(.+\.\w{3}\b)/g)[0]}` : ''; // extract filename
                this.file.timeStamp = userFile.match(/(\w{3}, \d\d \w* \d* \W*\d\d:\d\d:\d\d)/g)
                    ? `${userFile.match(/(\w{3}, \d\d \w* \d* \W*\d\d:\d\d:\d\d)/g)[0]}`
                    : ''; //extract timestamp
                this.file.fileSize = userFile.match(/(\d+)$/g) ? Number(userFile.match(/(\d+)$/g)[0]) : 0; // extract filesize
                if (this.devices[this.config.device].short !== 'dmp' || this.file.fileName.match(/.raw$/)) {
                    // if DMP only accept .raw AudioFiles
                    i++;
                    filenames.push(this.file.fileName); // add to list of filenames
                    this.fileList.files[i] = this.file; // add to filelist array
                }
            }
            this.setState('fs.filenames', JSON.stringify(filenames), true);
            this.setState(`fs.filecount`, i, true);
            this.setState('fs.freespace', this.fileList.freeSpace, true);
            this.setState('fs.dir', false, true);
            this.log.debug(`setUserFiles(): Extron userFlash filelist updated: ${userFileList.join('; ')}`);
        } catch (err) {
            this.requestDir = false;
            this.errorHandler(err, 'setUserFiles');
        }
    }
    /** END user flash memory file management */

    /** BEGIN group control */

    /**
     * queue group commands during group deletion pending
     *
     * @param {number} group the group to queue
     * @param {string} cmd the command to queue
     * @param {string | void} device the device for which to queue
     */
    queueGrpCmd(group, cmd, device = '') {
        const _grpCmdBuf = device == '' ? this.grpCmdBuf : this.danteDevices[device].grpCmdBuf;

        this.log.info(`queueGrpCmd(): pushing "${this.decodeBufferToLog(cmd)}" to ${device} group #${group} buffer`);
        _grpCmdBuf[group].push(cmd); // push command to buffer
    }

    /**
     * send group command buffer
     *
     * @param {number} group the group to queue
     * @param {string | void} device the device for which to queue
     */
    sendGrpCmdBuf(group, device = '') {
        const _grpCmdBuf = device == '' ? this.grpCmdBuf : this.danteDevices[device].grpCmdBuf;

        this.log.info(`sendGrpCmdBuf: processing ${_grpCmdBuf[group].length} queued commands on group "${group}"`);
        while (_grpCmdBuf[group].length > 0) {
            this.streamSend(_grpCmdBuf[group].shift(), device);
        }
    }

    /**
     * check group membership of given oid
     *
     * @param {string} oid the oid to check
     * @returns {number} grpId the group id to check
     * @param {string | void} device the device to check
     */
    checkGrpMember(oid, device = '') {
        let grpId = 0;
        let grpMembers = [];
        for (let grpIdx = 1; grpIdx < 65; grpIdx++) {
            grpId = 0;
            //this.log.debug(`checkGrpMember(): ${grpIdx} ${this.groupMembers[grpIdx]}`);
            grpMembers = device == '' ? this.groupMembers[grpIdx] : this.danteDevices[device].groupMembers[grpIdx];
            if (grpMembers.includes(oid)) {
                grpId = grpIdx;
                break;
            }
        }
        return grpId;
    }

    /**
     * get all member OID's of a given group from device
     *
     * @param {number} group the group to query
     * @param {string | void} device the device to query
     * cmd = O[group]GRPM
     */
    getGroupMembers(group, device = '') {
        const cmd = `WO${group}GRPM\r`;
        if (this.grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd, device); // send comman
            } catch (err) {
                this.errorHandler(err, 'getGroupMembers');
            }
        } else {
            this.queueGrpCmd(group, cmd, device); // push command to buffer
        }
    }

    /**
     * add member OID to group on device
     *
     * @param {number} group the group to add the member to
     * @param {string} baseId the id to add to the group
     * @param {string | void} device the device to send to
     * cmd = O[group]*[oid]GRPM
     */
    sendGroupMember(group, baseId, device = '') {
        const oid = this.id2oid(baseId);
        const cmd = `WO${group}*${oid}GRPM\r`;
        if (oid) {
            if (device == '' ? this.grpDelPnd[group] == false : this.danteDevices[device].grpDelPnd[group] == false) {
                try {
                    this.streamSend(cmd, device); // send comman
                } catch (err) {
                    this.errorHandler(err, 'sendGroupMember');
                }
            } else {
                this.queueGrpCmd(group, cmd, device); // push command to buffer
            }
        }
    }

    /**
     * store group members in database
     *
     * @param {number} group the group to change the members on
     * @param {Array} members the members to set
     * @param {string | void} device the device to send to
     */
    setGroupMembers(group, members, device = '') {
        const stateMembers = [];
        const _groupMembers = device == '' ? this.groupMembers : this.danteDevices[device].groupMembers;
        try {
            //if ((members === undefined) || (members.length === 0)) {
            if (members === undefined) {
                this.log.debug(`setGroupMembers(): no member for ${device} group ${group}`);
            } else {
                this.log.debug(`setGroupMembers(): ${device} group #${group} curMembers: "${_groupMembers[group]}"`);
                if (members.length == 1) {
                    // add single member to group
                    if (_groupMembers[group].includes(members[0])) {
                        this.log.debug(
                            `setGroupMembers(): OID "${members[0]}" already included with ${device} group ${group}`,
                        );
                    } else {
                        if (members[0] != '') {
                            _groupMembers[group].push(members[0]);
                            this.log.info(
                                `setGroupMembers(): added OID "${members[0]}" to ${device} group ${group} now holding "${_groupMembers[group]}"`,
                            );
                        } else {
                            _groupMembers[group] = [];
                            this.log.info(`setGroupMembers(): deleted members of ${device} group "${group}"`);
                        }
                    }
                } else {
                    // replace list of members
                    _groupMembers[group] = [];
                    for (const member of members) {
                        _groupMembers[group].push(member);
                    }
                }
                for (const member of _groupMembers[group]) {
                    stateMembers.push(this.oid2id(member));
                }
                this.setState(
                    `${device != '' ? `dante.${device}.` : ''}groups.${group.toString().padStart(2, '0')}.members`,
                    _groupMembers[group].length == 0 ? '' : `${stateMembers}`,
                    true,
                );
                this.setState(
                    `${device != '' ? `dante.${device}.` : ''}groups.${group.toString().padStart(2, '0')}.deleted`,
                    _groupMembers[group].length == 0 ? true : false,
                    true,
                );
                this.log.info(`setGroupMembers(): ${device} group ${group} now has members:"${_groupMembers[group]}"`);
            }
        } catch (err) {
            this.errorHandler(err, 'setGroupMembers');
        }
    }

    /**
     * clear group on device
     *
     * @param {number} group the group to delete
     * @param {string | void} device the device to send to
     * cmd = Z[group]GRPM
     */
    sendDeleteGroup(group, device = '') {
        const cmd = `WZ${group}GRPM\r`;
        const _grpDelPnd = device == '' ? this.grpDelPnd : this.danteDevices[device].grpDelPnd;
        const _grpCmdBuf = device == '' ? this.grpCmdBuf : this.danteDevices[device].grpCmdBuf;
        try {
            if (_grpDelPnd[group] == false) {
                this.streamSend(cmd, device);
                _grpDelPnd[group] = true; // flag group deletion command has been sent
                _grpCmdBuf[group] = []; // clear command buffer for the group
            } else {
                _grpCmdBuf[group].push(cmd);
            }
        } catch (err) {
            this.errorHandler(err, 'sendDeleteGroup');
        }
    }

    /**
     * get group fader level from device
     *
     * @param {number} group the group to get levels from
     * @param {string | void} device the device to query
     * cmd = D[group]GRPM
     */
    getGroupLevel(group, device = '') {
        const cmd = `WD${group}GRPM\r`;
        const _grpDelPnd = device == '' ? this.grpDelPnd : this.danteDevices[device].grpDelPnd;
        const _groupTypes = device == '' ? this.groupTypes : this.danteDevices[device].groupTypes;

        if (_grpDelPnd[group] == false) {
            try {
                if (_groupTypes[group] == 0) {
                    this.getGroupType(group, device);
                }
                this.streamSend(cmd, device); // send command
            } catch (err) {
                this.errorHandler(err, 'getGroupLevel');
            }
        } else {
            this.queueGrpCmd(group, cmd, device); // push command to buffer
        }
    }

    /**
     * send group fader level to device
     *
     * @param {number} group the group to control
     * @param {number} level the level of the group to set
     * @param {string | void} device the device to send to
     * cmd = D[group]*[level]GRPM
     */
    sendGroupLevel(group, level, device = '') {
        const _groupTypes = device == '' ? this.groupTypes : this.danteDevices[device].grouupTypes;
        const _grpDelPnd = device == '' ? this.grpDelPnd : this.danteDevices[device].grpDelPnd;
        let cmd = '';
        switch (_groupTypes[group]) {
            case 6: // gain group
                cmd = `WD${group}*${this.calculateFaderValue(level, 'lin').devValue}GRPM\r`;
                break;
            case 12: // mute group
                cmd = `WD${group}*${level}GRPM\r`;
                break;
            case 21: // meter group
                this.log.info(`sendGroupLevel(): meter groups not supported`);
                break;
            default:
                this.log.error(
                    `sendGroupLevel() groupType "${_groupTypes[group]}" for ${device} group "${group}" not supported`,
                );
        }
        if (cmd != '') {
            if (_grpDelPnd[group] == false) {
                try {
                    this.streamSend(cmd, device); // send command
                } catch (err) {
                    this.errorHandler(err, 'sendGroupLevel');
                }
            } else {
                this.queueGrpCmd(group, cmd, device); // push command to buffer
            }
        }
    }

    /**
     * store group level in database
     *
     * @param {number} group the group to set the level
     * @param {number} level the level to set
     * @param {string | void} device the device to store the data
     */
    setGroupLevel(group, level, device = '') {
        const _groupTypes = device == '' ? this.groupTypes : this.danteDevices[device].grouupTypes;
        const baseId = device == '' ? '' : `dante.${device}`;
        try {
            const groupStr = group.toString().padStart(2, '0');
            switch (_groupTypes[group]) {
                case 6: // gain group
                    this.setState(
                        `${baseId}.groups.${groupStr}.level_db`,
                        Number(this.calculateFaderValue(level, 'dev').logValue),
                        true,
                    );
                    this.setState(
                        `${baseId}.groups.${groupStr}.level`,
                        Number(this.calculateFaderValue(level, 'dev').linValue),
                        true,
                    );
                    break;
                case 12: // mute group
                    this.setState(`${baseId}.groups.${groupStr}.level_db`, level ? 1 : 0, true);
                    this.setState(`${baseId}.groups.${groupStr}.level`, level ? 1 : 0, true);
                    break;
                case 21: // meter group
                    this.log.info(`setGroupLevel(): meter groups not supported`);
                    break;
                default:
                    this.log.warn(
                        `setGroupLevel(): ${device} groupType "${_groupTypes[group]}" on group "${group}" not supported`,
                    );
            }
        } catch (err) {
            this.errorHandler(err, 'setGroupLevel');
        }
    }

    /**
     * get group type from device
     *
     * @param {number} group the group to query
     * @param {string | void} device the device to query
     * cmd = P[group]GRPM
     */
    getGroupType(group, device = '') {
        const cmd = `WP${group}GRPM\r`;
        const _grpDelPnd = device == '' ? this.grpDelPnd : this.danteDevices[device].grpDelPnd;
        if (_grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd, device); // send command
            } catch (err) {
                this.errorHandler(err, 'getGroupType');
            }
        } else {
            this.queueGrpCmd(group, cmd, device); // push command to buffer
        }
    }

    /**
     * send group type to device
     *
     * @param {number} group the group to send
     * @param {number} type the group type
     * @param {string | void} device the device to send to
     * cmd = P[group]*[type]GRPM
     */
    sendGroupType(group, type, device = '') {
        const cmd = `WP${group}*${type}GRPM\r`;
        const _grpDelPnd = device == '' ? this.grpDelPnd : this.danteDevices[device].grpDelPnd;
        if (_grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd, device); // send command
            } catch (err) {
                this.errorHandler(err, 'sendGroupType');
            }
        } else {
            this.queueGrpCmd(group, cmd, device); // push command to buffer
            this.setGroupType(group, type, device); // already store new type value
        }
    }

    /**
     * store group type in database
     *
     * @param {number} group the group to store
     * @param {number} type the group type
     * @param {string | void} device the device to store for
     */
    setGroupType(group, type, device = '') {
        if (device == '') {
            this.groupTypes[Number(group)] = Number(type);
        } else {
            this.danteDevices[device].groupTypes[Number(group)] = Number(type);
        }
        try {
            this.setState(
                `${device != '' ? `dante.${device}.` : ''}groups.${group.toString().padStart(2, '0')}.type`,
                type,
                true,
            );
        } catch (err) {
            this.errorHandler(err, 'setGroupType');
        }
    }

    /**
     * get group level limits from device
     *
     * @param {number} group the group to query
     * @param {string | void} device the device to query
     * cmd = L[group]GRPM
     */
    getGroupLimits(group, device = '') {
        const cmd = `WL${group}GRPM\r`;
        const _grpDelPnd = device == '' ? this.grpDelPnd : this.danteDevices[device].grpDelPnd;

        if (_grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd, device); // send command
            } catch (err) {
                this.errorHandler(err, 'getGroupLimits');
            }
        } else {
            this.queueGrpCmd(group, cmd, device); // push command to buffer
        }
    }

    /**
     * send group limits to device
     *
     * @param {number} group the group to handle
     * @param {number} upper the uppel limit to set
     * @param {number} lower the lower limit to set
     * @param {string | void} device the device to send to
     * cmd = L[group]*[upper]*[lower]GRPM
     */
    sendGroupLimits(group, upper, lower, device = '') {
        const cmd = `WL${group}*${upper}*${lower}GRPM\r`;
        const _grpDelPnd = device == '' ? this.grpDelPnd : this.danteDevices[device].grpDelPnd;

        if (_grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd, device); // send command
            } catch (err) {
                this.errorHandler(err, 'sendGroupLimits');
            }
        } else {
            this.queueGrpCmd(group, cmd, device); // push command to buffer
        }
    }

    /**
     * store group limits in databas
     *
     * @param {number} group the group to store
     * @param {number} upper the uppel limit to store
     * @param {number} lower the lower limit to store
     * @param {string | void} device the device to store for
     */
    setGroupLimits(group, upper, lower, device = '') {
        try {
            this.setState(
                `${device != '' ? `dante.${device}.` : ''}groups.${group.toString().padStart(2, '0')}.upperLimit`,
                upper,
                true,
            );
            this.setState(
                `${device != '' ? `dante.${device}.` : ''}groups.${group.toString().padStart(2, '0')}.lowerLimit`,
                lower,
                true,
            );
        } catch (err) {
            this.errorHandler(err, 'setGroupLimits');
        }
    }

    /**
     * get group name from device
     *
     * @param {number} group the group to query
     * @param {string | void} device the device to query
     * cmd = N[group]GRPM
     */
    getGroupName(group, device = '') {
        const cmd = `WN${group}GRPM\r`;
        const _grpDelPnd = device == '' ? this.grpDelPnd : this.danteDevices[device].grpDelPnd;

        if (_grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd, device); // send command
            } catch (err) {
                this.errorHandler(err, 'getGroupName');
            }
        } else {
            this.queueGrpCmd(group, cmd, device); // push command to buffer
        }
    }

    /**
     * send group name to device
     *
     * @param {number} group the group to handle
     * @param {string} name the new group name
     * @param {string | void} device the device to send to
     * cmd = N[group]*[name]GRPM
     */
    sendGroupName(group, name, device = '') {
        const cmd = `WN${group}*${name}GRPM\r`;
        const _grpDelPnd = device == '' ? this.grpDelPnd : this.danteDevices[device].grpDelPnd;
        if (_grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd, device); // send command
            } catch (err) {
                this.errorHandler(err, 'sendGroupName');
            }
        } else {
            this.queueGrpCmd(group, cmd, device); // push command to buffer
        }
    }

    /**
     * store group name in database
     *
     * @param {number} group the group to store
     * @param {string} name the name of the group
     * @param {string | void} device the device to store for
     */
    setGroupName(group, name, device = '') {
        try {
            this.setState(
                `${device != '' ? `dante.${device}.` : ''}groups.${group.toString().padStart(2, '0')}.name`,
                name,
                true,
            );
        } catch (err) {
            this.errorHandler(err, 'setGroupName');
        }
    }
    /** END group control*/

    /** BEGIN cp82 Video control */
    /**
     * Set the database values for the tie state of an output
     *
     * @param {string} cmd the tie command
     * @param {string} value the value to set
     * cmd = Inx, x=1..8; value=[1,2] All if not All set for all and log a warning
     */
    setTie(cmd, value) {
        try {
            const input = cmd.slice(2, 3);
            const valArray = value.split(' ');
            if (valArray[1] !== 'All') {
                this.log.warn(`Extron received tie status "${valArray[1]}". Only "All" supported. andle like "All"`);
            }
            this.setState(`connections.${valArray[0]}.tie`, Number(input), true);
        } catch (err) {
            this.errorHandler(err, 'setTie');
        }
    }

    /**
     * Send the tie status to the device
     *
     * @param {string} baseId database id
     * @param {string | any} value the value
     * cmd = [input]*[output]! tie input to output
     * cmd = [input]LOUT tie input to loopOut
     * cmd = [input]*[output]
     */
    sendTieCommand(baseId, value) {
        try {
            const idArray = baseId.split('.');
            if (idArray[2] === 'connections') {
                // video.output
                if (Number(idArray[3]) <= 2) {
                    this.streamSend(`${value}*${idArray[3]}!\r`); // tie input 'value' to output 'idArray[3]'
                } else {
                    if (value > 0) {
                        this.streamSend(`W${value}LOUT\r`);
                        // set loop out input to 'value'
                    } else {
                        this.streamSend(`${value}*${idArray[3]}!\r`);
                    } // untie loopOut
                }
            }
        } catch (err) {
            this.errorHandler(err, 'sendTieCommand');
        }
    }

    /**
     * Send Video mute command to the device
     *
     * @param {string} baseId database id
     * @param {string | any} value the value to send
     * cmd = [value]B / *[value]B
     */
    sendVideoMute(baseId, value) {
        const device = this.devices[this.config.device].short;
        try {
            const idArray = baseId.split('.');
            if (idArray[2] === 'connections') {
                // video.output
                if (device === 'sme211') {
                    this.streamSend(`${value}B\r`);
                } else {
                    this.streamSend(`${idArray[3]}*${value}B\r`);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'sendVideoMute');
        }
    }

    /**
     * get Video mute status from device
     *
     * @param {string} baseId database id
     * cmd = B / *B
     */
    getVideoMute(baseId) {
        const device = this.devices[this.config.device].short;
        try {
            const idArray = baseId.split('.');
            if (idArray[2] === 'connections') {
                // video.output
                if (device === 'sme211') {
                    this.streamSend(`B\r`);
                } else {
                    this.streamSend(`${idArray[3]}*B\r`);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'getVideoMute');
        }
    }
    /** END CP82 Video control */

    /** BEGIN SMD202 Video Player control */
    /**
     * get playback state
     * cmd = Y1PLYR
     */
    getPlayVideo() {
        try {
            this.streamSend('WY1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'getPlayVideo');
        }
    }

    /**
     * set playback state in database
     *
     * @param {string} id database id
     * @param {string | number} _channel currently not in use
     * @param {number} mode the playmode to set
     */
    setPlayVideo(id, _channel, mode) {
        try {
            this.setState(`${id}playmode`, mode, true);
        } catch (err) {
            this.errorHandler(err, 'setPlayVideo');
        }
    }
    /**
     * send start payback command
     * cmd = S1*1PLYR
     */
    sendPlayVideo() {
        try {
            this.streamSend('WS1*1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'sendPlayVideo');
        }
    }

    /**
     * send pause payback command
     * cmd = E1PLYR
     */
    sendPauseVideo() {
        try {
            this.streamSend('WE1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'sendPauseVideo');
        }
    }

    /**
     * send stop playback command
     * cmd = O1PLYR
     */
    sendStopVideo() {
        try {
            this.streamSend('WO1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'sendStopVideo');
        }
    }

    /**
     * get loop payback mode
     * cmd = R1*[mode]PLYR
     */
    getLoopVideo() {
        try {
            this.streamSend('WR1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'getLoopVideo');
        }
    }

    /**
     * set loop payback mode
     *
     * @param {string} id database id
     * @param {string | number} _channel currently not in use
     * @param {boolean | string} mode the mode to set
     */
    setLoopVideo(id, _channel, mode) {
        try {
            this.setState(`${id}loopmode`, Number(mode) ? true : false, true);
        } catch (err) {
            this.errorHandler(err, 'setLoopVideo');
        }
    }
    /**
     * send loop payback command
     *
     * @param {string} _id currently not in use
     * @param {boolean} mode the mode to send
     * cmd = R1*[0/1]PLYR
     */
    sendLoopVideo(_id, mode) {
        try {
            this.streamSend(`WR1*${mode ? 1 : 0}PLYR\r`);
        } catch (err) {
            this.errorHandler(err, 'sendLoopVideo');
        }
    }

    /**
     * send path and filename
     *
     * @param {string} id the id to send the file for
     * @param {string} path the path to the file
     * cmd = U1*[path]
     */
    sendVideoFile(id, path) {
        try {
            this.streamSend(`WU${this.id2oid(id)}*${path}PLYR\r`);
        } catch (err) {
            this.errorHandler(err, 'sendVideoFile');
        }
    }

    /**
     * get path and filename
     * cmd = U1PLYR
     */
    getVideoFile() {
        try {
            this.streamSend('WU1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'getVideoFile');
        }
    }

    /**
     * Set the Player filename in the database
     *
     * @param {string} id database id
     * @param {string} path the path to set
     */
    setVideoFile(id, path) {
        try {
            this.setState(`${id}filepath`, path, true);
            this.playerLoaded[0] = path != '' ? true : false;
        } catch (err) {
            this.errorHandler(err, 'setVideoFile');
        }
    }

    /**
     * get current preset list
     * cmd = GTVPR
     */
    getPresets() {
        try {
            this.presetList = '';
            this.streamSend('WGTVPR\r');
        } catch (err) {
            this.errorHandler(err, 'getPresets');
        }
    }

    /**
     * set preset list in database
     *
     * @param {string} presetList the list to set
     */
    setPresets(presetList) {
        try {
            this.setState(`player.presets`, presetList, true);
            this.log.debug(`setPresets(): "${presetList}"`);
        } catch (err) {
            this.errorHandler(err, 'setPresets');
        }
    }

    /**
     * get current preset channel
     * cmd = T1TVPR
     */
    getChannel() {
        try {
            this.streamSend('WT1TVPR\r');
        } catch (err) {
            this.errorHandler(err, 'getChannel');
        }
    }

    /**
     * set current channel in database
     *
     * @param {string} id database id
     * @param {string | number} channel the channel to set
     */
    setChannel(id, channel) {
        try {
            this.setState(`${id}channel`, Number(channel), true);
        } catch (err) {
            this.errorHandler(err, 'setChannel');
        }
    }

    /**
     * send channel change to device
     *
     * @param {string|number} channel the channel to send
     * cmd = T1*[channel]TVPR
     */
    sendChannel(channel) {
        try {
            this.streamSend(`WT1*${channel}TVPR\r`);
        } catch (err) {
            this.errorHandler(err, 'sendChannel');
        }
    }
    /**
     * get output mute status
     * cmd = Z
     */
    getMute() {
        try {
            this.streamSend('Z');
        } catch (err) {
            this.errorHandler(err, 'getMute');
        }
    }

    /**
     * set output mute status in database
     *
     * @param {string} id database id
     * @param {number | boolean} mute the mute status to set
     */
    setMute(id, mute) {
        try {
            this.setState(`${id}mute`, mute ? true : false, true);
        } catch (err) {
            this.errorHandler(err, 'setMute');
        }
    }

    /**
     * send mute to device
     *
     * @param {boolean | number} mute the mute status to send
     * cmd = [1/0]Z
     */
    sendMute(mute) {
        try {
            this.streamSend(`${mute ? 1 : 0}Z`);
        } catch (err) {
            this.errorHandler(err, 'sendMute');
        }
    }
    /**
     * get output volume level
     * cmd = V
     */
    getVol() {
        try {
            this.streamSend('V');
        } catch (err) {
            this.errorHandler(err, 'getVol');
        }
    }
    /**
     * set output volume level in database
     *
     * @param {string} id database id
     * @param {string | any} volume the valuem to set
     */
    setVol(id, volume) {
        try {
            this.setState(`${id}level_db`, Number(Number(volume.logValue).toFixed(0)), true);
            this.setState(`${id}level`, Number(volume.linValue), true);
        } catch (err) {
            this.errorHandler(err, 'setVol');
        }
    }
    /**
     * set output volume on device
     *
     * @param {string | any} volume the valuem to send
     * cmd = [value]V
     */
    sendVol(volume) {
        try {
            this.streamSend(`${Number(volume.logValue).toFixed(0)}V`);
        } catch (err) {
            this.errorHandler(err, 'sendVol');
        }
    }
    /** END SMD 202 Video Player Control */

    /** BEGIN SME211 stream control */
    /**
     * send streaming mode to device
     *
     * @param {number} mode the mode to send
     *  cmd = Y[0/1/2]STRM
     */
    sendStreamMode(mode) {
        try {
            this.streamSend(`WY${mode}STRM\r`);
        } catch (err) {
            this.errorHandler(err, 'sendStreamMode');
        }
    }

    /**
     * set streammode state in database
     *
     * @param {string} id database id
     * @param {number} mode the mode to set
     */
    setStreamMode(id, mode) {
        try {
            this.setState(`${id}streammode`, mode, true);
        } catch (err) {
            this.errorHandler(err, 'setStreamMode');
        }
    }

    /**
     * get streammode from device
     *  cmd = YSTRM
     */
    getStreamMode() {
        try {
            this.streamSend('WYSTRM\r');
        } catch (err) {
            this.errorHandler(err, 'getStreamMode');
        }
    }

    /**
     * send stream state to device
     *
     * @param {number} stream the stream to control
     * @param {number} state the state to send
     *  cmd = E[11/12/13/21/22/23]STRC
     */
    sendStreamState(stream, state) {
        try {
            this.streamSend(`WE${stream}*${state}STRC\r`);
        } catch (err) {
            this.errorHandler(err, 'sendStreamState');
        }
    }

    /**
     * set stream state in database
     *
     * @param {number} stream the stream to set
     * @param {number} state the state of the stream to set
     */
    setStreamState(stream, state) {
        try {
            this.setState(`player.stream.${stream}.status`, state, true);
        } catch (err) {
            this.errorHandler(err, 'setStreamState');
        }
    }

    /**
     * get stream state from device
     *
     * @param {number} stream the stream to query
     *  cmd = E[11/12/13/21/22/23]STRC
     */
    getStreamState(stream) {
        try {
            this.streamSend(`WE${stream}STRC\r`);
        } catch (err) {
            this.errorHandler(err, 'getStreamState');
        }
    }

    /**
     * get HDMI input signal status from device
     *  cmd = 0LS
     */
    getHDMIStatus() {
        try {
            this.streamSend('W0LS\r');
        } catch (err) {
            this.errorHandler(err, 'getHDMIStatus');
        }
    }
    /** END SME 211 stream control */

    /** BEGIN DANTE control and configuration messages */
    /**
     * get available DANTE devices
     * cmd = AEXPR
     */
    getDanteDevices() {
        try {
            this.streamSend(`WAEXPR\r`);
        } catch (err) {
            this.errorHandler(err, 'getDanteDevices');
        }
    }

    /** BEGIN DANTE control and configuration messages */
    /**
     * set available DANTE devices in database
     *
     * @param {Array} deviceList the list of devices to store in database
     */
    setDanteDevices(deviceList) {
        try {
            this.setState(`dante.available`, JSON.stringify(deviceList), true);
            for (const deviceName of deviceList) {
                if (typeof this.danteDevices[deviceName] == 'undefined') {
                    this.danteDevices[deviceName] = {
                        connectionState: 'AVAILABLE',
                        deviceActive: false,
                        danteName: deviceName,
                        remoteDeviceType: '',
                        friendlyName: '',
                    };
                }
                this.createDeviceCommonAsync(deviceName);
            }
        } catch (err) {
            this.errorHandler(err, 'setDanteDevices');
        }
    }

    /**
     * control danteDeviceconnection
     *
     * @param {string} deviceName the device to control the connection for
     * @param {number | boolean} state the state to send
     * cmd = C[device]*[state]EXPR
     */
    sendDanteConnection(deviceName, state) {
        try {
            this.streamSend(`WC${deviceName}*${state ? 1 : 0}EXPR\r`);
        } catch (err) {
            this.errorHandler(err, 'ctrlDanteConnection');
        }
    }

    /**
     * check DANTE connection
     *
     * @param {string} deviceName name of the device to check
     * cmd = C[deviceName]EXPR
     */
    getDanteConnection(deviceName) {
        try {
            this.streamSend(`WC${deviceName}EXPR\r`);
        } catch (err) {
            this.errorHandler(err, 'checkDanteConnection');
        }
    }

    /**
     * set DANTE connection
     *
     * @param {string} deviceName name of the device to set
     * @param {boolean} state the state to set
     */
    setDanteConnection(deviceName, state) {
        try {
            this.log.debug(`setDanteConnections(): set dante.${deviceName}.info.connection ${state}`);
            this.setState(`dante.${deviceName}.info.connection`, state, true);
            this.danteDevices[deviceName].connectionState = state ? 'CONNECTED' : 'AVAILABLE';
        } catch (err) {
            this.errorHandler(err, 'setDanteConnection');
        }
    }

    /**
     * list DANTE connections
     * cmd = LEXPR
     */
    listDanteConnections() {
        try {
            this.streamSend(`WLEXPR\r`);
        } catch (err) {
            this.errorHandler(err, 'listDanteConnections');
        }
    }

    /**
     * set DANTE connections in database
     *
     * @param {Array} deviceList list of devices to set the connection state in database
     */
    setDanteConnections(deviceList) {
        try {
            this.log.debug(`setDanteConnections(): "${JSON.stringify(deviceList)}"`);
            this.setState(`dante.connected`, JSON.stringify(deviceList), true);
            if (deviceList.length) {
                for (const deviceName of deviceList) {
                    this.danteDevices[deviceName].connectionState = 'CONNECTED';
                    this.log.debug(`setDanteConnections(): set dante.${deviceName}.info.connection TRUE`);
                    this.setState(`dante.${deviceName}.info.connection`, true, true);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'setDanteConnections');
        }
    }

    /**
      check configured Dante connections
     */
    checkConfiguredRemoteDevices() {
        for (const device of this.config.remoteDevices) {
            this.log.debug(
                `checkConfiguredRemoteDevicves: set Dante connection for ${device.danteName} to ${device.deviceActive}`,
            );
            this.sendDanteConnection(device.danteName, device.deviceActive);
        }
    }
    /** END DANTE control messages */

    /**
     * determine the database id from ${dante?'"'+danteDevice+'" ':''}OID e.g. 20002 -> in.inputs.01.mixPoints.O03
     *
     * @param {string} oid the oid to process
     * @param {string | void} deviceName name of the device for which this conversion is processed
     * @returns {string} String with complete base id to mixPoint or the gainBlock
     */
    oid2id(oid, deviceName = '') {
        const device = deviceName == '' ? this.devices[this.config.device].short : deviceName;
        const whatstr = oid.slice(0, 1);
        const what = Number(whatstr);
        const where = Number(oid.slice(1, 3));
        const val = Number(oid.slice(3, 7));
        let retId = '';

        try {
            if (oid.length < 2) {
                retId = `ply.players.${oid}.common.`;
            } else if (oid.length < 3) {
                if (device == 'sme211') {
                    // extron.[n].player.stream.[m].status
                    //    0    1     2     3     4     5     6
                    retId = `player.stream.${oid}.status`;
                } else {
                    retId = `groups.${oid}.`;
                }
            } else {
                if (whatstr === 'N') {
                    // Input/Output naming
                    if (oid.slice(1, 4) == 'EXPD') {
                        // DANTE devicename
                        retId = `dante.${deviceName}.device.name`;
                    } else {
                        switch (oid.slice(1, 3)) {
                            case 'MI':
                                if (val < 13) {
                                    retId = `in.inputs.${val.toString().padStart(2, '0')}.name`;
                                }
                                if (val > 12) {
                                    retId = `in.auxInputs.${(val - 12).toString().padStart(2, '0')}.name`;
                                }
                                break;
                            case 'ML':
                                retId = `in.virtualReturns.${val.toString().padStart(2, '0')}.name`;
                                break;
                            case 'EI':
                                retId = `in.expansionInputs.${val.toString().padStart(2, '0')}.name`;
                                break;
                            case 'MO':
                                if (val < 9) {
                                    retId = `out.outputs.${val.toString().padStart(2, '0')}.name`;
                                }
                                if (val > 8) {
                                    retId = `out.auxOutputs.${(val - 8).toString().padStart(2, '0')}.name`;
                                }
                                break;
                            case 'EX':
                                retId = `out.expansionOutputs.${val.toString().padStart(2, '0')}.name`;
                                break;
                        }
                    }
                } else if (`${oid.slice(0, 5)}` === 'EXPDA') {
                    retId = `in.expansionInputs.${oid.slice(5).padStart(2, '0')}.name`;
                } else {
                    switch (what) {
                        case 2: // mixpoints
                            if (device === 'cp82') {
                                // mixpoints on CP82
                                if (where < 2) {
                                    retId = `in.programInputs.${(where + 1).toString().padStart(2, '0')}.mixPoints.`;
                                } else if (where < 4) {
                                    retId = `in.inputs.${(where - 1).toString().padStart(2, '0')}.mixPoints.`;
                                } else if (where < 6) {
                                    retId = `in.lineInputs.${(where - 3).toString().padStart(2, '0')}.mixPoints.`;
                                } else if (where < 8) {
                                    retId = `in.playerInputs.${(where - 5).toString().padStart(2, '0')}.mixPoints.`;
                                }
                            } else if (where <= 11) {
                                // mixpoints on dmp128
                                // from input 1 - 12
                                retId = `in.inputs.${(where + 1).toString().padStart(2, '0')}.mixPoints.`;
                            } else if (where <= 19) {
                                // aux input 1 - 8
                                retId = `in.auxInputs.${(where - 11).toString().padStart(2, '0')}.mixPoints.`;
                            } else if (where <= 35) {
                                // virtual return 1 - 16 (A-P)
                                retId = `in.virtualReturns.${(where - 19).toString().padStart(2, '0')}.mixPoints.`;
                            } else if (where <= 83) {
                                // AT input 1 - 48
                                retId = `in.expansionInputs.${(where - 35).toString().padStart(2, '0')}.mixPoints.`;
                            } else {
                                throw { message: 'no known mixpoint input', stack: `oid: ${oid}` };
                            }
                            // now determine the output
                            if (device === 'cp82') {
                                // mixpoints on CP82
                                retId += `O${(val - 1).toString().padStart(2, '0')}.`; // on CP82 mixpooint output OID count starts at 2
                            } else if (val <= 7) {
                                // mixpoints on dmp128
                                // output 1 -8
                                retId += `O${(val + 1).toString().padStart(2, '0')}.`;
                            } else if (val <= 15) {
                                // aux output 1 - 8
                                retId += `A${(val - 7).toString().padStart(2, '0')}.`;
                            } else if (val <= 31) {
                                // virtual send bus 1 - 16
                                retId += `V${(val - 15).toString().padStart(2, '0')}.`;
                            } else if (val <= 47) {
                                // expansion output 1 - 16
                                retId += `E${(val - 31).toString().padStart(2, '0')}.`;
                            } else {
                                throw { message: 'no known mixpoint output', stack: `oid: ${oid}` };
                            }
                            break;

                        case 3: // VideoLine inputs on CP82
                            if (where === 0) {
                                // Input Gain Control
                                retId = `in.videoInputs.${(val + 1).toString().padStart(2, '0')}.premix.`;
                            }
                            break;

                        case 4: // input block
                            switch (where) {
                                case 0: // Input gain block
                                    if (device === 'cp82') {
                                        // Inputs on CP82
                                        if (val < 2) {
                                            retId = `in.inputs.${(val + 1).toString().padStart(2, '0')}.gain.`;
                                        } else if (val < 4) {
                                            retId = `in.lineInputs.${(val - 1).toString().padStart(2, '0')}.gain.`;
                                        } else if (val < 6) {
                                            retId = `in.playerInputs.${(val - 3).toString().padStart(2, '0')}.gain.`;
                                        }
                                    } else if (val <= 11) {
                                        // input 1 - 12
                                        retId = `in.inputs.${(val + 1).toString().padStart(2, '0')}.gain.`;
                                    } else if (val <= 19) {
                                        // aux input 1 - 8
                                        retId = `in.auxInputs.${(val - 11).toString().padStart(2, '0')}.gain.`;
                                    }
                                    break;

                                case 1: // premix gain block
                                    if (device === 'cp82') {
                                        // Inputs on CP82
                                        if (val < 2) {
                                            retId = `in.inputs.${(val + 1).toString().padStart(2, '0')}.premix.`;
                                        } else if (val < 4) {
                                            retId = `in.lineInputs.${(val - 1).toString().padStart(2, '0')}.premix.`;
                                        } else if (val < 6) {
                                            retId = `in.playerInputs.${(val - 3).toString().padStart(2, '0')}.premix.`;
                                        }
                                    } else if (val <= 11) {
                                        // input 1 - 12
                                        retId = `in.inputs.${(val + 1).toString().padStart(2, '0')}.premix.`;
                                    } else if (val <= 19) {
                                        // aux input 1 - 8
                                        retId = `in.auxInputs.${(val - 11).toString().padStart(2, '0')}.premix.`;
                                    }
                                    break;

                                case 10: // input filter block
                                case 11:
                                case 12:
                                case 13:
                                case 14:
                                    if (val <= 11) {
                                        // input 1 - 12
                                        retId = `in.inputs.${(val + 1).toString().padStart(2, '0')}.${where - 9}.`;
                                    } else if (val <= 19) {
                                        // aux input 1 - 8
                                        retId = `in.auxInputs.${(val - 11).toString().padStart(2, '0')}.${where - 9}.`;
                                    }
                                    break;

                                case 40: // input dynamics block 1
                                    this.log.info(`oid2id(): input dynamics block 1 not yet implemented`);
                                    break;
                                case 41: // input dynamics block 2
                                    this.log.info(`oid2id(): input dynamics block 2 not yet implemented`);
                                    break;
                                case 45: // input delay block
                                    this.log.info(`oid2id(): input delay block not yet implemented`);
                                    break;
                                case 48: // input ducker/agc block
                                    this.log.info(`oid2id(): input ducker/AGC block not yet implemented`);
                                    break;

                                default:
                                    throw { message: 'no known input', stack: `oid: ${oid}` };
                            }
                            break;

                        case 5: // virtual return or ext input or program
                            switch (where) {
                                case 0: // program inputs on CP82
                                    retId = `in.programInputs.${(val + 1).toString().padStart(2, '0')}.premix.`;
                                    break;
                                case 1: // virtual returns
                                    if (val <= 15) {
                                        // virtual return 1 - 16 (A-P)
                                        retId = `in.virtualReturns.${(val + 1).toString().padStart(2, '0')}.premix.`;
                                    }
                                    break;
                                case 2: // expansion bus (AT inputs)
                                    if (val <= 47) {
                                        // AT input 1 - 48
                                        retId = `in.expansionInputs.${(val + 1).toString().padStart(2, '0')}.premix.`;
                                    }
                                    break;
                                case 90: // input automixer block
                                    this.log.info(`oid2id(): input automixer block not yet implemented`);
                                    break;
                                default:
                                    throw { message: 'no known input', stack: `oid: ${oid}` };
                            }
                            break;

                        case 6: // Output section
                            switch (where) {
                                case 0: // Output attenuation block
                                    if (device === 'cp82') {
                                        // outputs on CP82
                                        retId = `out.outputs.${(val - 1).toString().padStart(2, '0')}.attenuation.`; // ouput OID starts at 2 on CP82
                                    } else if (val <= 7) {
                                        // output 1 - 8
                                        retId = `out.outputs.${(val + 1).toString().padStart(2, '0')}.attenuation.`;
                                    } else if (val <= 15) {
                                        // aux output 1 - 8
                                        retId = `out.auxOutputs.${(val - 7).toString().padStart(2, '0')}.attenuation.`;
                                    } else if (val <= 31) {
                                        // expansion output 1-16
                                        retId = `out.expansionOutputs.${(val - 15).toString().padStart(2, '0')}.attenuation.`;
                                    }
                                    break;
                                case 1: // postmix trim block
                                    if (val <= 7) {
                                        // output 1 - 8
                                        retId = `out.outputs.${(val + 1).toString().padStart(2, '0')}.postmix.`;
                                    } else if (val <= 15) {
                                        // aux output 1 - 8
                                        retId = `out.auxOutputs.${(val - 7).toString().padStart(2, '0')}.postmix.`;
                                    } else if (val <= 31) {
                                        // expansion output 1-16
                                        retId = `out.expansionOutputs.${(val - 15).toString().padStart(2, '0')}.postmix.`;
                                    }
                                    break;
                                case 40: // output dynamics block
                                    if (val <= 7) {
                                        // output 1 - 8
                                        retId = `out.outputs.${(val + 1).toString().padStart(2, '0')}.dynamics.`;
                                    } else if (val <= 15) {
                                        // aux output 1 - 8
                                        retId = `out.auxOutputs.${(val - 7).toString().padStart(2, '0')}.dynamics.`;
                                    } else if (val <= 31) {
                                        // expansion output 1-16
                                        retId = `out.expansionOutputs.${(val - 15).toString().padStart(2, '0')}.dynamics.`;
                                    }
                                    break;
                                case 50: // output delay blöock
                                    this.log.info(`oid2id(): output delay block not yet implemented`);
                                    break;
                                case 10: // output filter block
                                case 11:
                                case 12:
                                case 13:
                                case 14:
                                case 15:
                                case 16:
                                case 17:
                                case 18:
                                case 19:
                                    if (val <= 7) {
                                        // output 1 - 8
                                        retId = `out.outputs.${(val + 1).toString().padStart(2, '0')}.filter.${where - 9}.`;
                                    } else if (val <= 15) {
                                        // aux output 1 - 8
                                        retId = `out.auxOutputs.${(val - 7).toString().padStart(2, '0')}.filter.${where - 9}.`;
                                    } else if (val <= 31) {
                                        // expansion output 1-16
                                        retId = `out.expansionOutputs.${(val - 15).toString().padStart(2, '0')}.filter.${where - 9}.`;
                                    }
                                    break;

                                default:
                                    throw { message: 'no known output', stack: `oid: ${oid}` };
                            }
                            break;

                        default:
                            throw { message: 'unknown OID', stack: `oid: ${oid}` };
                    }
                }
            }
        } catch (err) {
            this.errorHandler(err, 'oid2id');
            return '';
        }
        this.log.debug(`oid2id(): "${oid}" to "${retId}"`);
        return deviceName == '' ? retId : `dante.${deviceName}.${retId}`;
    }

    /**
     * determine the oid from the database id e.g. in.inputs.01.mixPoints.O03 -> 20002
     *
     * @param {string} id the id to process
     * @returns {string} String with complete base id to mixPoint or the gainBlock
     */
    id2oid(id) {
        const device = this.devices[this.config.device].short;
        let retOid = '';
        const idArray = id.split('.');
        // extron.[n].ply.players.[number].common.[...]
        // extron.[n].[fld].[type].[number].[block]
        //   0     1    2     3       4        5
        // extron.[n].in.auxInputs.01.mixPoints.A01
        // extron.[n].out.outputs.01.filter.[n].
        // extron.[n].dante.available
        // extron.[n].dante.[deviceName].[fld].[type].[number].[block]
        //   0     1    2       3          4     5       6        7
        const dante = idArray[2] == 'dante';
        const idType = !dante ? idArray[3] : idArray[5];
        const idNumber = !dante ? Number(idArray[4]) : Number(idArray[6]);
        const idBlock = !dante ? idArray[5] : idArray[7];
        const idBlockNr = !dante ? idArray[6] : idArray[8];
        let outputType = 'O';
        let outputNumber = 1;
        if (idArray.length >= (!dante ? 7 : 9)) {
            outputType = !dante ? idArray[6].slice(0, 1) : idArray[8].slice(0, 1);
            outputNumber = !dante ? Number(idArray[6].slice(1, 3)) : Number(idArray[8].slice(1, 3));
        }

        try {
            if (idType === 'stream') {
                // extron.[n].player.stream.[m].status
                //    0    1     2     3     4     5     6
                retOid = `${idNumber}`;
            } else if (idType === 'players') {
                retOid = `${idNumber}`;
            } else if ((!dante ? idArray[2] : idArray[4]) === 'groups') {
                retOid = `${!dante ? idArray[3] : idArray[5]}`;
            } else {
                if (idBlock != 'mixPoints') {
                    // inputs / outputs
                    switch (idType) {
                        case 'videoInputs':
                            retOid = `300${(idNumber - 1).toString().padStart(2, '0')}`; // video line inputs on CP82
                            break;

                        case 'inputs':
                            switch (idBlock) {
                                case 'gain':
                                    retOid = `400${(idNumber - 1).toString().padStart(2, '0')}`;
                                    break;
                                case 'filter':
                                    retOid = `4${idBlockNr + 9}${(idNumber - 1).toString().padStart(2, '0')}`;
                                    break;
                                default:
                                    retOid = `401${(idNumber - 1).toString().padStart(2, '0')}`;
                            }
                            break;

                        case 'programInputs':
                            retOid = `500${(idNumber - 1).toString().padStart(2, '0')}`; // program inputs on CP82
                            break;

                        case 'lineInputs':
                            switch (idBlock) {
                                case 'gain':
                                    retOid = `400${(idNumber + 1).toString().padStart(2, '0')}`; // Line Inputs on CP82
                                    break;
                                case 'filter':
                                    retOid = `4${idBlockNr + 9}${(idNumber + 1).toString().padStart(2, '0')}`;
                                    break;
                                default:
                                    retOid = `401${(idNumber + 1).toString().padStart(2, '0')}`;
                            }
                            break;

                        case 'playerInputs':
                            switch (idBlock) {
                                case 'gain':
                                    retOid = `400${(idNumber + 3).toString().padStart(2, '0')}`; // player inputs on CP82
                                    break;
                                case 'filter':
                                    retOid = `4${idBlockNr + 9}${(idNumber + 3).toString().padStart(2, '0')}`;
                                    break;
                                default:
                                    retOid = `401${(idNumber + 3).toString().padStart(2, '0')}`;
                            }
                            break;

                        case 'auxInputs':
                            switch (idBlock) {
                                case 'gain':
                                    retOid = `400${(idNumber + 11).toString().padStart(2, '0')}`;
                                    break;
                                case 'filter':
                                    retOid = `4${idBlockNr + 9}${(idNumber + 11).toString().padStart(2, '0')}`;
                                    break;
                                default:
                                    retOid = `401${(idNumber + 11).toString().padStart(2, '0')}`;
                            }
                            break;

                        case 'virtualReturns':
                            switch (idBlock) {
                                case 'filter':
                                    this.log.info(`id2oid(): virtualReturn filter block not yet implemented`);
                                    break;
                                default:
                                    retOid = `501${(idNumber - 1).toString().padStart(2, '0')}`;
                            }
                            break;

                        case 'expansionInputs':
                            switch (idBlock) {
                                case 'filter':
                                    this.log.info(`id2oid(): expansionInput filter block not yet implemented`);
                                    break;
                                default:
                                    retOid = `502${(idNumber - 1).toString().padStart(2, '0')}`;
                            }
                            break;

                        case 'outputs':
                            switch (idBlock) {
                                case 'attenuation':
                                    retOid = `600${(idNumber - 1).toString().padStart(2, '0')}`;
                                    if (device === 'cp82') {
                                        retOid = `600${(idNumber + 1).toString().padStart(2, '0')}`;
                                    } // output OID count starts at 2 on CP82
                                    break;
                                case 'dynamics':
                                    retOid = `640${(idNumber - 1).toString().padStart(2, '0')}`;
                                    break;
                                case 'delay':
                                    retOid = `650${(idNumber - 1).toString().padStart(2, '0')}`;
                                    break;
                                case 'filter':
                                    retOid = `6${idBlockNr + 9}${(idNumber - 1).toString().padStart(2, '0')}`;
                                    break;
                                default:
                                    retOid = `601${(idNumber - 1).toString().padStart(2, '0')}`;
                            }
                            break;

                        case 'auxOutputs':
                            switch (idBlock) {
                                case 'attenuation':
                                    retOid = `600${(idNumber + 7).toString().padStart(2, '0')}`;
                                    break;
                                case 'dynamics':
                                    retOid = `640${(idNumber + 7).toString().padStart(2, '0')}`;
                                    break;
                                case 'delay':
                                    retOid = `650${(idNumber + 7).toString().padStart(2, '0')}`;
                                    break;
                                case 'filter':
                                    retOid = `6${idBlockNr + 9}${(idNumber + 7).toString().padStart(2, '0')}`;
                                    break;
                                default:
                                    retOid = `601${(idNumber + 7).toString().padStart(2, '0')}`;
                            }
                            break;

                        case 'expansionOutputs':
                            switch (idBlock) {
                                case 'attenuation':
                                    retOid = `600${(idNumber + 15).toString().padStart(2, '0')}`;
                                    break;
                                case 'dynamics':
                                    retOid = `640${(idNumber + 15).toString().padStart(2, '0')}`;
                                    break;
                                case 'delay':
                                    retOid = `650${(idNumber + 15).toString().padStart(2, '0')}`;
                                    break;
                                case 'filter':
                                    retOid = `6${idBlockNr + 9}${(idNumber + 15).toString().padStart(2, '0')}`;
                                    break;
                                default:
                                    retOid = `601${(idNumber + 15).toString().padStart(2, '0')}`;
                            }
                            break;

                        default:
                            if (idBlock === 'name') {
                                retOid = idNumber.toString();
                            } else {
                                retOid = '';
                            }
                    }
                } else {
                    // mixpoints
                    switch (idType) {
                        case 'inputs':
                            retOid = `2${(idNumber - 1).toString().padStart(2, '0')}`;
                            if (device === 'cp82') {
                                retOid = `2${(idNumber + 1).toString().padStart(2, '0')}`;
                            } // Mic Inputs on CP82
                            break;

                        case 'programInputs':
                            retOid = `2${(idNumber - 1).toString().padStart(2, '0')}`; // program inputs on CP82
                            break;

                        case 'playerInputs':
                            retOid = `2${(idNumber + 5).toString().padStart(2, '0')}`; // FilePlayer Inouts on CP82
                            break;

                        case 'lineInputs':
                            retOid = `2${(idNumber + 3).toString().padStart(2, '0')}`; // Line Inputs on CP82
                            break;

                        case 'auxInputs':
                            retOid = `2${(idNumber + 11).toString().padStart(2, '0')}`;
                            break;

                        case 'virtualReturns':
                            retOid = `2${(idNumber + 19).toString().padStart(2, '0')}`;
                            break;

                        case 'expansionInputs':
                            retOid = `2${(idNumber + 35).toString().padStart(2, '0')}`;
                            break;

                        default:
                            retOid = '';
                    }
                    switch (outputType) {
                        case 'O':
                            if (device === 'cp82') {
                                retOid += (outputNumber + 1).toString().padStart(2, '0'); // output OID count starts at 2 on CP82
                            } else {
                                retOid += (outputNumber - 1).toString().padStart(2, '0');
                            }
                            break;

                        case 'A':
                            retOid += (outputNumber + 7).toString().padStart(2, '0');
                            break;

                        case 'V':
                            retOid += (outputNumber + 15).toString().padStart(2, '0');
                            break;

                        case 'E':
                            retOid += (outputNumber + 31).toString().padStart(2, '0');
                            break;
                        case 's':
                            break;

                        default:
                        // retOid = '';
                    }
                }
            }
        } catch (err) {
            this.errorHandler(err, 'id2oid');
            return '';
        }
        this.log.debug(`id2oid(): "${id}" to "${retOid}"`);
        return retOid;
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback callback given by js-controller
     */
    onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            this.log.debug('onUnload(): calling clearInterval()');
            //clearTimeout(this.timers.timeoutQueryStatus); // clear the query timer
            //clearTimeout(this.timers.timeoutReconnectClient); // clear reconnect timer
            // @ts-expect-error works in real life
            clearInterval(this.centralIntervalTimer);
            // close client connection
            switch (this.config.type) {
                case 'ssh':
                    this.log.debug('onUnload(): calling this.client.end()');
                    this.client.end();
                    break;
                case 'telnet':
                    this.log.debug('onUnload(): calling this.net.destroy()');
                    this.net.destroy();
                    break;
            }
            this.log.debug('onUnload(): calling callback()');
            callback();
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id th id passed by js-controller
     * @param {ioBroker.State | null | undefined} state the state which was changed
     */
    async onStateChange(id, state) {
        try {
            if (state) {
                // The state was changed
                // this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                if (!state.ack) {
                    // only react on not acknowledged state changes
                    if (state.val === undefined || state.val === null) {
                        state.val = '';
                    }
                    this.log.info(`onStateChange(): Extron state ${id} changed: ${state.val} (ack = ${state.ack})`);
                    // extron.[n].[idType].[grpId].[number].[block]
                    //   0     1     2        3       4        5
                    // extron.[n].device.name
                    // extron.[n].in.Inputs.01.preMix
                    // extron.[n].in.auxInputs.01.mixPoints.A01.gain.level
                    // extron.[n].out.outputs.01.attenuation.level
                    // extron.[n].groups.[n].level
                    // extron.[n].dante.available
                    // extron.[n].dante.[deviceName].[fld].[type].[number].[block]
                    //   0     1    2       3          4     5       6        7
                    const baseId = id.slice(0, id.lastIndexOf('.'));
                    const idArray = id.split('.');
                    const dante = idArray[2] == 'dante';
                    const device = dante ? idArray[3] : this.devices[this.config.device].short;
                    const idType = dante ? idArray[4] : idArray[2];
                    const idGrp = Number(!dante ? idArray[3] : idArray[5]);
                    const idBlock = dante ? idArray[7] : idArray[5];
                    const stateName = id.slice(id.lastIndexOf('.') + 1);
                    const timeStamp = Date.now();
                    let stateTime = this.stateBuf[0];
                    let calcMode = 'lin';
                    let elapsed = 0;
                    let member = '';
                    let source = {};
                    if (typeof baseId !== 'undefined' && baseId !== null) {
                        switch (stateName) {
                            case 'mute':
                                if (device === 'smd202') {
                                    this.sendMute(Number(state.val));
                                    break;
                                }
                                if (idType === 'connections') {
                                    this.sendVideoMute(id, state.val);
                                    break;
                                }
                                this.sendMuteStatus(id, state.val);
                                break;

                            case 'source':
                                this.sendSource(id, `${state.val}`);
                                break;

                            case 'level':
                                stateTime = this.stateBuf.find(stateTime => stateTime.id === id); // check if state has already been buffered
                                if (stateTime === undefined) {
                                    this.stateBuf.push({ id: id, timestamp: 0 }); // push state to buffer array
                                    stateTime = this.stateBuf.find(stateTime => stateTime.id === id); // now it should be found
                                }
                                elapsed = timeStamp - stateTime.timestamp; // calcualte elapsed milliseconds since last change
                                if (elapsed > this.config.stateDelay || Number(state.val) <= 10) {
                                    // if configured stateDelay has been exceeded, process the change event
                                    switch (
                                        idBlock // or if value is near 0
                                    ) {
                                        case 'gain':
                                            calcMode = 'linGain';
                                            if (idType === 'auxInputs') {
                                                calcMode = 'linAux';
                                            } else if (device === 'sme211') {
                                                calcMode = 'linAux';
                                            } else {
                                                if (
                                                    id.match(/\.inputs\.\d+\.gain\./) &&
                                                    (source = await this.getStateAsync(`${baseId}.source`)) &&
                                                    source.val > 0
                                                ) {
                                                    calcMode = 'linDig';
                                                } // input configured to digital source
                                            }
                                            break;

                                        case 'premix':
                                            if (device === 'cp82') {
                                                calcMode = 'linAux';
                                            }
                                            break;

                                        case 'postmix':
                                            calcMode = 'linTrim';
                                            break;

                                        case 'attenuation':
                                            calcMode = 'linAtt';
                                            break;
                                    }
                                    stateTime.timestamp = timeStamp; // update stored timestamp
                                    if (device === 'smd202') {
                                        this.sendVol(this.calculateFaderValue(`${state.val}`, 'linAtt'));
                                    } else if (idType === 'groups') {
                                        this.sendGroupLevel(idGrp, Number(state.val));
                                    } else {
                                        if (calcMode === 'linDig') {
                                            this.sendDigGainLevel(
                                                id,
                                                this.calculateFaderValue(`${state.val}`, calcMode),
                                            );
                                        } else {
                                            this.sendGainLevel(id, this.calculateFaderValue(`${state.val}`, calcMode));
                                        }
                                    }
                                } else {
                                    this.log.debug(
                                        `onStateChange(): processing for ${id} = ${state.val} skipped due to statedelay`,
                                    );
                                }
                                break;

                            case 'level_db':
                                calcMode = 'log';
                                switch (idBlock) {
                                    case 'gain':
                                        calcMode = 'logGain';
                                        if (idType === 'auxInputs') {
                                            calcMode = 'logAux';
                                        } else if (idType === 'lineInputs') {
                                            calcMode = 'logAux';
                                        } else {
                                            if (
                                                id.match(/\.inputs\.\d+\.gain\./) &&
                                                (source = await this.getStateAsync(`${baseId}.source`)) &&
                                                source.val > 0
                                            ) {
                                                calcMode = 'logDig';
                                            } // input configured to digital source
                                        }
                                        break;

                                    case 'premix':
                                        if (device === 'cp82') {
                                            calcMode = 'logAux';
                                        }
                                        break;

                                    case 'postmix':
                                        calcMode = 'logTrim';
                                        break;

                                    case 'attenuation':
                                        calcMode = 'logAtt';
                                        break;
                                }
                                if (device === 'smd202') {
                                    this.sendVol(this.calculateFaderValue(`${state.val}`, 'logAtt'));
                                } else if (idType === 'groups') {
                                    this.sendGroupLevel(idGrp, Number(state.val));
                                } else {
                                    if (calcMode === 'logDig') {
                                        this.sendDigGainLevel(id, this.calculateFaderValue(`${state.val}`, calcMode));
                                    } else {
                                        this.sendGainLevel(id, this.calculateFaderValue(`${state.val}`, calcMode));
                                    }
                                }
                                break;

                            case 'status':
                                if (device === 'sme211') {
                                    this.sendStreamState(Number(idArray[4]), Number(state.val));
                                } else {
                                    this.sendDspBlockStatus(id, state.val);
                                }
                                break;

                            case 'threshold':
                                this.sendDynamicsThreshold(
                                    id,
                                    Math.abs(
                                        Number(state.val) < -800 ? -800 : Number(state.val) > 0 ? 0 : Number(state.val),
                                    ),
                                );
                                break;

                            case 'attack':
                            case 'knee':
                            case 'ratio':
                            case 'hold':
                            case 'release':
                                this.log.info(`onStateChange(): dynamics "${stateName}" not yet implemented`);
                                break;

                            case 'frequency':
                            case 'gain':
                            case 'slope':
                            case 'q-factor':
                                this.log.info(`onStateChange(): filter "${stateName}" not yet implemented`);
                                break;

                            case 'playmode':
                                if (device === 'smd202') {
                                    switch (state.val) {
                                        case 0:
                                            this.sendStopVideo();
                                            break;
                                        case 1:
                                            this.sendPlayVideo();
                                            break;
                                        case 2:
                                            this.sendPauseVideo();
                                            break;
                                    }
                                } else {
                                    this.sendPlayMode(id, state.val);
                                }
                                break;

                            case 'repeatmode':
                                this.sendRepeatMode(id, state.val);
                                break;

                            case 'filename':
                                if (this.checkName(`${state.val}`)) {
                                    this.sendFileName(id, `${state.val}`);
                                } else {
                                    this.log.error('onStateChange(): filename includes invalid characters');
                                }
                                break;

                            case 'tie':
                                this.sendTieCommand(baseId, state.val);
                                break;

                            case 'loopmode':
                                this.sendLoopVideo(baseId, state.val ? true : false);
                                break;

                            case 'filepath':
                                this.sendVideoFile(baseId, `${state.val}`);
                                break;

                            case 'streammode':
                                this.sendStreamMode(Number(state.val));
                                break;

                            case 'hdmistatus':
                                this.getHDMIStatus();
                                break;

                            case 'del':
                                this.eraseUserFile(`${state.val}`);
                                break;

                            case 'dir':
                                this.listUserFiles();
                                break;

                            case 'upl':
                                this.loadUserFile(`${state.val}`);
                                break;

                            case 'name':
                                if (this.checkName(`${state.val}`)) {
                                    switch (idType) {
                                        case 'device':
                                            this.getDeviceName(dante ? device : '');
                                            break;

                                        case 'groups':
                                            this.sendGroupName(idGrp, `${state.val}`);
                                            break;

                                        case 'in':
                                        case 'out':
                                            this.sendIOName(id, `${state.val}`);
                                            break;
                                    }
                                } else {
                                    this.log.error('onStateChange(): state name includes invalid characters');
                                }
                                break;

                            case 'type':
                                if (idType == 'groups') {
                                    switch (Number(state.val)) {
                                        case 6: // gain group
                                            this.sendGroupType(idGrp, Number(state.val));
                                            this.setGroupType(idGrp, Number(state.val));
                                            this.sendGroupLimits(idGrp, 120, -1000);
                                            break;

                                        case 12: // mute group
                                            this.sendGroupType(idGrp, Number(state.val));
                                            this.setGroupType(idGrp, Number(state.val));
                                            this.sendGroupLimits(idGrp, 1, 0);
                                            break;

                                        default:
                                            this.log.error(`onStateChange(): groupType ${state.val} not supported`);
                                    }
                                } else {
                                    this.getDspBlockType(id);
                                }
                                break;

                            case 'upperLimit':
                            case 'lowerLimit':
                                // this.sendGroupLimits(idGrp, Number(state.val), Number(state.val));
                                break;

                            case 'members':
                                for (member of `${state.val}`.split(',')) {
                                    this.sendGroupMember(idGrp, `${member}`);
                                }
                                break;

                            case 'deleted':
                                if (state.val == true) {
                                    this.sendDeleteGroup(idGrp);
                                }
                                break;

                            case 'channel':
                                this.sendChannel(Number(state.val));
                                break;

                            case 'presets':
                                this.getPresets();
                                break;

                            case 'connection':
                                if (dante) {
                                    this.sendDanteConnection(device, Number(state.val));
                                }
                                break;

                            case 'available':
                                this.getDanteDevices();
                                break;

                            case 'connected':
                                this.listDanteConnections();
                                break;

                            case 'description':
                                this.getDescription(dante ? device : '');
                                break;

                            case 'model':
                                this.getModel(dante ? device : '');
                                break;

                            case 'pno':
                                this.getDevicePartnumber(dante ? device : '');
                                break;

                            case 'version':
                                this.queryStatus();
                                break;

                            default:
                                this.log.warn(`onStateChange): stateName "${stateName}" unknown`);
                        }
                    }
                }
            } else {
                // The state was deleted
                this.log.info(`onStateChange(): Extron state ${id} deleted`);
            }
        } catch (err) {
            this.errorHandler(err, 'onStateChange');
        }
    }

    /**
     * Called on error situations and from catch blocks
     *
     * @param {any} err the error occured
     * @param {string} module optional, the module in which the error occurred
     */
    errorHandler(err, module = '') {
        const errorStack = err.stack;
        //        if (err.stack) errorStack = err.stack.replace(/\n/g, '<br>');
        if (err.name === 'ResponseError') {
            // gerade nicht benötigt, template ....
            if (err.message.includes('Permission denied') || err.message.includes('Keine Berechtigung')) {
                this.log.error(
                    `errorHandler(): Permisson denied. Check the permission rights of your user on your device!`,
                );
            }
            this.log.error(
                `errorHandler(): Extron error in method: [${module}] response error: ${err.message.replace(module, '')}, stack: ${errorStack}`,
            );
        } else {
            if (module === 'onClientError') {
                if (err.level === 'client-socket') {
                    this.log.error(
                        `errorHandler(): Extron error in [${module}] (sockel level): ${err.message}, stack: ${errorStack}`,
                    );
                } else if (err.level === 'client-ssh') {
                    this.log.error(
                        `errorHandler(): Extron error in [${module}] (ssh): ${err.message}, stack: ${errorStack}, description: ${err.description}`,
                    );
                } else {
                    this.log.error(
                        `errorHandler(): Extron error in [${module}] (${err.level}): ${err.message}, stack: ${errorStack}`,
                    );
                }
            } else {
                this.log.error(
                    `errorHandler(): Extron error in method: [${module}] error: ${err.message}, stack: ${errorStack}`,
                );
            }
        }
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.message" property to be set to true in io-package.json
     *
     * @param {ioBroker.Message} obj the object that was handed over by js-controller
     */
    async onMessage(obj) {
        try {
            //this.log.debug(`onMessage: ${JSON.stringify(obj)}`);
            if (typeof obj === 'object' && obj.command) {
                const sendBack = [];
                const sysConfig = await this.getForeignObjectAsync('system.config');
                const sysLang = sysConfig.common.language;
                let canDanteAnswer = 'no';

                let localRemoteDevices = structuredClone(this.config.remoteDevices);
                /*const newRemoteDevice = {
                    'deviceActive': false,
                    'danteName': 'Device' + Math.floor(Math.random() * 10),
                    'remoteDeviceType': 'NetPA_U_1004',
                    'friendlyName': 'Das Ding' + Math.floor(Math.random() * 100)
                };*/
                this.log.debug(`get command: ${JSON.stringify(obj.command)}`);
                switch (obj.command) {
                    case 'getDeviceTypes':
                        this.log.debug(`onMessage getDeviceTypes: ${JSON.stringify(obj)}`);
                        for (const deviceKey of Object.keys(this.devices)) {
                            if (this.devices[deviceKey].connectionType === 'network') {
                                // only direct connected devices
                                sendBack.push({
                                    label:
                                        this.devices[deviceKey].description[sysLang] ||
                                        this.devices[deviceKey].description.en,
                                    value: deviceKey,
                                });
                            }
                        }
                        this.log.debug(`onMessage send back getDeviceTypes: (lang: ${sysLang}) `);
                        this.sendTo(obj.from, obj.command, sendBack, obj.callback);
                        break;

                    case 'getRemoteDeviceTypes':
                        this.log.debug(`onMessage getRemoteDeviceTypes: ${JSON.stringify(obj)}`);
                        for (const deviceKey of Object.keys(this.devices)) {
                            if (this.devices[deviceKey].connectionType === 'dante') {
                                // only via Dante connected devices
                                sendBack.push({
                                    label:
                                        this.devices[deviceKey].description[sysLang] ||
                                        this.devices[deviceKey].description.en,
                                    value: deviceKey,
                                });
                            }
                        }
                        this.log.debug(`onMessage send back getRemoteDeviceTypes: (lang: ${sysLang}) "${sendBack}"`);
                        this.sendTo(obj.from, obj.command, sendBack, obj.callback);
                        break;

                    case 'canDante':
                        // to enable the dante panel. not functional for now
                        this.log.debug(`onMessage canDante: ${JSON.stringify(obj)}`);
                        canDanteAnswer = 'no';
                        if (obj.message.selectedDevice !== '') {
                            if (this.devices[obj.message.selectedDevice].objects.includes('danterelay')) {
                                canDanteAnswer = 'yes';
                            }
                        }
                        this.sendTo(obj.from, obj.command, canDanteAnswer, obj.callback);
                        break;

                    case 'getRemoteDevices':
                        this.log.debug(`onMessage getRemoteDevices: ${JSON.stringify(obj)}`);
                        // mix native and newly discovered devices
                        this.log.debug(`onMessage this.danteDevices: ${JSON.stringify(this.danteDevices)}`);
                        for (const device of Object.keys(this.danteDevices)) {
                            if (
                                localRemoteDevices.some(item => item.danteName === this.danteDevices[device].danteName)
                            ) {
                                // We found at least one object that we're looking for!
                                this.log.debug(
                                    `onMessage: Value already in remoteDevices: ${this.danteDevices[device].danteName}`,
                                );
                            } else {
                                this.log.debug(
                                    `onMessage: Pushing value : ${this.danteDevices[device].danteName} to remoteDevices`,
                                );
                                localRemoteDevices.push(this.danteDevices[device]);
                            }
                        }
                        this.sendTo(
                            obj.from,
                            obj.command,
                            { native: { remoteDevices: localRemoteDevices } },
                            obj.callback,
                        );
                        break;

                    case 'deleteRemoteDeviceDBObjects':
                        this.log.debug(`onMessage deleteRemoteDeviceDBObjects: ${JSON.stringify(obj)}`);
                        // delete database of the remoteDevice and delete itself from the config object
                        if (obj.message.selectedDevice !== '') {
                            localRemoteDevices.splice(
                                localRemoteDevices.findIndex(item => item.danteName === obj.message.selectedDevice),
                                1,
                            );
                        }
                        this.log.debug(
                            `onMessage: slice: ${obj.message.selectedDevice} and send back: ${JSON.stringify(localRemoteDevices)}`,
                        );
                        this.sendTo(
                            obj.from,
                            obj.command,
                            { native: { remoteDevices: localRemoteDevices } },
                            obj.callback,
                        );
                        break;
                }
            }
        } catch (err) {
            this.errorHandler(err, 'onMessage');
        }
    }
}

// @ts-expect-error parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */

    module.exports = options => {
        'use strict';
        new Extron(options);
    };
} else {
    // otherwise start the instance directly
    new Extron();
}
