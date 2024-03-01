/**
 *
 *      iobroker extron (SIS) Adapter V0.2.3
 *
 *      Copyright (c) 2020-2024, Bannsaenger <bannsaenger@gmx.de>
 *
 *      CC-NC-BY 4.0 License
 *
 */

// The adapter-core module gives you access to the core ioBroker functions
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// @ts-ignore
const fs = require('fs');
// @ts-ignore
const Client = require('ssh2').Client;
const Net = require('net');
// @ts-ignore
const path = require('path');

const errCodes = {
    'E01' : 'Invalid input channel number (out of range)',
    'E10' : 'Unrecognized command',
    'E11' : 'Invalid preset number (out of range)',
    'E12' : 'Invalid port/output number (out of range)',
    'E13' : 'Invalid parameter (number is out of range)',
    'E14' : 'Not valid for this configuration',
    'E17' : 'Invalid command for signal type / system timed out',
    'E18' : 'System/command timed out',
    'E22' : 'Busy',
    'E24' : 'Privilege violation',
    'E25' : 'Device not present',
    'E26' : 'Maximum number of connections exceeded',
    'E27' : 'Invalid event number',
    'E28' : 'Bad filename or file not found',
    'E30' : 'Hardware failure',
    'E31' : 'Attempt to break port passthrough when not set'
};
const maxPollCount = 10;
const invalidChars = ['+','~',',','@','=',"'",'[',']','{','}','<','>','`','"',':',';','|','\\','?'];

class Extron extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'extron',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * called to initialize internal variables
     */
    initVars() {
        this.log.debug('initVars(): Extron initializing internal variables');
        this.sendBuffer = [];   // Send buffer (Array of commands to send)
        this.grpCmdBuf = new Array(65);    // buffer for group command while a group deletion is pending
        this.grpCmdBuf.fill([]);
        // Status variables
        this.isDeviceChecked = false;       // will be true if device sends banner and will be verified
        this.isLoggedIn = false;            // will be true once telnet login completed
        this.isVerboseMode = false;         // will be true if verbose mode 3 is active
        this.initDone = false;              // will be true if all init is done
        this.versionSet = false;            // will be true if the version is once set in the db
        this.device = {'model':'','name':'','version':''}; // will be filled according to device responses
        this.statusRequested = false;       // will be true once device status has been requested after init
        this.statusSended = false;          // will be true once database settings have been sended to device
        this.clientReady = false;           // will be true if device connection is ready
        // Some timers and intervalls
        this.timers = {};
        // Create a client socket to connect to the device
        // first implementation only ssh
        this.debugSSH = false;
        // debug option for full ssh debug log on adapter.log.silly
        this.client = new Client();
        // the SSH shell stream
        // Create a client socket to connect to the device
        this.net = new Net.Socket({'readable':true,'writable' : true});
        this.net.setKeepAlive(true);
        this.net.setNoDelay(true);
        this.stream = undefined;
        this.streamAvailable = true;    // if false wait for continue event
        this.stateList = [];            // will be filled with all existing states
        this.pollCount = 0;             // count sent status query
        this.playerLoaded = [false, false, false, false, false, false, false,false];    // remember which player has a file assigned
        this.auxOutEnabled = [false, false, false, false, false, false, false,false];   // remember which aux output is enabled
        this.groupTypes = new Array(65);    // prepare array to hold the type of groups
        this.groupMembers = new Array(65);  // prepare array to hold actual group members
        this.groupMembers.fill([]);
        this.grpDelPnd = new Array(65); // prepare array to flag group deletions pending
        this.grpDelPnd.fill(false);
        this.fileSend = false;          // flag to signal a file is currently sended
        this.requestDir = false;        // flag to signal a list user files command has been issued and a directory list is to be received
        this.file = {'fileName' : '', 'timeStamp' : '', 'fileSize':''};         // file object
        this.fileList = {'freeSpace' : '', 'files' : [this.file]};              // array to hold current file list
        this.stateBuf = [{'id': '', 'timestamp' : 0}];  // array to hold state changes with timestamp
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        try {
            // Initialize your adapter here
            const startTime = Date.now();
            this.initVars();

            // Reset the connection indicator during startup
            this.setState('info.connection', false, true);

            // The adapters config (in the instance object everything under the attribute "native") is accessible via
            // this.config:
            this.log.info('onReady(): configured host/port: ' + this.config.host + ':' + this.config.port);


            // read Objects template for object generation
            this.objectsTemplate = JSON.parse(fs.readFileSync(__dirname + '/admin/lib/objects_templates.json', 'utf8'));
            // read devices for device check
            this.devices = JSON.parse(fs.readFileSync(__dirname + '/admin/lib/device_mapping.json', 'utf8'));

            /*
            * For every state in the system there has to be also an object of type state
            */
            await this.createDatabaseAsync();
            await this.createStatesListAsync();

            // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
            // this.subscribeStates('testVariable');
            this.subscribeStates('*');  // subscribe to all states

            /*
                setState examples
                you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
            */
            // the variable testVariable is set to true as command (ack=false)
            //await this.setStateAsync('testVariable', true);

            // same thing, but the value is flagged "ack"
            // ack should be always set to true if the value is received from or acknowledged from the target system
            //await this.setStateAsync('testVariable', { val: true, ack: true });

            // same thing, but the state is deleted after 30s (getState will return null afterwards)
            //await this.setStateAsync('testVariable', { val: true, ack: true, expire: 30 });

            // Client callbacks
            switch (this.config.type) {
                case 'ssh' :
                    this.client.on('keyboard-interactive', this.onClientKeyboard.bind(this));
                    this.client.on('ready', this.onClientReady.bind(this));
                    //this.client.on('banner', this.onClientBanner.bind(this));
                    this.client.on('close', this.onClientClose.bind(this));
                    this.client.on('error', this.onClientError.bind(this));
                    this.client.on('end', this.onClientEnd.bind(this));
                    break;

                case 'telnet' :
                    this.net.on('ready', this.onClientReady.bind(this));
                    this.net.on('data', this.onStreamData.bind(this));
                    this.net.on('error', this.onStreamError.bind(this));
                    this.net.on('close', this.onStreamClose.bind(this));
                    this.net.on('drain', this.onStreamContinue.bind(this));
                    this.net.on('end', this.onClientEnd.bind(this));
                    break;
            }
            this.timers.timeoutQueryStatus = setTimeout(this.queryStatus.bind(this), this.config.pollDelay);

            this.log.info(`onReady(): Extron took ${Date.now() - startTime}ms to initialize and setup db`);

            this.clientConnect();
        } catch (err) {
            this.errorHandler(err, 'onReady');
        }
    }

    /**
     * try to connect to the device
     */
    clientConnect() {
        try {
            this.log.info(`clientConnect(): Extron connecting via ${this.config.type} to: ${this.config.host}:${this.config.port}`);
            switch (this.config.type) {
                case 'ssh' :
                    this.client.connect({
                        'host': this.config.host,
                        'port': Number(this.config.port),
                        'username': this.config.user,
                        'password': this.config.pass,
                        'keepaliveInterval': 5000,
                        // @ts-ignore
                        'debug': this.debugSSH ? this.log.silly.bind(this) : undefined,
                        //'debug': true,
                        'readyTimeout': 5000,
                        'tryKeyboard': true
                    });
                    break;

                case 'telnet' :
                    this.stream = this.net.connect(Number(this.config.port), this.config.host);
                    break;
            }
        } catch (err) {
            this.errorHandler(err, 'clientConnect');
        }
    }

    /**
     * reconnect Client after error
     */
    clientReConnect() {
        // clear poll timer
        clearTimeout(this.timers.timeoutQueryStatus); // stop the query timer
        // Status variables to be reset
        switch (this.config.type) {
            case 'ssh' :
                this.client.end();
                break;
            case 'telnet' :
                this.net.destroy();
                break;
        }
        this.initVars();
        this.log.info(`clientReConnect(): reconnecting after ${this.config.reconnectDelay}ms`);
        this.timers.timeoutReconnectClient = setTimeout(this.clientConnect.bind(this),this.config.reconnectDelay);
    }

    /**
     * called if keyboard authentication must be fullfilled
     * @param {string} _name
     * @param {string} _instructions
     * @param {string} _instructionsLang
     * @param {array} _prompts
     * @param {function} finish
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
                case 'ssh' :
                    this.log.info('onClientReady(): Extron is authenticated successfully, now open the stream');
                    this.client.shell(function (error, channel) {
                        try {
                            if (error) throw error;
                            // @ts-ignore
                            this.log.info('onClientReady(): Extron shell established channel');
                            this.stream = channel;
                            // @ts-ignore
                            this.stream.on('error', this.onStreamError.bind(this));
                            // @ts-ignore
                            this.stream.on('close', this.onStreamClose.bind(this));
                            // @ts-ignore
                            this.stream.on('data', this.onStreamData.bind(this));
                            // @ts-ignore
                            this.stream.on('continue', this.onStreamContinue.bind(this));
                            // Set the connection indicator after authentication and an open stream
                            // @ts-ignore
                            this.log.info('onClientReady(): Extron connected');
                            // @ts-ignore
                            this.setState('info.connection', true, true);
                        } catch (err) {
                            // @ts-ignore
                            this.errorHandler(err, 'onClientReady');
                        }
                    });
                    break;
                case 'telnet' :
                    try {
                        this.log.info('onClientReady(): Extron established connection');
                        // Set the connection indicator after authentication and an open stream
                        this.log.info('onClientReady(): Extron connected');
                        this.setState('info.connection', true, true);
                    } catch (err) {
                        this.errorHandler(err, 'onClientReady');
                    }
                    break;
            }
        } catch (err) {
            this.errorHandler(err, 'onClientReady');
        }
    }

    /**
     * called if client has recieved a banner
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
            this.log.info('onClientClose(): Extron client closed');
            // Reset the connection indicator
            this.setState('info.connection', false, true);
            this.clientReady = false;
            this.isDeviceChecked = false;       // will be true if device sends banner and will be verified
            this.isVerboseMode = false;         // will be true if verbose mode 3 is active
            this.initDone = false;              // will be true if all init is done
            this.versionSet = false;            // will be true if the version is once set in the db
            this.statusRequested = false;       // will be true if device status has been requested after init
            this.statusSended = false;          // will be true once database settings have been sended to device
            this.stream = undefined;
        } catch (err) {
            this.errorHandler(err, 'onClientClose');
        }
    }
    /**
     * called if the socket is disconnected
     */
    onClientEnd() {
        try {
            this.log.info('onClientEnd(): Extron client socket disconnected');
            this.setState('info.connection', false, true);
        } catch (err) {
            this.errorHandler(err, 'onClientEnd');
        }
    }
    /**
     * called if client receives an error
     * @param {any} err
     */
    onClientError(err) {
        this.log.info('onClientError(): error detected');
        this.errorHandler(err, 'onClientError');
    }

    /**
     * called to send data to the stream
     * @param {string} data
     */
    streamSend(data) {
        try {
            if (this.streamAvailable) {
                this.log.debug(`streamSend(): Extron sends data to the ${this.config.type} stream: "${this.fileSend?'file data':this.decodeBufferToLog(data)}"`);
                this.setState('info.connection', true, true);
                switch (this.config.type) {
                    case 'ssh' :
                        this.streamAvailable = this.stream.write(data);
                        break;
                    case 'telnet' :
                        this.streamAvailable = this.net.write(data);
                        break;
                }
            } else {
                const bufSize = this.sendBuffer.push(data);
                this.setState('info.connection', false, true);
                this.log.warn(`streamSend(): Extron push data to the send buffer: "${this.fileSend?'file data':this.decodeBufferToLog(data)}" new buffersize:${bufSize}`);
            }
        } catch (err) {
            this.errorHandler(err, 'streamSend');
            this.clientReConnect();
        }
    }

    /**
     * called if stream receives data
     * @param {string | Uint8Array} data
     */
    async onStreamData(data) {
        let members = [];
        const userFileList = [];

        this.streamAvailable = true;    // if we receive data the stream is available
        if (this.fileSend) return; // do nothing during file transmission
        try {
            this.log.debug(`onStreamData(): Extron got data: "${this.decodeBufferToLog(data)}"`);

            if (!this.isDeviceChecked) {        // the first data has to be the banner with device info
                if (data.toString().includes(this.devices[this.config.device].name)) {
                    this.isDeviceChecked = true;
                    this.log.info(`onStreamData(): Device ${this.devices[this.config.device].name} verified`);
                    this.setState('info.connection', true, true);
                    if (this.config.type === 'ssh') {
                        if (!this.isVerboseMode) {          // enter the verbose mode
                            this.switchMode();
                            return;
                        }
                    }
                } else {
                    throw { 'message': 'Device mismatch error',
                        'stack'  : 'Please recreate the instance or connect to the correct device' };
                }
                return;
            }
            if (this.config.type === 'telnet') {
                if (!this.isLoggedIn) {
                    if (data.toString().includes('Password:')) {
                        this.log.info('onStreamData(): Extron received Telnet Password request');
                        this.streamSend(`${this.config.pass}\r`);
                        return;
                    }
                    if (data.toString().includes('Login Administrator')) {
                        this.isLoggedIn = true;
                        this.log.info('onStreamData(): Extron Telnet logged in');
                        this.setState('info.connection', true, true);
                        if (!this.isVerboseMode) {          // enter the verbose mode
                            this.switchMode();
                            return;
                        }
                        return;
                    }
                }
            }

            // iterate through multiple answers connected via [LF]
            for (const cmdPart of data.toString().split('\n')) {

                if (cmdPart.includes('3CV')) {
                    this.log.info('onStreamData(): Extron device switched to verbose mode 3');
                    this.isVerboseMode = true;
                    this.timers.timeoutQueryStatus.refresh();
                    return;
                }
                if (cmdPart.includes('Vrb3')) {
                    this.log.info('onStreamData(): Extron device entered verbose mode 3');
                    this.isVerboseMode = true;
                    if (!this.initDone) {
                        this.streamSend('Q');       // query Version
                        this.streamSend('1I');      // query Model
                        this.streamSend('WCN\r');   // query deviceName
                        this.initDone = true;
                        this.timers.timeoutQueryStatus.refresh();
                        if (this.config.pushDeviceStatus === true) {
                            await this.setDeviceStatusAsync();
                        } else {
                            await this.getDeviceStatusAsync();
                            //this.log.info('Extron get device status diabled ');
                        }
                    }
                    return;
                }
                const answer = cmdPart.replace(/[\r\n]/gm, ''); // remove [CR] and [LF] from string
                // Error handling
                if (answer.match(/^E\d\d/gim)) {    // received an error
                    throw { 'message': 'Error response from device',
                        'stack'  : errCodes[answer] };
                }

                if (this.requestDir && answer.match(/\.\w{3} /)) {
                    this.log.info(`onStreamData(): Extron got file data: "${answer}"`);
                    userFileList.push(answer);
                } else if (this.requestDir && answer.includes('Bytes Left')) {
                    this.log.info(`onStreamData(): Extron got freespace: "${answer}"`);
                    userFileList.push(answer);
                    this.requestDir = false;        // directory list has been received, clear flag
                    this.fileList.freeSpace = '';   // clear free space to be filled with new value from list
                    this.setUserFilesAsync(userFileList);        // call subroutine to set database values
                } else {
                    // lookup the command
                    const matchArray = answer.match(/([A-Z][a-z]+[A-Z]|\w{3})(\d*)\*{0,1},{0,1} {0,1}(.*)/i);
                    if (matchArray) {       // if any match
                        const command = matchArray[1].toUpperCase();
                        const ext1 = matchArray[2] ? matchArray[2] : '';
                        const ext2 = matchArray[3] ? matchArray[3] : '';

                        this.pollCount = 0;     // reset pollcounter as valid data has been received
                        this.timers.timeoutQueryStatus.refresh();   // refresh poll timer

                        switch (command) {
                            case 'VER':             // received a Version (answer to status query)
                                this.log.debug(`onStreamData(): Extron got version: "${ext2}"`);
                                if (!this.versionSet) {
                                    this.versionSet = true;
                                    this.device.version = `${ext2}`;
                                    this.setState('device.version', ext2, true);
                                    this.log.info(`onStreamData(): Extron set version: "${ext2}"`);
                                }
                                break;

                            case 'IPN':             // received a device name
                                this.log.info(`onStreamData(): Extron got devicename: "${ext2}"`);
                                this.device.name = `${ext2}`;
                                this.setState('device.name', ext2, true);
                                break;

                            case 'INF':             // received a device model
                                this.log.info(`onStreamData(): Extron got device model: "${ext2}"`);
                                this.device.model = `${ext2}`;
                                this.setState('device.model', ext2, true);
                                break;

                            case 'DSM':             // received a mute command
                            case 'DSG':             // received a gain level
                                this.log.info(`onStreamData(): Extron got mute/gain ${command} from OID: "${ext1}" value: ${ext2}`);
                                this.setGain(command, ext1, ext2);
                                break;

                            case 'DSD':             //received a set source command
                                this.log.info(`onStreamData(): Extron got source ${command} from OID: "${ext1}" value: "${ext2}"`);
                                this.setSource(ext1, ext2);
                                break;

                            case 'DSE' :            //received a limiter status change
                                this.log.info(`onStreamData(): Extron got a limiter status change from OID : "${ext1}" value: "-${ext2}"`);
                                this.setLimitStatus(ext1, ext2);
                                break;
                            case 'DST' :            //received a limiter threshold change
                                this.log.info(`onStreamData(): Extron got a limiter threshold change from OID : "${ext1}" value: "${ext2}"`);
                                this.setLimitThreshold(ext1, ext2);
                                break;

                            case 'PLAY':             //received a play mode command
                                this.log.info(`onStreamData(): Extron got play mode ${command} for Player: "${ext1}" value: "${ext2}"`);
                                this.setPlayMode(ext1, ext2);
                                break;

                            case 'CPLYA':           //received a file association to a player
                                this.log.info(`onStreamData(): Extron got filename for Player: "${ext1}" value: "${ext2}"`);
                                this.setFileName(ext1, ext2);
                                break;

                            case 'CPLYM':           //received a set repeat mode command
                                this.log.info(`onStreamData(): Extron got repeat mode ${command} for Player: "${ext1}" value: "${ext2}"`);
                                this.setRepeatMode(ext1, ext2);
                                break;

                            case 'IN1':             // received a tie command from CrossPoint
                            case 'IN2':
                            case 'IN3':
                            case 'IN4':
                            case 'IN5':
                            case 'IN6':
                            case 'IN7':
                            case 'IN8':
                                this.log.info(`onStreamData(): Extron got tie command ${command} for output: ${ext2}`);
                                this.setTie(command, ext2);
                                break;

                            case 'LOUT':            // received a tie command for loop out
                                this.log.info(`onStreamData(): Extron got tie command input "${ext1}" to loop output`);
                                this.setState(`connections.3.tie`, Number(ext1), true);
                                break;

                            case 'VMT':             // received a video mute
                                this.log.info(`onStreamData(): Extron got video mute for output "${ext1}" value "${ext2}"`);
                                if (this.devices[this.config.device].short === 'sme211') this.setState(`connections.1.mute`, Number(ext1), true);
                                else this.setState(`connections.${ext1}.mute`, Number(ext2), true);
                                break;

                            // Begin SMD202 specific commands
                            case 'PLYRS' :          // received video playing
                                this.log.info(`onStreamData(): Extron got video playmode for player "${ext1}" value "${ext2}"`);
                                this.setPlayVideo(`player.`,ext1, 2-Number(ext2));
                                break;
                            case 'PLYRE' :           // received Video paused
                                this.log.info(`onStreamData(): Extron got video paused for player "${ext1}" value "${ext2}"`);
                                this.setPlayVideo(`player.`, ext1, 2);
                                break;
                            case 'PLYRO' :          // received video stopped
                                this.log.info(`onStreamData(): Extron got video stopped for player "${ext1}" value "${ext2}"`);
                                this.setPlayVideo(`player.`, ext1, 0);
                                break;
                            case 'PLYRR' :          // received loop state
                                this.log.info(`onStreamData(): Extron got video loop mode for player "${ext1}" value "${ext2}"`);
                                this.setLoopVideo(`player.`,ext1, ext2);
                                break;
                            case 'PLYRU' :          // received video filepath
                                this.log.info(`onStreamData(): Extron got video video filepath for player "${ext1}" value "${ext2}"`);
                                this.setVideoFile(`player.`,ext2);
                                this.getChannel();
                                break;
                            case 'PLYRY' :
                                this.log.info(`onStreamData(): Extron got video playmode for player "${ext1}" value "${ext2}"`);
                                this.setPlayVideo(`player.`,ext1, Number(ext2));
                                break;
                            case 'PLYRL' :
                                this.log.info(`onStreamData(): Extron got current playlist for player "${ext1}" value "${ext2}", requesting filepath`);
                                this.getVideoFile();
                                break;
                            case 'TVPRT' :
                                this.log.info(`onStreamData(): Extron got current channel for player "${ext1}" value "${ext2}"`);
                                this.setChannel(`player.`, ext2);
                                break;
                            case 'AMT'  :
                                this.log.info(`onStreamData(): Extron got Audio Output mute status value "${ext1}"`);
                                this.setMute('output.attenuation.', Number(ext1));
                                break;
                            case 'VOL' :
                                this.log.info(`onStreamData(): Extron got Audio Output attenuation level value "${Number(`${ext1}${ext2}`)}"`);
                                this.setVol('output.attenuation.', this.calculateFaderValue(Number(`${ext1}${ext2}`),'logAtt'));
                                break;

                            // End SMD202 specific commands
                            case 'STRMY' :
                                this.log.info(`onStreamData(): Extron got streammode "${ext1}"`);
                                this.setStreamMode(`ply.players.1.common.`,Number(ext1));
                                break;

                            case 'UPL' :
                                this.fileSend = false;   // reset file transmission flag
                                this.log.info(`onStreamData(): Extron got upload file confirmation command size: "${ext1}" name: "${ext2}"`);
                                break;
                            case 'WDF' :
                                this.log.info(`onStreamData(): Extron got list directory command`);
                                this.requestDir = true;     // set directory transmission flag
                                break;
                            case 'W+UF' :
                                this.log.info(`onStreamData(): Extron got upload file command: ${ext1} ${ext2}`);
                                this.fileSend = true;   // set file transmission flag
                                break;

                            case 'GRPMZ' :      // delete Group command
                                this.log.info(`onStreamData(): Extron got group #"${ext1} deleted`);
                                this.grpDelPnd[Number(ext1)] = false;   // flag group deletion confirmation
                                this.setState(`groups.${ext1.padStart(2,'0')}.deleted`,true,true); // confirm group deletion in database
                                //this.setState(`groups.${ext1.padStart(2,'0')}.members`,'',true);
                                //this.groupMembers[Number(ext1)] = [];       // delete group members
                                this.setGroupMembers(Number(ext1),[]);
                                this.sendGrpCmdBuf(Number(ext1)); // process group commands queued during pending deletion
                                /*
                                this.groupTypes[Number(ext1)] = undefined;  // reset group type
                                this.getGroupType(Number(ext1));    // request group type update
                                this.getGroupMembers(Number(ext1)); // request group mebers update
                                */
                                break;
                            case 'GRPMD' :      // set Group fader value
                                this.log.info(`onStreamData(): Extron got group #'${ext1}" fader value:"${ext2}"`);
                                this.setGroupLevel(Number(ext1),Number(ext2));
                                break;
                            case 'GRPMP' :      // set Group type
                                this.log.info(`onStreamData(): Extron got group #"${ext1}" type: "${ext2}"`);
                                this.setGroupType(Number(ext1), Number(ext2));
                                break;
                            case 'GRPMO' :      // add group member
                                members = ext2.split('*');
                                this.log.info(`onStreamData(): Extron got group #"${ext1}" member(s): "${members}"`);
                                this.setGroupMembers(Number(ext1),members);
                                break;
                            case 'GRPML' :      // set group limits
                                this.log.info(`onStreamData(): Extron got group #"${ext1}" limits upper: "${ext2.split('*')[0]}" lower: "${ext2.split('*')[1]}""`);
                                this.setGroupLimits(Number(ext1),Number(ext2.split('*')[0]),Number(ext2.split('*')[1]));
                                break;
                            case 'GRPMN' :      // group name
                                this.log.info(`onStreamData(): Extron got group #"${ext1}" name: "${ext2}"`);
                                this.setGroupName(Number(ext1), ext2);
                                break;

                            case 'NMI' :   // I/O Name
                            case 'NML' :
                            case 'NEI' :
                            case 'NMO' :
                            case 'NEX' :
                            case 'EXPDA' :
                                this.log.info(`onStreamData(): Extron got I/O Name "${ext2}" for I/O: "${this.oid2id(`${command}${ext1}`)}"`);
                                this.setIOName(`${command}${ext1}`, ext2);
                                break;
                        }
                    } else {
                        if ((answer != 'Q') && (answer != '') && (this.fileSend === false) && !(answer.match(/\d\*\d\w+/)) && !(answer.match(/\d\w/))) {
                            this.log.warn('onStreamData(): Extron received data which cannot be handled "' + cmdPart + '"');
                        }
                    }
                }
            }
        } catch (err) {
            this.errorHandler(err, 'onStreamData');
            // @ts-ignore
            if (err.message === 'Device mismatch error') this.terminate('Device mismatch error');
        }
    }

    /**
     * called if stream receives data
     * @param {string | Uint8Array} data
     */
    decodeBufferToLog(data) {
        try {
            let retString = '';
            let dataString = '';
            if (typeof(data) === 'string')  {
                dataString = data;
            } else {
                dataString = data.toString();
            }
            for (let i = 0; i < dataString.length ; i++) {
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
            this.streamSend(this.sendBuffer.pop());
        } catch (err) {
            this.errorHandler(err, 'onStreamContinue');
        }
    }

    /**
     * called if stream receives an error
     * @param {any} err
     */
    onStreamError(err) {
        this.errorHandler(err, 'onStreamError');
        this.log.warn('onSteamError(): Extron is calling clientReConnect');
        this.clientReConnect();
    }

    /**
     * called if stream is closed
     */
    onStreamClose() {
        this.log.debug('onStreamClose(): clear query timer');
        clearTimeout(this.timers.timeoutQueryStatus); // stop the query timer
        try {
            switch (this.config.type) {
                case 'ssh' :
                    this.log.info('onStreamClose(): Extron stream closed, now calling client.end()');
                    this.client.end();
                    break;
                case 'telnet' :
                    this.log.info('onStreamClose(): Extron stream closed, now calling net.destroy()');
                    this.net.destroy();
                    break;
            }
            this.setState('info.connection', false, true);
        } catch (err) {
            this.errorHandler(err, 'onStreamClose');
        }
    }

    /**
     * called to switch the verbose mode
     */
    switchMode() {
        try {
            this.log.debug('switchMode(): Extron switching to verbose mode 3');
            this.streamSend('W3CV\r');
        } catch (err) {
            this.errorHandler(err, 'switchMode');
        }
    }

    /**
     * called to send a status query
     */
    queryStatus() {
        try {
            if (this.pollCount > maxPollCount) {
                this.log.error('queryStatus(): maxPollCount exceeded');
                this.pollCount = 0;
                this.clientReConnect();
            } else {
                if (typeof this.timers.timeoutQueryStatus !== 'undefined') this.timers.timeoutQueryStatus.refresh();
                if (!this.fileSend) {
                    this.streamSend('Q');
                    this.pollCount += 1;
                    this.log.debug(`queryStatus(): Extron send a status query #${this.pollCount}`);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'queryStatus');
        }
    }

    /**
     * called to set up the database dependant on the device type
     */
    async createDatabaseAsync() {
        try {
            // create the common section
            for (const element of this.objectsTemplate.common) {
                await this.setObjectNotExistsAsync(element._id, element);
            }
            // if cp82 or sme211 : create video inputs and outputs
            if ((this.devices[this.config.device].short === 'cp82') || (this.devices[this.config.device].short === 'sme211')) {
                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].connections) {
                    await this.setObjectNotExistsAsync(element._id, element);
                }
            }
            // if smde202 : create video player
            if (this.devices[this.config.device].short === 'smd202') {
                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].players) {
                    await this.setObjectNotExistsAsync(element._id, element);
                }
                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].outputs) {
                    await this.setObjectNotExistsAsync(element._id, element);
                }
            }
            // if we have a user filesystem on the device
            if (this.devices[this.config.device] && this.devices[this.config.device].fs) {
                await this.setObjectNotExistsAsync(this.objectsTemplate.userflash.filesystem._id, this.objectsTemplate.userflash.filesystem);
                await this.setObjectNotExistsAsync(this.objectsTemplate.userflash.directory._id, this.objectsTemplate.userflash.directory);
                await this.setObjectNotExistsAsync(this.objectsTemplate.userflash.upload._id, this.objectsTemplate.userflash.upload);
                await this.setObjectNotExistsAsync(this.objectsTemplate.userflash.freespace._id, this.objectsTemplate.userflash.freespace);
                await this.setObjectNotExistsAsync(this.objectsTemplate.userflash.filecount._id, this.objectsTemplate.userflash.filecount);
                await this.setObjectNotExistsAsync(this.objectsTemplate.userflash.file._id, this.objectsTemplate.userflash.file);
            }
            // if we have inputs on the device
            if (this.devices[this.config.device] && this.devices[this.config.device].in) {
                // at this point the device has inputs
                await this.setObjectNotExistsAsync('in', {
                    'type': 'folder',
                    'common': {
                        'name': 'All input types'
                    },
                    'native': {}
                });
                for (const inputs of Object.keys(this.devices[this.config.device].in)) {
                    // create input folder, key name is the folder id
                    await this.setObjectNotExistsAsync(`in.${inputs}`, {
                        'type': 'folder',
                        'common': {
                            'name': this.devices[this.config.device].in[inputs].name
                        },
                        'native': {}
                    });
                    // for each input type create the amount of inputs
                    for (let i = 1; i <= this.devices[this.config.device].in[inputs].amount; i++) {
                        const actInput = `in.${inputs}.${i.toString().padStart(2,'0')}`;
                        // create the input folder
                        await this.setObjectNotExistsAsync(actInput, this.objectsTemplate[this.devices[this.config.device].objects[1]].input);
                        // and the common structure of an input depending on type
                        switch (inputs) {

                            case 'inputs' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].inputs) {
                                    await this.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'lineInputs' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].lineInputs) {
                                    await this.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'playerInputs' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].playerInputs) {
                                    await this.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'programInputs' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].programInputs) {
                                    await this.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'videoInputs' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].videoInputs) {
                                    await this.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'auxInputs' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].auxInputs) {
                                    await this.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'virtualReturns' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].virtualReturns) {
                                    await this.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'expansionInputs' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].expansionInputs) {
                                    await this.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                        }
                        // now the mixpoints are created
                        if (this.devices[this.config.device] && this.devices[this.config.device].mp) {      // if we have mixpoints
                            if (inputs != 'videoInputs') {
                                for (const outType of Object.keys(this.devices[this.config.device].out)) {
                                    for (let j = 1; j <= this.devices[this.config.device].out[outType].amount; j++) {
                                        if (i === j && outType === 'virtualSendBus') {
                                            continue;       // these points cannot be set
                                        }
                                        const actMixPoint = actInput + '.mixPoints.' + this.devices[this.config.device].out[outType].short + j.toString().padStart(2,'0');
                                        await this.setObjectNotExistsAsync(actMixPoint, {
                                            'type': 'folder',
                                            'common': {
                                                'role': 'mixpoint',
                                                'name': `Mixpoint ${outType} number ${j}`
                                            },
                                            'native': {}
                                        });
                                        for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].mixPoints) {
                                            await this.setObjectNotExistsAsync(actMixPoint + '.' + element._id, element);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // if we have players on the device
            if (this.devices[this.config.device] && this.devices[this.config.device].ply) {
                // at this point the device has players
                await this.setObjectNotExistsAsync('ply', {
                    'type': 'folder',
                    'common': {
                        'name': 'All players'
                    },
                    'native': {}
                });
                for (const players of Object.keys(this.devices[this.config.device].ply)) {
                    // create player folder, key name is the folder id
                    await this.setObjectNotExistsAsync(`ply.${players}`, {
                        'type': 'folder',
                        'common': {
                            'name': this.devices[this.config.device].ply[players].name
                        },
                        'native': {}
                    });
                    // create the amount of players
                    for (let i = 1; i <= this.devices[this.config.device].ply[players].amount; i++) {
                        const actPlayer = `ply.${players}.${i}`;
                        // create the player folder
                        await this.setObjectNotExistsAsync(actPlayer, this.objectsTemplate[this.devices[this.config.device].objects[1]].player);
                        // and the common structure of a player
                        for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].players) {
                            await this.setObjectNotExistsAsync(actPlayer + '.' + element._id, element);
                        }
                    }
                }
            }
            // if we have outputs on the device
            if (this.devices[this.config.device] && this.devices[this.config.device].out) {
                // at this point the device has outputs
                await this.setObjectNotExistsAsync('out', {
                    'type': 'folder',
                    'common': {
                        'name': 'All outputs'
                    },
                    'native': {}
                });
                for (const outputs of Object.keys(this.devices[this.config.device].out)) {
                    // create outputs folder, key name is the folder id
                    await this.setObjectNotExistsAsync(`out.${outputs}`, {
                        'type': 'folder',
                        'common': {
                            'name': this.devices[this.config.device].out[outputs].name
                        },
                        'native': {}
                    });
                    // create the amount of outputs
                    for (let i = 1; i <= this.devices[this.config.device].out[outputs].amount; i++) {
                        const actOutput = `out.${outputs}.${i.toString().padStart(2,'0')}`;
                        // create the output folder
                        await this.setObjectNotExistsAsync(actOutput, this.objectsTemplate[this.devices[this.config.device].objects[1]].output);
                        // and the common structure of a output
                        switch (outputs) {
                            case 'outputs' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].outputs) {
                                    await this.setObjectNotExistsAsync(actOutput + '.' + element._id, element);
                                }
                                break;

                            case 'auxOutputs' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].auxOutputs) {
                                    await this.setObjectNotExistsAsync(actOutput + '.' + element._id, element);
                                }
                                break;

                            case 'expansionOutputs' :
                                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].expansionOutputs) {
                                    await this.setObjectNotExistsAsync(actOutput + '.' + element._id, element);
                                }
                                break;
                        }
                    }
                }
            }
            // if cp82 : create groupss
            if (this.devices[this.config.device].short === 'cp82') {
                for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].groups) {
                    await this.setObjectNotExistsAsync(element._id, element);
                }
            }
            // if we have groups on the device
            if (this.devices[this.config.device] && this.devices[this.config.device].grp) {
                await this.setObjectNotExistsAsync('groups', {
                    'type': 'folder',
                    'common': {
                        'name': 'All Groups'
                    },
                    'native': {}
                });
                // create the amount of groups
                for (let i = 1; i <= this.devices[this.config.device].grp.groups.amount; i++) {
                    const actGroup = `groups.${i.toString().padStart(2,'0')}`;
                    // create the group folder
                    await this.setObjectNotExistsAsync(actGroup, this.objectsTemplate[this.devices[this.config.device].objects[1]].group);
                    // and the common structure of a group
                    for (const element of this.objectsTemplate[this.devices[this.config.device].objects[1]].groups) {
                        await this.setObjectNotExistsAsync(actGroup + '.' + element._id, element);
                    }
                }
            }
        } catch (err) {
            this.errorHandler(err, 'createDatabase');
        }
    }

    /**
     * called to create a list of all states in the database
     */
    async createStatesListAsync(){
        this.stateList = Object.keys(await this.getStatesAsync('*'));
    }

    /**
     * called to get all database item status from device
     */
    async getDeviceStatusAsync() {
        try {
            // if status has not been requested
            if (!this.statusRequested && this.isVerboseMode) {
                this.log.info('Extron request device status started');
                // iterate through stateList to request status from device
                for (let index = 0; index < this.stateList.length; index++) {
                    const id = this.stateList[index];
                    const baseId = id.slice(0, id.lastIndexOf('.'));
                    const stateName = id.slice(id.lastIndexOf('.') + 1);
                    const idArray = id.split('.');
                    const idType = idArray[2];
                    const grpId = Number(idArray[3]);

                    if (typeof(baseId) !== 'undefined' && baseId !== null) {
                        // @ts-ignore
                        switch (stateName) {
                            case 'mute' :
                                if (this.devices[this.config.device].short === 'smd202') this.getMute();
                                else if (idType === 'connections') this.getVideoMute(id);
                                else this.getMuteStatus(id);
                                break;

                            case 'source' :
                                if (this.devices[this.config.device].short === 'cp82' && !id.match(/videoInputs\.1[3456]\./)) break; // on CP82 only video line inputs 12..15 have a source attribute indicating signal presence
                                this.getSource(id);
                                break;

                            case 'level' :
                                if (this.devices[this.config.device].short === 'smd202') this.getVol();
                                else if (idType ==='groups') this.getGroupLevel(grpId);
                                else this.getGainLevel(id);
                                break;

                            case 'playmode' :
                                if (this.devices[this.config.device].short === 'smd202') this.getPlayVideo();
                                else this.getPlayMode(id);
                                break;

                            case 'repeatmode' :
                                this.getRepeatMode(id);
                                break;

                            case 'filename' :
                                this.getFileName(id);
                                break;

                            case 'filepath' :
                                if (this.devices[this.config.device].short === 'sme211') break; // not supported on SME211
                                this.getVideoFile();
                                break;

                            case 'loopmode' :
                                this.getLoopVideo();
                                break;

                            case 'streammode' :
                                this.getStreamMode();
                                break;

                            case 'dir' :
                                this.listUserFiles();
                                break;

                            case 'status' :
                                this.getLimitStatus(id);
                                break;

                            case 'threshold':
                                this.getLimitThreshold(id);
                                break;

                            case 'name' :
                                if (idType ==='groups') {
                                    this.getGroupName(grpId);
                                } else this.getIOName(id);
                                break;

                            case 'type' :
                                this.getGroupType(grpId);
                                break;

                            case 'upperLimit' :
                            case 'lowerLimit' :
                                this.getGroupLimits(grpId);
                                break;

                            case 'members' :
                                this.getGroupMembers(grpId);
                                break;

                            case 'channel' :
                                this.getChannel();
                                break;
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
     * called to set all database item states to device
     */
    async setDeviceStatusAsync() {
        try {
            // if status has not been requested
            if (!this.statusSended && this.isVerboseMode) {
                this.log.info('Extron set device status started');
                // iterate through stateList to send status to device
                for (let index = 0; index < this.stateList.length; index++) {
                    const id = this.stateList[index];
                    const state = await this.getStateAsync(id);
                    // @ts-ignore
                    state.ack = false;
                    this.onStateChange(id, state);
                    /**
                    const baseId = id.slice(0, id.lastIndexOf('.'));
                    const idArray = id.split('.');
                    const idType = idArray[3];
                    const idBlock = idArray[5];
                    const stateName = id.slice(id.lastIndexOf('.') + 1);
                    let calcMode ='lin';

                    if (typeof(baseId) !== 'undefined' && baseId !== null) {
                        // @ts-ignore
                        if (state !== null) switch (stateName) {
                            case 'mute' :
                                this.sendMuteStatus(baseId, state.val);
                                break;

                            case 'source' :
                                this.sendSource(id, Number(state.val));
                                break;

                            case 'level' :
                                switch (idBlock) {
                                    case 'gain' :
                                        calcMode = 'linGain';
                                        if (idType === 'auxInputs') calcMode = 'linAux';
                                        if (idType === 'lineInputs') calcMode = 'linAux';
                                        break;

                                    case 'postmix' :
                                        calcMode = 'linTrim';
                                        break;

                                    case 'attenuation' :
                                        calcMode = 'linAtt';
                                        break;
                                }
                                value = this.calculateFaderValue(Number(state.val),calcMode);
                                this.sendGainLevel(id,value);
                                break;

                            case 'playmode' :
                                this.sendPlayMode(baseId, state.val);
                                break;

                            case 'repeatmode' :
                                this.sendRepeatMode(baseId, state.val);
                                break;

                            case 'filename' :
                                this.sendFileName(baseId, state.val.toString());
                                this.playerLoaded[Number(this.id2oid(baseId))-1] = (state.val.toString() != '' ? true : false);
                                break;

                            case 'streammode' :
                                this.sendStreamMode(Number(state.val));
                                break;
                        }
                    }
                    */
                }
                this.statusSended = true;
                this.log.info('Extron set device status completed');
            }
        } catch (err) {
            this.errorHandler(err, 'setDeviceStatus');
        }
    }

    /**
     * check names for invalid characters
     * @param {string} name
     * @returns {boolean}
     */
    checkName(name) {
        for (const char of invalidChars) {
            if (name.includes(char)) return false;
        }
        return true;
    }

    /**
     * calculate linValue -> logValue -> devValue and back
     * @param {number | string | undefined} value
     * @param {string} type
     * Type of value provided:
     * dev,  lin, log (-1000 .. 120, 0 .. 1000, -100 .. 12)
     * devGain, linGain, logGain (-180 .. 800, 0 .. 1000, -18 .. 80)
     * devAux, linAux, logAux (-180 .. 240, 0.. 1000, -18 .. 24)
     * devTrim, linTrim, logTrim (-120 .. 120, 0 .. 1000, -12 .. 12)
     * devAtt, linAtt, logAtt (-1000 .. 0, 0 .. 1000, -100 .. 0)
     * returns: Object with all 3 value types
     */
    calculateFaderValue(value, type) {
        const locObj = {};

        try {
            if (typeof value === 'undefined') return {};
            if (typeof value === 'string') value = Number(value);

            switch (type) {

                case 'lin':        // linear value 0 .. 1000 from database
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
                        locObj.logValue = ((((value - 650) / 400) * 25)-5).toFixed(1);
                        locObj.devValue = ((((value - 650) / 400) * 250)-50).toFixed(0);
                    } else if (value >= 2) {
                        locObj.logValue = ((((value - 250) / 250) * 40)-30).toFixed(1);
                        locObj.devValue = ((((value -250) / 250) * 400)-300).toFixed(0);
                    } else {
                        locObj.logValue = '-100.0';
                        locObj.devValue = '-1000';
                    }
                    break;

                case 'log':        // value from database -100.0 .. 12.0
                case 'dev':        // value from device -1000 .. 120
                    if (type === 'log') value = value * 10;
                    value = value > 120 ? 120 : value;
                    value = value < -1000 ? -1000 : value;

                    locObj.logValue = (value / 10).toFixed(1);
                    locObj.devValue = value.toFixed(0);

                    //value = value * 10;
                    if (value < 0) {
                        locObj.linValue = (((value + 1000) * 764) / 1000).toFixed(0);
                    } else {
                        locObj.linValue = (((value * 236) / 120) + 764).toFixed(0);
                    }
                    break;

                case 'linGain':      // linear value from database 0 .. 1000 for Input
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 980 / 1000) - 180).toFixed(0);
                    locObj.logValue = ((value * 98 / 1000) - 18).toFixed(1);
                    break;

                case 'logGain':      // value from database -18.0 .. 80.0 for input
                case 'devGain':      // value from device -180 .. 800 for input
                    value = value > 800 ? 800 : value;
                    value = value < -180 ? -180 : value;
                    if (type === 'logGain') value = value * 10;

                    locObj.logValue = (value / 10).toFixed(1);
                    locObj.devValue = (value).toFixed(0);
                    locObj.linValue = ((value + 180) * 1000 / 980).toFixed(0);
                    break;

                case 'linAux':   //linear value from database 0 .. 1000 for AuxInput
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 420 / 1000) - 180).toFixed(0);
                    locObj.logValue = ((value * 42 / 1000) - 18).toFixed(1);
                    break;

                case 'logAux':      // value from database -18.0 .. 24.0 for input
                case 'devAux':      // value from device -180 .. 240 for input
                    value = value > 240 ? 240 : value;
                    value = value < -180 ? -180 : value;
                    if (type === 'logAux') value = value * 10;

                    locObj.logValue = (value / 10).toFixed(1);
                    locObj.devValue = (value).toFixed(0);
                    locObj.linValue = ((value + 180) * 1000 / 420).toFixed(0);
                    break;

                case 'logTrim' :       // value from database -12.0 .. 12.0 for PostMix Trim
                case 'devTrim' :       // value from device -120 .. 120 for PostMix Trim
                    value = value > 120 ? 120 : value;
                    value = value < -120 ? -120 : value;
                    if (type === 'logTrim') value = value * 10;

                    locObj.logValue = (value / 10).toFixed(1);
                    locObj.devValue = (value).toFixed(0);
                    locObj.linValue = ((value + 120) * 1000 / 240).toFixed(0);
                    break;

                case 'linTrim' :       // linear value from database 0 ..1000 for PostMix Trim
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 240 / 1000) - 120).toFixed(0);
                    locObj.logValue = ((value * 24 / 1000) - 12).toFixed(1);
                    break;

                case 'logAtt' :        // value from database -100 .. 0 for output attenuation
                case 'devAtt' :        //  value from device -1000 .. 0 for output attenuation
                    value = value > 0 ? 0 : value;
                    value = value < -1000 ? -1000 : value;
                    if (type === 'logAtt') value = value * 10;

                    locObj.logValue = (value / 10).toFixed(1);
                    locObj.devValue = (value).toFixed(0);
                    locObj.linValue = (value + 1000).toFixed(0);
                    break;

                case 'linAtt' :        // value from database 0 .. 1000 for output attenuation
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = (value - 1000).toFixed(0);
                    locObj.logValue = ((value / 10) - 100).toFixed(1);
                    break;

            }
        } catch (err) {
            this.errorHandler(err, 'calculateFaderValue');
        }

        return locObj;
    }

    /** BEGIN Input and Mix control */
    /**
     * Set the database values for a mixpoint or channel
     * @param {string} cmd
     * @param {string} oid
     * @param {string | boolean} value
     * cmd = DSM (mute), DSG (gain)
     */
    setGain(cmd, oid, value) {
        try {
            const mixPoint = this.oid2id(oid);
            const idArray = mixPoint.split('.');
            const idType = idArray[1];
            const idBlock = idArray[3];
            let calcMode ='dev';
            if (cmd === 'DSM') {
                this.setState(`${mixPoint}mute`, Number(value) >0 ? true : false, true);
            } else {
                switch (idBlock) {
                    case 'gain' :
                        calcMode = 'devGain';
                        if (idType === 'auxInputs') calcMode = 'devAux';
                        if (this.devices[this.config.device].short === 'sme211') calcMode = 'devAux';
                        break;

                    case 'postmix' :
                        calcMode = 'devTrim';
                        break;

                    case 'attenuation' :
                        calcMode = 'devAtt';
                        break;
                }

                const faderVal = this.calculateFaderValue(value.toString(), calcMode);
                if (faderVal) {
                    this.setState(`${mixPoint}level_db`, Number(faderVal.logValue), true);
                    this.setState(`${mixPoint}level`, Number(faderVal.linValue), true);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'setGain');
        }
    }

    /**
     * Send the mute status to the device
     * @param {string} baseId
     * @param {string | boolean | number} value
     */
    sendMuteStatus(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WM${oid}*${Number(value)>0 ? '1' : '0'}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendMuteStatus');
        }
    }

    /**
     * request the mute status from device
     * @param {string} baseId
     */
    getMuteStatus(baseId) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WM${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getMuteStatus');
        }
    }

    /**
     * Send the gain level to the device
     * @param {string} baseId
     * @param {string | any} value
     */
    sendGainLevel(baseId, value) {
        try {
            let oid = this.id2oid(baseId);
            if (oid) {
                let sendData = `WG${oid}*${value.devValue}AU\r`;
                this.streamSend(sendData);
                if (this.devices[this.config.device].short === 'sme211') { // on SME211 we have stereo controls
                    switch (Number(oid)) {
                        case 40000 :
                            oid = '40001';
                            break;
                        case 40001 :
                            oid = '40000';
                            break;
                        case 40002 :
                            oid = '40003';
                            break;
                        case 40003 :
                            oid = '40002';
                            break;
                    }
                    sendData = `WG${oid}*${value.devValue}AU\r`;
                    this.streamSend(sendData);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'sendGainLevel');
        }
    }

    /**
     * get the gain level from device
     * @param {string} baseId
     */
    getGainLevel(baseId) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WG${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendGainLevel');
        }
    }

    /**
     * Set the source for a auxinput
     * @param {string} oid
     * @param {string | number} value
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
     * @param {string} baseId
     * @param {string | number} value
     */
    sendSource(baseId, value) {
        try {
            const oid = this.id2oid(`${baseId}.source`);
            if (oid) {
                this.streamSend(`WD${oid}*${value === '' ? 0: value}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendSource');
        }
    }

    /**
     * get the source mode from device
     * @param {string} baseId
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
     * @param {string} Id
     */
    getIOName(Id) {
        try {
            const ioType = Id.split('.')[3];
            const ioNumber = Number(Id.split('.')[4]);
            switch (ioType) {
                case 'inputs' :
                    this.streamSend(`W${ioNumber}NI\r`);
                    break;
                case 'auxInputs' :
                    this.streamSend(`W${ioNumber+12}NI\r`);
                    break;
                case 'virtualReturns' :
                    this.streamSend(`W${ioNumber}NL\r`);
                    break;
                case 'expansionInputs':
                    this.streamSend(`WA${ioNumber}EXPD\r`);
                    //this.streamSend(`W${ioNumber}NE\r`);
                    break;
                case 'outputs' :
                    this.streamSend(`W${ioNumber}NO\r`);
                    break;
                case 'auxOutputs' :
                    this.streamSend(`W${ioNumber+8}NO\r`);
                    break;
                case 'expansionOutputs' :
                    this.streamSend(`W${ioNumber}NX\r`);
                    break;
            }
        } catch (err) {
            this.errorHandler(err, 'getIOName');
        }
    }

    /**
     * send the i/o name to device
     * @param {string} Id
     * @param {string} name
     */
    sendIOName(Id, name) {
        try {
            const ioType = Id.split('.')[3];
            const ioNumber = Number(Id.split('.')[4]);
            switch (ioType) {
                case 'inputs' :
                    this.streamSend(`W${ioNumber},${name}NI\r`);
                    break;
                case 'auxInputs' :
                    this.streamSend(`W${ioNumber+12},${name}NI\r`);
                    break;
                case 'virtualReturns' :
                    this.streamSend(`W${ioNumber},${name}NL\r`);
                    break;
                case 'expansionInputs':
                    this.streamSend(`WA${ioNumber}*${name}EXPD\r`);
                    //this.streamSend(`W${ioNumber},${name}NE\r`);
                    break;
                case 'outputs' :
                    this.streamSend(`W${ioNumber},${name}NO\r`);
                    break;
                case 'auxOutputs' :
                    this.streamSend(`W${ioNumber+8},${name}NO\r`);
                    break;
                case 'expansionOutputs' :
                    this.streamSend(`W${ioNumber},${name}NX\r`);
                    break;
            }
        } catch (err) {
            this.errorHandler(err, 'sendIOName');
        }
    }

    /**
     * set the i/o name from device
     * @param {string} IO
     * @param {string} name
     */
    setIOName(IO, name) {
        try {
            const id = this.oid2id(IO);
            if (id) {
                this.setState(`${id}`, `${name}`, true);
            }
        } catch (err) {
            this.errorHandler(err, 'setIOName');
        }
    }

    /**
     * set limiter status in database
     * @param {string} oid
     * @param {string | number} value
     */
    setLimitStatus(oid, value) {
        try {
            const channel = this.oid2id(oid);
            this.setState(`${channel}status`, Number(value)>0?true:false, true);
        } catch (err) {
            this.errorHandler(err, 'setLimitStatus');
        }
    }

    /**
     * get limiter status
     * @param {string} baseId
     * cmd WE[oid]AU
     */
    getLimitStatus(baseId) {
        try {
            const oid = this.id2oid(`${baseId}.status`);
            if (oid) {
                this.streamSend(`WE${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getLimitStatus');
        }
    }

    /**
     * send Limiter status to device
     * @param {string} baseId
     * @param {string | any} value
     * cmd WE[oid]*[0/1]AU
     */
    sendLimitStatus(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WE${oid}*${value ? '1' : '0'}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendLimitStatus');
        }
    }

    /**
     * set limiter threshold in database
     * @param {string} oid
     * @param {string | any} value
     */
    setLimitThreshold(oid, value) {
        try {
            const channel = this.oid2id(oid);
            this.setState(`${channel}threshold`, Number(0-value), true);
        } catch (err) {
            this.errorHandler(err, 'setLimitThreshold');
        }
    }

    /**
     * get limiter threshold from device
     * @param {string} baseId
     * cmd WT[oid]AU
     */
    getLimitThreshold(baseId) {
        try {
            const oid = this.id2oid(`${baseId}.status`);
            if (oid) {
                this.streamSend(`WT${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getLimitThreshold');
        }
    }

    /**
     * send new Limiter Threshold to device
     * @param {string} baseId
     * @param {string | any} value
     * cmd WT[oid]*[value]AU
     */
    sendLimitThreshold(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WT${oid}*${value}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendLimitThreshold');
        }
    }
    /** END Input and Mix control */

    /** BEGIN integrated audio player control */
    /*
     * Set the database values for a player
     * @param {string} oid
     * @param {string | boolean} value
     * cmd = PLAY (playmode)
     */
    setPlayMode(oid, value) {
        try {
            const player = this.oid2id(oid);
            this.setState(`${player}playmode`, value === '1'? true : false, true);
        } catch (err) {
            this.errorHandler(err, 'setPlayMode');
        }
    }

    /**
     * control playback on the device.player
     * @param {string} baseId
     * @param {string | any} value
     * cmd = [ply]*[1|0]PLAY
     */
    sendPlayMode(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`W${oid}*${(value?'1':'0')}PLAY\r`);
                if (!this.playerLoaded[Number(oid)-1]) this.log.warn(`sendPlayMode(): player ${oid} has no file assigned`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendPlayMode');
        }
    }

    /**
     * request playback mode from the device.player
     * @param {string}  baseId
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
     * @param {string} oid
     * @param {string | boolean} value
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
     * @param {string} baseId
     * @param {string | any} value
     * cmd=M[ply]*[0|1]CPLY
     */
    sendRepeatMode(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                this.streamSend(`WM${oid}*${(value?'1':'0')}CPLY\r`);
                if (!this.playerLoaded[Number(oid)-1]) this.log.error(`sendRepeatMode(): player ${oid} has no file assigned`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendRepeatMode');
        }
    }

    /**
     * request repeatmode on the device.player
     * @param {string} baseId
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
     * @param {string} baseId
     * @param {string} value
     * cmd = A[ply]*[filename]CPLY
     */
    sendFileName(baseId, value) {
        try {
            const oid = this.id2oid(baseId);
            if (oid) {
                const streamData = `WA${oid}*${(value === '' ? ' ' : value)}CPLY\r`;
                this.streamSend(streamData);
            }
        } catch (err) {
            this.errorHandler(err, 'sendFileName');
        }
    }

    /**
     * Send clear Player filename to device
     * @param {string} baseId
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
     * @param {string} oid
     * @param {string} value
     * cmd = CPLYA (associate file to player)
     */
    setFileName(oid, value) {
        try {
            const player = this.oid2id(oid);
            this.setState(`${player}filename`, value, true);
            this.playerLoaded[Number(oid)-1] = (value != '' ? true : false);
        } catch (err) {
            this.errorHandler(err, 'setFileName');
        }
    }

    /**
     * request current filename from player
     * @param {string} baseId
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
    /** called to load a file into device user flash memory
     * @param {string} filePath
     */
    loadUserFile(filePath) {
        let chunk ='';
        try {
            fs.accessSync(filePath);                            // check if given path is accessible
            const fileName = path.basename(filePath);           // extract filename
            //const fileExt = path.extname(filePath);
            const fileStats = fs.statSync(filePath);            // load file statistics
            const fileStream = fs.createReadStream(filePath);   // open a stream
            fileStream.setEncoding('binary');                   // switch stream to binary mode
            const fileTimeStamp = fileStats.mtime.toJSON();
            const year = fileTimeStamp.slice(0,4);
            const month = fileTimeStamp.slice(5,7);
            const day = fileTimeStamp.slice(8,10);
            const hour = fileTimeStamp.slice(11,13);
            const minute = fileTimeStamp.slice(14,16);
            const second = fileTimeStamp.slice(17,19);
            const streamData = `W+UF${fileStats.size}*5 ${month} ${day} ${year} ${hour} ${minute} ${second},${fileName}\r`;
            //const streamData = `W+UF${fileStats.size},${fileName}\r`;
            this.streamSend(streamData);                        // issue upload command to device
            fileStream.on('readable', function() {              // start file transmission
                while ((chunk=fileStream.read()) != null) {
                    if (!this.fileSend) {
                        // @ts-ignore
                        this.log.debug('Extron loadUserFile started');
                        this.fileSend = true;
                    }
                    // @ts-ignore
                    this.streamSend(chunk);
                }
            });
            fileStream.on('end', function() {                   // on transmission end
                this.fileSend = false;
                // @ts-ignore
                this.log.debug('Extron loadUserFile completed');
            });
        } catch (err) {
            this.errorHandler(err, 'loadUserFile');
        }
    }

    /**
     * delete the user file from device
     * @param {string} value
     */
    eraseUserFile(value) {
        try {
            const streamData = `W${(value === '' ? ' ' : value)}EF\r`;
            this.streamSend(streamData);
        } catch (err) {
            this.errorHandler(err, 'eraseUserFile');
        }
    }

    /** called to list current files in device user flash memory
     *
     */
    listUserFiles() {
        try {
            this.streamSend(`WDF\r`);
            if (this.config.type === 'telnet') this.requestDir = true;
        } catch (err) {
            this.requestDir = false;
            this.errorHandler(err, 'listUserFiles');
        }
    }

    /** called to set current files from device user flash memory in database
     * @param {Array} userFileList
     */
    async setUserFilesAsync(userFileList) {
        try {
            let i = 0;
            userFileList.sort();    // sort list alphabetically to resemble DSP configurator display
            this.setObjectNotExistsAsync(this.objectsTemplate.userflash.file._id, this.objectsTemplate.userflash.file);
            for (const userFile of userFileList) {                              // check each line
                this.log.debug(`freespace: ${this.fileList.freespace}`)
                //if (this.fileList.freeSpace) continue;                          // skip remaining lines if last entry already found
                // @ts-ignore
                //this.fileList.freeSpace = userFile.match(/(\d+\b Bytes Left)/g)?`${userFile.match(/(\d+\b Bytes Left)/g)[0]}`:'';     //check for last line containing remaining free space
                if (userFile.match(/(\d+\b Bytes Left)/g)) this.fileList.freeSpace = userFile.match(/(\d+\b Bytes Left)/g)[0];
                //if (this.fileList.freeSpace) continue;                          // skip remaining lines if last entry already found
                // @ts-ignore
                this.file.fileName = userFile.match(/^(.+\.\w{3}\b)/g)?`${userFile.match(/^(.+\.\w{3}\b)/g)[0]}`:'';    // extract filename
                // @ts-ignore
                this.file.timeStamp = userFile.match(/(\w{3}, \d\d \w* \d* \W*\d\d:\d\d:\d\d)/g)?`${userFile.match(/(\w{3}, \d\d \w* \d* \W*\d\d:\d\d:\d\d)/g)[0]}`:''; //extract timestamp
                // @ts-ignore
                this.file.fileSize = userFile.match(/(\d+)$/g)?`${userFile.match(/(\d+)$/g)[0]}`:''; // extract filesize
                if (this.file.fileName.match(/.raw$/)) {        // check if AudioFile
                    i++;
                    this.fileList.files[i] = this.file;                             // add to filelist array
                    await this.setObjectAsync(`fs.files.${i}`, this.objectsTemplate.userflash.files.channel);
                    await this.setObjectAsync(`fs.files.${i}.filename`, this.objectsTemplate.userflash.files.filename);
                    this.setState(`fs.files.${i}.filename`, this.file.fileName, true);
                    this.log.debug(`Object "fs.files.${i}.filename ${this.file.fileName}" updated`);
                }
            }
            this.setState(`fs.filecount`, i, true);
            this.setState('fs.freespace',this.fileList.freeSpace,true);
            this.setState('fs.dir',false,true);
            this.log.debug(`Extron userFlash filelist updated: ${userFileList.join('; ')}`);
        } catch (err) {
            this.requestDir = false;
            this.errorHandler(err, 'setUserFiles');
        }
    }
    /** END user flash memory file management */

    /** BEGIN group control */

    /**
     * queue group commands during deleteion pending
     * @param {number} group
     * @param {string} cmd
     */
    queueGrpCmd(group, cmd) {
        this.log.info(`queueGrpCmd(): pushing "${cmd}" to group #${group} buffer`);
        this.grpCmdBuf[group].push(cmd); // push command to buffer
    }


    /**
     * send group command buffer
     * @param {number} group
     */
    sendGrpCmdBuf(group) {
        this.log.info(`sendGrpCmdBuf: processing ${this.grpCmdBuf[group].length} queued commands on group "${group}"`);
        while (this.grpCmdBuf[group].length > 0) {
            this.streamSend(this.grpCmdBuf[group].shift());
        }
    }


    /**
     * get all member OID's of a given group from device
     * @param {number} group
     * cmd = O[group]GRPM
     */
    getGroupMembers(group) {
        const cmd = `WO${group}GRPM\r`;
        if (this.grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd); // send comman
            }
            catch (err) {
                this.errorHandler(err, 'getGroupMembers');
            }
        } else {
            this.queueGrpCmd(group,cmd); // push command to buffer
        }
    }

    /** add member OID to group on device
     * @param {number} group
     * @param {string} baseId
     * cmd = O[group]*[oid]GRPM
    */
    sendGroupMember(group, baseId) {
        const oid = this.id2oid(baseId);
        const cmd = `WO${group}*${oid}GRPM\r`;
        if (oid) {
            if (this.grpDelPnd[group] == false) {
                try {
                    this.streamSend(cmd); // send comman
                }
                catch (err) {
                    this.errorHandler(err, 'sendGroupMember');
                }
            } else {
                this.queueGrpCmd(group,cmd); // push command to buffer
            }
        }
        
    }

    /** store group members in database
     * @param {number} group
     * @param {array} members
     */
    setGroupMembers(group, members) {
        var stateMembers = [];
        try {
            //if ((members === undefined) || (members.length === 0)) {
            if (members === undefined) {
                this.log.debug(`setGroupMembers(): no member for group ${group}`);
            } else {
                this.log.debug(`setGroupMembers(): group #${group} curMembers: "${this.groupMembers[group]}"`);
                if (members.length == 1) { // add single member to group
                    if(this.groupMembers[group].includes(members[0])) {
                        this.log.debug(`setGroupMembers(): OID "${members[0]}" already included with group ${group}`);
                    } else {
                        if (members[0] != '') {
                            this.groupMembers[group].push(members[0]);
                            this.log.info(`setGroupMembers(): added OID "${members[0]}" to group ${group} now holding "${this.groupMembers[group]}"`);
                        } else {
                            this.groupMembers[group] = [];
                            this.log.info(`setGroupMembers(): deleted members of group "${group}"`);        
                        }
                    }
                } else {    // replace list of members
                    this.groupMembers[group] = [];
                    for (let member of members) this.groupMembers[group].push(member);
                }
                for (let member of this.groupMembers[group]) stateMembers.push(this.oid2id(member));
                this.setState(`groups.${group.toString().padStart(2,'0')}.members`, this.groupMembers[group].length == 0?'':`${stateMembers}`, true);
                this.setState(`groups.${group.toString().padStart(2,'0')}.deleted`, this.groupMembers[group].length == 0?true:false, true);
                this.log.info(`setGroupMembers(): group ${group} now has members:"${this.groupMembers[group]}"`);
            }
        } catch (err) {
            this.errorHandler(err, 'setGroupMembers');
        }
    }

    /** clear group on device
     * @param {number} group
     * cmd = Z[group]GRPM
     */
    sendDeleteGroup(group) {
        const cmd = `WZ${group}GRPM\r`;
        try {
            if (this.grpDelPnd[group] == false) {
                this.streamSend(cmd);
                this.grpDelPnd[group] = true;   // flag group deletion command has been sent
                this.grpCmdBuf[group] = []; // clear command buffer for the group
            } else this.grpCmdBuf[group].push(cmd);
        }
        catch (err) {
            this.errorHandler(err, 'deleteGroup');
        }
    }

    /** get group fader level from device
     * @param {number} group
     * cmd = D[group]GRPM
     */
    getGroupLevel(group) {
        const cmd = `WD${group}GRPM\r`;
        if (this.grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd); // send command
            }
            catch (err) {
                this.errorHandler(err, 'getGroupLevel');
            }
        } else {
            this.queueGrpCmd(group,cmd); // push command to buffer
        }
    }

    /** send group fader level to device
     * @param {number} group
     * @param {number} level
     * cmd = D[group]*[level]GRPM
     */
    sendGroupLevel(group, level) {
        var cmd = '';
        switch (this.groupTypes[group]) {
            case 6: // gain group
                cmd = `WD${group}*${this.calculateFaderValue(level, 'lin').devValue}GRPM\r`;
                break;
            case 12:    // mute group
                cmd = `WD${group}*${level}GRPM\r`;
                break;
            default:
                this.log.error(`sendGroupLevel() groupType "${this.groupTypes[group]}" for group "${group}" not supported`);
        }
        if (this.grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd); // send command
            }
            catch (err) {
                this.errorHandler(err, 'sendGroupLevel');
            }
        } else {
            this.queueGrpCmd(group,cmd); // push command to buffer
        }
    }

    /** store group level in database
     * @param {number} group
     * @param {number} level
     */
    setGroupLevel(group, level) {
        try {
            switch (this.groupTypes[group]) {
                case 6 :           // gain group
                    this.setState(`groups.${group.toString().padStart(2,'0')}.level_db`, Number(this.calculateFaderValue(level, 'dev').logValue), true);
                    this.setState(`groups.${group.toString().padStart(2,'0')}.level`, Number(this.calculateFaderValue(level, 'dev').linValue), true);
                    break;

                case 12 :    // mute group
                    this.setState(`groups.${group.toString().padStart(2,'0')}.level_db`, level?1:0, true);
                    this.setState(`groups.${group.toString().padStart(2,'0')}.level`, level?1:0, true);
                    break;
                default:
                    this.log.error(`setGroupLevel() groupType ${this.groupTypes[group]} on group "${group}"not supported`);

            }
        } catch (err) {
            this.errorHandler(err, 'setGroupLevel');
        }
    }

    /** get group type from device
     * @param {number} group
     * cmd = P[group]GRPM
     */
    getGroupType(group) {
        const cmd = `WP${group}GRPM\r`;
        if (this.grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd); // send command
            }
            catch (err) {
                this.errorHandler(err, 'sendGroupLevel');
            }
        } else {
            this.queueGrpCmd(group,cmd); // push command to buffer
        }
    }

    /** send group type to device
     * @param {number} group
     * @param {number} type
     * cmd = P[group]*[type]GRPM
     */
    sendGroupType(group, type) {
        const cmd = `WP${group}*${type}GRPM\r`;
        if (this.grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd); // send command
            }
            catch (err) {
                this.errorHandler(err, 'sendGroupType');
            }
        } else {
            this.queueGrpCmd(group,cmd); // push command to buffer
        }
    }

    /** store group type in database
     * @param {number} group
     * @param {number} type
     */
    setGroupType(group, type) {
        this.groupTypes[Number(group)] = Number(type);
        try {
            this.setState(`groups.${group.toString().padStart(2,'0')}.type`, type, true);
        } catch (err) {
            this.errorHandler(err, 'setGroupType');
        }
    }

    /** get group level limits from device
     * @param {number} group
     * cmd = L[group]GRPM
     */
    getGroupLimits(group) {
        const cmd = `WL${group}GRPM\r`;
        if (this.grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd); // send command
            }
            catch (err) {
                this.errorHandler(err, 'getGroupLimits');
            }
        } else {
            this.queueGrpCmd(group,cmd); // push command to buffer
        }
    }

    /** send group limits to device
     * @param {number} group
     * @param {number} upper
     * @param {number} lower
     * cmd = L[group]*[upper]*[lower]GRPM
    */
    sendGroupLimits(group, upper, lower) {
        const cmd = `WL${group}*${upper}*${lower}GRPM\r`;
        if (this.grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd); // send command
            }
            catch (err) {
                this.errorHandler(err, 'sendGroupLimits');
            }
        } else {
            this.queueGrpCmd(group,cmd); // push command to buffer
        }
    }

    /** store group limits in database
     * @param {number} group
     * @param {number} upper
     * @param {number} lower
     */
    setGroupLimits(group, upper, lower) {
        try {
            this.setState(`groups.${group.toString().padStart(2,'0')}.upperLimit`, upper, true);
            this.setState(`groups.${group.toString().padStart(2,'0')}.lowerLimit`, lower, true);
        } catch (err) {
            this.errorHandler(err, 'setGroupLimits');
        }
    }

    /** get group name from device
     * @param {number} group
     * cmd = N[group]GRPM
     */
    getGroupName(group) {
        const cmd = `WN${group}GRPM\r`;
        if (this.grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd); // send command
            }
            catch (err) {
                this.errorHandler(err, 'getGroupName');
            }
        } else {
            this.queueGrpCmd(group,cmd); // push command to buffer
        }
    }

    /** send group name to device
     * @param {number} group
     * @param {string} name
     * cmd = N[group]*[name]GRPM
     */
    sendGroupName(group, name) {
        const cmd = `WN${group}*${name}GRPM\r`;
        if (this.grpDelPnd[group] == false) {
            try {
                this.streamSend(cmd); // send command
            }
            catch (err) {
                this.errorHandler(err, 'sendGroupName');
            }
        } else {
            this.queueGrpCmd(group,cmd); // push command to buffer
        }
    }

    /** store group name in database
     * @param {number} group
     * @param {string} name
    */
    setGroupName(group, name) {
        try {
            this.setState(`groups.${group.toString().padStart(2,'0')}.name`, name, true);
        } catch (err) {
            this.errorHandler(err, 'setGroupName');
        }
    }
    /** END group control*/

    /** BEGIN cp82 Video control */
    /**
     * Set the database values for the tie state of an output
     * @param {string} cmd
     * @param {string} value
     * cmd = Inx, x=1..8; value=[1,2] All if not All set for all and log a warning
     */
    setTie(cmd, value) {
        try {
            const input = cmd.slice(2,3);
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
     * @param {string} baseId
     * @param {string | any} value
     */
    sendTieCommand(baseId, value) {
        try {
            const idArray = baseId.split('.');
            if (idArray[2] === 'connections') {         // video.output
                if (Number(idArray[3]) <= 2) {
                    this.streamSend(`${value}*${idArray[3]}!\r`);   // tie input 'value' to output 'idArray[3]'
                } else {
                    if (value > 0) this.streamSend(`W${value}LOUT\r`);  // set loop out input to 'value'
                    else this.streamSend(`${value}*${idArray[3]}!\r`);  // untie loopOut
                }
            }
        } catch (err) {
            this.errorHandler(err, 'sendTieCommand');
        }
    }

    /**
     * Send Video mute command to the device
     * @param {string} baseId
     * @param {string | any} value
     */
    sendVideoMute(baseId, value) {
        try {
            const idArray = baseId.split('.');
            if (idArray[2] === 'connections') {         // video.output
                if (this.devices[this.config.device].short === 'sme211') this.streamSend(`${value}B\r`);
                else this.streamSend(`${idArray[3]}*${value}B\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendVideoMute');
        }
    }

    /**
     * get Video mute status from device
     * @param {string} baseId
     */
    getVideoMute(baseId) {
        try {
            const idArray = baseId.split('.');
            if (idArray[2] === 'connections') {         // video.output
                if (this.devices[this.config.device].short === 'sme211') this.streamSend(`B\r`);
                else this.streamSend(`${idArray[3]}*B\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getVideoMute');
        }
    }


    /** END CP82 Video control */

    /** BEGIN SMD202 Video Player control */
    /** get playback state
     * cmd = Y1PLYR
     */
    getPlayVideo() {
        try {
            this.streamSend('WY1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'getPlayVideo');
        }
    }

    /** set playback state in database
     * @param {string} id
     * @param {string | number} channel
     * @param {number} mode
     */
    setPlayVideo(id, channel, mode) {
        try {
            this.setState(`${id}playmode`, mode, true);
        } catch (err) {
            this.errorHandler(err, 'setPlayVideo');
        }
    }
    /** send start payback command
     * cmd = WS1*1PLYR
     */
    sendPlayVideo() {
        try {
            this.streamSend('WS1*1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'sendPlayVideo');
        }
    }

    /** send pause payback command
     * cmd = E1PLYR
     */
    sendPauseVideo() {
        try {
            this.streamSend('WE1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'sendPauseVideo');
        }
    }

    /** send stop playback command
     * cmd = O1PLYR
     */
    sendStopVideo() {
        try {
            this.streamSend('WO1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'sendStopVideo');
        }
    }

    /** get loop payback mode
     * cmd = R1*[mode]PLYR
     */
    getLoopVideo() {
        try {
            this.streamSend('WR1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'getLoopVideo');
        }
    }

    /** set loop payback mode
     * @param {string} id
     * @param {string | number} channel
     * @param {boolean | string} mode
     */
    setLoopVideo(id, channel, mode) {
        try {
            this.setState(`${id}loopmode`, Number(mode)?true:false, true);
        } catch (err) {
            this.errorHandler(err, 'setLoopVideo');
        }
    }
    /** send loop payback command
     * @param {string} id
     * @param {boolean} mode
     * cmd = R1*[mode]PLYR
     */
    sendLoopVideo(id, mode) {
        try {
            this.streamSend(`WR1*${mode?1:0}PLYR\r`);
        } catch (err) {
            this.errorHandler(err, 'sendLoopVideo');
        }
    }

    /** send path and fileneame
     * @param {string} id
     * @param {string} path
     * cmd = U1*[path]
     */
    sendVideoFile(id, path) {
        try {
            this.streamSend(`WU${this.id2oid(id)}*${path}PLYR\r`);
        } catch (err) {
            this.errorHandler(err, 'sendVideoFile');
        }
    }

    /** get path and fileneame
     * cmd = U1PLYR
     */
    getVideoFile() {
        try {
            this.streamSend('WU1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'getVideoFile');
        }
    }

    /** Set the Player filename in the database
     * @param {string} id
     * @param {string} path
     */
    setVideoFile(id, path) {
        try {
            this.setState(`${id}filepath`, path, true);
            this.playerLoaded[0] = (path != '' ? true : false);
        } catch (err) {
            this.errorHandler(err, 'setVideoFile');
        }
    }

    /** get current preset channel
     * cmd = WT1TVPR
     */
    getChannel() {
        try {
            this.streamSend('WT1TVPR\r');
        } catch (err) {
            this.errorHandler(err, 'getChannel');
        }
    }

    /** set current channel in database
     * @param {string} id
     * @param {string | number} channel
     */
    setChannel(id, channel) {
        try {
            this.setState(`${id}channel`, Number(channel), true);
        } catch (err) {
            this.errorHandler(err, 'setChannel');
        }
    }

    /** send channel change to device
     * @param {string|number} channel
     */
    sendChannel(channel){
        try {
            this.streamSend(`WT1*${channel}TVPR\r`);
        } catch (err) {
            this.errorHandler(err, 'sendChannel');
        }
    }
    /** get output mute status
     * cmd = Z
     */
    getMute() {
        try {
            this.streamSend('Z');
        } catch (err) {
            this.errorHandler(err, 'getMute');
        }
    }

    /** set output mute status in database
     * @param {string} id
     * @param {number | boolean} mute
     */
    setMute(id, mute) {
        try {
            this.setState(`${id}mute`, mute?true:false, true);
        } catch (err) {
            this.errorHandler(err, 'setMute');
        }
    }

    /** send mute to device
     * @param {boolean | number} mute
     */
    sendMute(mute){
        try {
            this.streamSend(`${mute?1:0}Z`);
        } catch (err) {
            this.errorHandler(err, 'sendMute');
        }
    }
    /** get output volume level
     * cmd = V
    */
    getVol(){
        try {
            this.streamSend('V');
        } catch (err) {
            this.errorHandler(err, 'getVol');
        }
    }
    /** set output volume level in datase
     * @param {string} id
     * @param {string | any} volume
     */
    setVol(id, volume){
        try {
            this.setState(`${id}level_db`, Number(Number(volume.logValue).toFixed(0)), true);
            this.setState(`${id}level`, Number(volume.linValue), true);
        } catch (err) {
            this.errorHandler(err, 'setVol');
        }
    }
    /** set output volume on device
     * @param {string | any} volume
     */
    sendVol(volume){
        try {
            this.streamSend(`${Number(volume.logValue).toFixed(0)}V`);
        } catch (err) {
            this.errorHandler(err, 'sendVol');
        }
    }
    /** END SMD 2020 Video Player Control */

    /** BEGIN SME211 stream control */
    /** send streaming mode to device
     * @param {number} mode
     *  cmd = Y[mode]STRM
    */
    sendStreamMode(mode) {
        try {
            this.streamSend(`WY${mode}STRM\r`);
        } catch (err) {
            this.errorHandler(err, 'sendStreamMode');
        }
    }

    /** set streammode state in database
     * @param {string} id
     * @param {number} mode
     */
    setStreamMode(id, mode) {
        try {
            this.setState(`${id}streammode`, mode, true);
        } catch (err) {
            this.errorHandler(err, 'setStreamMode');
        }
    }

    /** get streammode from device
     *  cmd = YSTRM
     */
    getStreamMode() {
        try {
            this.streamSend('WYSTRM\r');
        } catch (err) {
            this.errorHandler(err, 'getStreamMode');
        }
    }
    /** END SME 211 stream control */

    /**
     * determine the database id from oid e.g. 20002 -> in.inputs.01.mixPoints.O03
     * @param {string} oid
     * returns: String with complete base id to mixPoint or the gainBlock
     */
    oid2id(oid) {
        let retId = '';
        try {
            if (oid.length < 2) {
                retId = `ply.players.${oid}.common.`;
            } else if (oid.length < 3) {
                retId = `groups.${oid}.`;
            }
            else {
                const whatstr = oid.slice(0,1);
                const what = Number(whatstr);
                const where = Number(oid.slice(1,3));
                const val = Number(oid.slice(3,7));
                if (whatstr === 'N') {
                    switch (oid.slice(1,3)) {
                        case 'MI' :
                            if (val < 13) retId = `in.inputs.${val.toString().padStart(2,'0')}.name`;
                            if (val > 12) retId = `in.auxInputs.${(val-12).toString().padStart(2,'0')}.name`;
                            break;
                        case 'ML' :
                            retId = `in.virtualReturns.${val.toString().padStart(2,'0')}.name`;
                            break;
                        case 'EI' :
                            retId = `in.expansionInputs.${val.toString().padStart(2,'0')}.name`;
                            break;
                        case 'MO' :
                            if (val < 9) retId = `out.outputs.${val.toString().padStart(2,'0')}.name`;
                            if (val > 8) retId = `out.auxOutputs.${(val-8).toString().padStart(2,'0')}.name`;
                            break;
                        case 'EX' :
                            retId = `out.expansionOutputs.${val.toString().padStart(2,'0')}.name`;
                            break;
                    }
                } else if (`${oid.slice(0,5)}` === 'EXPDA') retId = `in.expansionInputs.${oid.slice(5).padStart(2,'0')}.name`;
                else
                    switch (what) {
                        case 2:                         // mixpoints
                            if (this.devices[this.config.device].short === 'cp82') {    // mixpoints on CP82
                                if ( where < 2) {
                                    retId = `in.programInputs.${(where +1).toString().padStart(2,'0')}.mixPoints.`;
                                } else if (where < 4) {
                                    retId = `in.inputs.${(where -1).toString().padStart(2,'0')}.mixPoints.`;
                                } else if (where < 6) {
                                    retId = `in.lineInputs.${(where -3).toString().padStart(2,'0')}.mixPoints.`;
                                } else if (where < 8) {
                                    retId = `in.playerInputs.${(where -5).toString().padStart(2,'0')}.mixPoints.`;
                                }
                            } else                      // mixpoints on dmp128
                            if (where <= 11) {          // from input 1 - 12
                                retId = `in.inputs.${(where + 1).toString().padStart(2,'0')}.mixPoints.`;
                            } else if (where <= 19) {   // aux input 1 - 8
                                retId = `in.auxInputs.${(where - 11).toString().padStart(2,'0')}.mixPoints.`;
                            } else if (where <= 35) {   // virtual return 1 - 16 (A-P)
                                retId = `in.virtualReturns.${(where - 19).toString().padStart(2,'0')}.mixPoints.`;
                            } else if (where <= 83) {   // AT input 1 - 48
                                retId = `in.expansionInputs.${(where - 35).toString().padStart(2,'0')}.mixPoints.`;
                            } else {
                                throw { 'message': 'no known mixpoint input',
                                    'stack'  : `oid: ${oid}` };
                            }
                            // now determine the output
                            if (this.devices[this.config.device].short === 'cp82') {    // mixpoints on CP82
                                retId += `O${(val -1).toString().padStart(2,'0')}.`; // on CP82 mixpooint output OID count starts at 2
                            } else                      // mixpoints on dmp128
                            if (val <= 7) {             // output 1 -8
                                retId += `O${(val + 1).toString().padStart(2,'0')}.`;
                            } else if (val <= 15) {     // aux output 1 - 8
                                retId += `A${(val - 7).toString().padStart(2,'0')}.`;
                            } else if (val <= 31) {     // virtual send bus 1 - 16
                                retId += `V${(val - 15).toString().padStart(2,'0')}.`;
                            } else if (val <= 47) {     // expansion output 1 - 16
                                retId += `E${(val - 31).toString().padStart(2,'0')}.`;
                            } else {
                                throw { 'message': 'no known mixpoint output',
                                    'stack'  : `oid: ${oid}` };
                            }
                            break;

                        case 3:                         // VideoLine inputs on CP82
                            if (where === 0) {          // Input Gain Control
                                return `in.videoInputs.${(val + 1).toString().padStart(2,'0')}.premix.`;
                            }
                            break;

                        case 4:                         // input block
                            if (where === 0) {          // Input gain block
                                if (this.devices[this.config.device].short === 'cp82'){ // Inputs on CP82
                                    if ( val < 2) {
                                        return `in.inputs.${(val +1).toString().padStart(2,'0')}.gain.`;
                                    } else if (val < 4) {
                                        return `in.lineInputs.${(val -1).toString().padStart(2,'0')}.gain.`;
                                    } else if (val < 6) {
                                        return `in.playerInputs.${(val -3).toString().padStart(2,'0')}.gain.`;
                                    }
                                } else if (val <= 11) {        // input 1 - 12
                                    return `in.inputs.${(val + 1).toString().padStart(2,'0')}.gain.`;
                                }
                                if (val <= 19) {        // aux input 1 - 8
                                    return `in.auxInputs.${(val - 11).toString().padStart(2,'0')}.gain.`;
                                }
                            } else if (where === 1) {   // premix gain block
                                if (this.devices[this.config.device].short === 'cp82'){ // Inputs on CP82
                                    if ( val < 2) {
                                        return `in.inputs.${(val +1).toString().padStart(2,'0')}.premix.`;
                                    } else if (val < 4) {
                                        return `in.lineInputs.${(val -1).toString().padStart(2,'0')}.premix.`;
                                    } else if (val < 6) {
                                        return `in.playerInputs.${(val -3).toString().padStart(2,'0')}.premix.`;
                                    }
                                } else if (val <= 11) {        // input 1 - 12
                                    return `in.inputs.${(val + 1).toString().padStart(2,'0')}.premix.`;
                                } else if (val <= 19) {        // aux input 1 - 8
                                    return `in.auxInputs.${(val - 11).toString().padStart(2,'0')}.premix.`;
                                }
                            }
                            throw { 'message': 'no known input',
                                'stack'  : `oid: ${oid}` };

                        case 5:                         // virtual return or ext input or program
                            if (where === 0) {           // program inputs on CP82
                                return `in.programInputs.${(val +1).toString().padStart(2,'0')}.premix.`;
                            }
                            if (where === 1) {          // virtual returns
                                if (val <= 15) {        // virtual return 1 - 16 (A-P)
                                    return `in.virtualReturns.${(val + 1).toString().padStart(2,'0')}.premix.`;
                                }
                            }
                            if (where === 2) {          // expansion bus (AT inputs)
                                if (val <= 47) {        // AT input 1 - 48
                                    return `in.expansionInputs.${(val + 1).toString().padStart(2,'0')}.premix.`;
                                }
                            }
                            throw { 'message': 'no known input',
                                'stack'  : `oid: ${oid}` };

                        case 6:                         // Output section
                            if (where === 0) {          // Output attenuation block
                                if (this.devices[this.config.device].short === 'cp82') {    // outputs on CP82
                                    return `out.outputs.${(val -1).toString().padStart(2,'0')}.attenuation.`; // ouput OID starts at 2 on CP82
                                }
                                if (val <= 7) {         // output 1 - 8
                                    return `out.outputs.${(val + 1).toString().padStart(2,'0')}.attenuation.`;
                                }
                                if (val <= 15) {        // aux output 1 - 8
                                    return `out.auxOutputs.${(val - 7).toString().padStart(2,'0')}.attenuation.`;
                                }
                                if (val <= 31) {        // expansion output 1-16
                                    return `out.expansionOutputs.${(val - 15).toString().padStart(2,'0')}.attenuation.`;
                                }
                            }
                            if (where === 1) {          // postmix trim block
                                if (val <= 7) {         // output 1 - 8
                                    return `out.outputs.${(val + 1).toString().padStart(2,'0')}.postmix.`;
                                }
                                if (val <= 15) {        // aux output 1 - 8
                                    return `out.auxOutputs.${(val - 7).toString().padStart(2,'0')}.postmix.`;
                                }
                                if (val <= 31) {        // expansion output 1-16
                                    return `out.expansionOutputs.${(val - 15).toString().padStart(2,'0')}.postmix.`;
                                }
                            }
                            if (where === 40) {          // limiter block
                                if (val <= 7) {         // output 1 - 8
                                    return `out.outputs.${(val + 1).toString().padStart(2,'0')}.limiter.`;
                                }
                                if (val <= 15) {        // aux output 1 - 8
                                    return `out.auxOutputs.${(val - 7).toString().padStart(2,'0')}.limiter.`;
                                }
                                if (val <= 31) {        // expansion output 1-16
                                    return `out.expansionOutputs.${(val - 15).toString().padStart(2,'0')}.limiter.`;
                                }
                            }
                            throw { 'message': 'no known output', 'stack'  : `oid: ${oid}` };

                        default:
                            throw { 'message': 'unknown OID', 'stack'  : `oid: ${oid}` };
                    }
            }
        } catch (err) {
            this.errorHandler(err, 'oid2id');
            return '';
        }
        return retId;
    }

    /**
     * determine the oid from the database id e.g. in.inputs.01.mixPoints.O03 -> 20002
     * @param {string} id
     * returns: String with complete base id to mixPoint or the gainBlock
     */
    id2oid(id) {
        let retOid = '';
        try {
            const idArray = id.split('.');
            const idType = idArray[3];
            const idNumber = Number(idArray[4]);
            const idBlock = idArray[5];
            let outputType = 'O';
            let outputNumber = 1;
            if (idArray.length >= 7) {
                outputType = idArray[6].slice(0,1);
                outputNumber = Number(idArray[6].slice(1,3));
            }
            if (idType === 'players') {
                retOid = `${idNumber}`;
            }
            else if (idArray[2] === 'groups') {
                retOid = `${idArray[3]}`;
            }
            else
            {
                if (idBlock != 'mixPoints') {     // inputs / outputs
                    switch (idType) {
                        case 'videoInputs':
                            retOid = `300${(idNumber - 1).toString().padStart(2,'0')}`;          // video line inputs on CP82
                            break;

                        case 'inputs':
                            if (idBlock === 'gain') {
                                retOid = `400${(idNumber - 1).toString().padStart(2,'0')}`;
                            } else {
                                retOid = `401${(idNumber - 1).toString().padStart(2,'0')}`;
                            }
                            break;

                        case 'programInputs' :
                            retOid = `500${(idNumber - 1).toString().padStart(2,'0')}`;             // program inputs on CP82
                            break;

                        case 'lineInputs' :
                            if (idBlock === 'gain') {
                                retOid = `400${(idNumber +1).toString().padStart(2,'0')}`;         // Line Inputs on CP82
                            } else {
                                retOid = `401${(idNumber +1).toString().padStart(2,'0')}`;
                            }
                            break;

                        case 'playerInputs' :
                            if (idBlock === 'gain') {
                                retOid = `400${(idNumber +3).toString().padStart(2,'0')}`;         // player inputs on CP82
                            } else {
                                retOid = `401${(idNumber +3).toString().padStart(2,'0')}`;
                            }
                            break;

                        case 'auxInputs':
                            if (idBlock === 'gain') {
                                retOid = `400${(idNumber + 11).toString().padStart(2,'0')}`;
                            } else {
                                retOid = `401${(idNumber + 11).toString().padStart(2,'0')}`;
                            }
                            break;

                        case 'virtualReturns':
                            retOid = `501${(idNumber - 1).toString().padStart(2,'0')}`;
                            break;

                        case 'expansionInputs':
                            retOid = `502${(idNumber - 1).toString().padStart(2,'0')}`;
                            break;

                        case 'outputs' :
                            switch (idBlock) {
                                case 'attenuation' :
                                    retOid = `600${(idNumber - 1).toString().padStart(2,'0')}`;
                                    if (this.devices[this.config.device].short === 'cp82') retOid = `600${(idNumber +1).toString().padStart(2,'0')}`; // output OID count starts at 2 on CP82
                                    break;
                                case 'limiter' :
                                    retOid = `640${(idNumber - 1).toString().padStart(2,'0')}`;
                                    break;
                                default:
                                    retOid = `601${(idNumber - 1).toString().padStart(2,'0')}`;
                            }
                            break;

                        case 'auxOutputs' :
                            switch (idBlock) {
                                case 'attenuation' :
                                    retOid = `600${(idNumber + 7).toString().padStart(2,'0')}`;
                                    break;
                                case 'limiter' :
                                    retOid = `640${(idNumber + 7).toString().padStart(2,'0')}`;
                                    break;
                                default :
                                    retOid = `601${(idNumber + 7).toString().padStart(2,'0')}`;
                            }
                            break;

                        case 'expansionOutputs' :
                            switch (idBlock) {
                                case 'attenuation' :
                                    retOid = `600${(idNumber + 15).toString().padStart(2,'0')}`;
                                    break;
                                case 'limiter' :
                                    retOid = `640${(idNumber + 15).toString().padStart(2,'0')}`;
                                    break;
                                default:
                                    retOid = `601${(idNumber + 15).toString().padStart(2,'0')}`;
                            }
                            break;

                        default:
                            if (idBlock === 'name') retOid = idNumber.toString();
                            else retOid = '';
                    }
                }   else
                {                      // mixpoints
                    switch (idType) {
                        case 'inputs':
                            retOid = `2${(idNumber -1).toString().padStart(2,'0')}`;
                            if (this.devices[this.config.device].short === 'cp82') retOid = `2${(idNumber +1).toString().padStart(2,'0')}`; // Mic Inputs on CP82
                            break;

                        case 'programInputs' :
                            retOid = `2${(idNumber -1).toString().padStart(2,'0')}`;         // program inputs on CP82
                            break;

                        case 'playerInputs' :
                            retOid = `2${(idNumber +5).toString().padStart(2,'0')}`;         // FilePlayer Inouts on CP82
                            break;

                        case 'lineInputs' :
                            retOid = `2${(idNumber +3).toString().padStart(2,'0')}`;         // Line Inputs on CP82
                            break;

                        case 'auxInputs':
                            retOid = `2${(idNumber + 11).toString().padStart(2,'0')}`;
                            break;

                        case 'virtualReturns':
                            retOid = `2${(idNumber + 19).toString().padStart(2,'0')}`;
                            break;

                        case 'expansionInputs':
                            retOid = `2${(idNumber + 35).toString().padStart(2,'0')}`;
                            break;

                        default:
                            retOid = '';
                    }
                    switch (outputType) {
                        case 'O':
                            if (this.devices[this.config.device].short === 'cp82') {
                                retOid += (outputNumber +1).toString().padStart(2,'0');  // output OID count starts at 2 on CP82
                            } else {
                                retOid += (outputNumber - 1).toString().padStart(2,'0');
                            }
                            break;

                        case 'A':
                            retOid += (outputNumber + 7).toString().padStart(2,'0');
                            break;

                        case 'V':
                            retOid += (outputNumber + 15).toString().padStart(2,'0');
                            break;

                        case 'E':
                            retOid += (outputNumber + 31).toString().padStart(2,'0');
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
        return retOid;
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            clearTimeout(this.timers.intervallQueryStatus);

            // close client connection
            switch (this.config.type) {
                case 'ssh' :
                    this.log.debug('onUnload(): calling this.client.end()');
                    this.client.end();
                    break;
                case 'telnet' :
                    this.log.debug('onUnload(): calling this.net.destroy()');
                    this.net.destroy();
                    break;
            }
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        try {
            if (state) {
                // The state was changed
                // this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                if (!state.ack) {       // only react on not acknowledged state changes
                    if ((state.val === undefined) || (state.val === null)) state.val = '';
                    this.log.info(`onStateChange(): Extron state ${id} changed: ${state.val} (ack = ${state.ack})`);
                    const baseId = id.slice(0, id.lastIndexOf('.'));
                    const idArray = id.split('.');
                    const idType = idArray[3];
                    const idGrp = Number(idArray[3]);
                    const idBlock = idArray[5];
                    const stateName = id.slice(id.lastIndexOf('.') + 1);
                    const timeStamp = Date.now();
                    let stateTime = this.stateBuf[0];
                    let calcMode ='lin';
                    let elapsed = 0;
                    let member = '';
                    if (typeof(baseId) !== 'undefined' && baseId !== null) {
                        switch (stateName) {
                            case 'mute' :
                                if (this.devices[this.config.device].short === 'smd202') {
                                    this.sendMute(Number(state.val));
                                    break;
                                }
                                if (idArray[2] === 'connections') {
                                    this.sendVideoMute(id, state.val);
                                    break;
                                }
                                this.sendMuteStatus(id, state.val);
                                break;
                            case 'source' :
                                this.sendSource(id, `${state.val}`);
                                break;
                            case 'level' :
                                // @ts-ignore
                                stateTime = this.stateBuf.find(stateTime => stateTime.id === id);   // check if state has already been buffered
                                if (stateTime === undefined) {
                                    this.stateBuf.push({'id' : id, 'timestamp' : 0});               // push state to buffer array
                                    // @ts-ignore
                                    stateTime = this.stateBuf.find(stateTime => stateTime.id === id); // now it should be found
                                }
                                elapsed = timeStamp - stateTime.timestamp;  // calcualte elapsed milliseconds since last change
                                if ( elapsed > this.config.stateDelay || state.val <= 10) {    	// if configured stateDelay has been exceeded, process the change event
                                    switch (idBlock) {						// or if value is near 0
                                        case 'gain' :
                                            calcMode = 'linGain';
                                            if (idType === 'auxInputs') calcMode = 'linAux';
                                            if (this.devices[this.config.device].short === 'sme211') calcMode = 'linAux';
                                            break;

                                        case 'premix' :
                                            if (this.devices[this.config.device].short === 'cp82') calcMode = 'linAux';
                                            break;

                                        case 'postmix' :
                                            calcMode = 'linTrim';
                                            break;

                                        case 'attenuation' :
                                            calcMode = 'linAtt';
                                            break;
                                    }
                                    stateTime.timestamp = timeStamp;    // update stored timestamp
                                    if (this.devices[this.config.device].short === 'smd202') {
                                        this.sendVol(this.calculateFaderValue(`${state.val}`,'linAtt'));
                                    } else if (idArray[2] === 'groups') {
                                        this.sendGroupLevel(idGrp, Number(state.val));
                                    } else this.sendGainLevel(id,this.calculateFaderValue(`${state.val}`,calcMode));
                                }
                                else{
                                    this.log.debug(`onStateChange(): processing for ${id} = ${state.val} skipped due to statedelay`);
                                }
                                break;
                            case 'level_db' :
                                calcMode ='log';
                                switch (idBlock) {
                                    case 'gain' :
                                        calcMode = 'logGain';
                                        if (idType === 'auxInputs') calcMode = 'logAux';
                                        if (idType === 'lineInputs') calcMode = 'logAux';
                                        break;

                                    case 'premix' :
                                        if (this.devices[this.config.device].short === 'cp82') calcMode = 'logAux';
                                        break;

                                    case 'postmix' :
                                        calcMode = 'logTrim';
                                        break;

                                    case 'attenuation' :
                                        calcMode = 'logAtt';
                                        break;
                                } if (this.devices[this.config.device].short === 'smd202') {
                                    this.sendVol(this.calculateFaderValue(`${state.val}`,'logAtt'));
                                } else if (idArray[2] === 'groups') {
                                    this.sendGroupLevel(idGrp, Number(state.val));
                                } else this.sendGainLevel(id,this.calculateFaderValue(`${state.val}`,calcMode));
                                break;

                            case 'status' :
                                this.sendLimitStatus(id, state.val);
                                break;
                            case 'threshold':
                                this.sendLimitThreshold(id, Math.abs(Number((state.val < -800)?-800:(state.val>0)?0:state.val)));
                                break;

                            case 'playmode' :
                                if (this.devices[this.config.device].short === 'smd202') {
                                    switch (state.val) {
                                        case 0: this.sendStopVideo(); break;
                                        case 1: this.sendPlayVideo(); break;
                                        case 2: this.sendPauseVideo(); break;
                                    }
                                }
                                else this.sendPlayMode(id, state.val);
                                break;

                            case 'repeatmode' :
                                this.sendRepeatMode(id, state.val);
                                break;

                            case 'filename' :
                                if (this.checkName(`${state.val}`)) this.sendFileName(id, `${state.val}`);
                                else this.log.error('onStateChange(): filename includes invalid characters');
                                break;

                            case 'tie' :
                                this.sendTieCommand(baseId, state.val);
                                break;
                            case 'loopmode' :
                                this.sendLoopVideo(baseId, state.val?true:false);
                                break;
                            case 'filepath' :
                                this.sendVideoFile(baseId, `${state.val}`);
                                break;
                            case 'streammode' :
                                this.sendStreamMode(Number(state.val));
                                break;

                            case 'dir' :
                                this.listUserFiles();
                                break;

                            case 'upl' :
                                this.loadUserFile(`${state.val}`);
                                break;

                            case 'name' :
                                if (this.checkName(`${state.val}`)) {
                                    switch (idArray[2]) {
                                        case 'groups' :
                                            this.sendGroupName(idGrp, `${state.val}`);
                                            break;
                                        case 'in' :
                                        case 'out' :
                                            this.sendIOName(id,`${state.val}`);
                                            break;
                                    }
                                } else this.log.error('onStateChange(): state name includes invalid characters');
                                break;

                            case 'type' :
                                switch (Number(state.val)) {
                                    case 6:     // gain group
                                        this.sendGroupType(idGrp, Number(state.val));
                                        this.setGroupType(idGrp, Number(state.val));
                                        this.sendGroupLimits(idGrp, 120, -1000);
                                        break;
                                    case 12:    // mute group
                                        this.sendGroupType(idGrp, Number(state.val));
                                        this.setGroupType(idGrp, Number(state.val));
                                        this.sendGroupLimits(idGrp, 1, 0);
                                        break;
                                    default:
                                        this.log.error(`onStateChange(): groupType ${state.val} not supported`);
                                }
                                break;

                            case 'upperLimit' :
                            case 'lowerLimit' :
                                // this.sendGroupLimits(idGrp, Number(state.val), Number(state.val));
                                break;

                            case 'members' :
                                for (member of `${state.val}`.split(',')) {
                                    this.sendGroupMember(idGrp, `${member}`);
                                }
                                break;
                            case 'deleted' :
                                if (state.val == true) this.sendDeleteGroup(idGrp);
                                break;

                            case 'channel' :
                                this.sendChannel(Number(state.val));
                                break;
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
	 * @param {any} err
	 * @param {string} module
	 */
    errorHandler(err, module = '') {
        const errorStack = err.stack;
        //        if (err.stack) errorStack = err.stack.replace(/\n/g, '<br>');
        if (err.name === 'ResponseError') {     // gerade nicht benötigt, template ....
            if (err.message.includes('Permission denied') || err.message.includes('Keine Berechtigung')) {
                this.log.error(`Permisson denied. Check the permission rights of your user on your device!`);
            }
            this.log.error(`Extron error in method: [${module}] response error: ${err.message.replace(module, '')}, stack: ${errorStack}`);
        } else {
            if (module === 'onClientError') {
                if (err.level === 'client-socket') {
                    this.log.error(`Extron error in ssh client (sockel level): ${err.message}, stack: ${errorStack}`);
                } else if (err.level === 'client-ssh') {
                    this.log.error(`Extron error in ssh client (ssh): ${err.message}, stack: ${errorStack}, description: ${err.description}`);
                } else {
                    this.log.error(`Extron error in ssh client (unknown): ${err.message}, stack: ${errorStack}`);
                }
            } else {
                this.log.error(`Extron error in method: [${module}] error: ${err.message}, stack: ${errorStack}`);
            }
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.message" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }


}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */

    module.exports = (options) => {'use strict'; new Extron(options); };
} else {
    // otherwise start the instance directly
    new Extron();
}
